# @thetis/compaction

Automatic context compaction for Thetis. When the next request to the model nears its context window, the package summarizes the older part of the conversation into one note, keeps the most recent part verbatim, and sends the note and the tail instead of the whole history. The session's `conversation` is never edited: it is the record, and every other package keys on its indices (the harness's usage turns, the gateway's per-reply usage, the context ledger, the prompt-cache fingerprints). Compaction is a projection over it. The package keeps `{ cut, summary }` under `harness["@thetis/compaction"]` and builds `call.messages` from that on every call: the note stands for `conversation[0, cut)`, and `conversation[cut, ...)` follows exactly as it is. Nothing is deleted, a later compaction rewrites the one note rather than stacking another on it, and a reset from the dock sends the full history again.

## What it provides

One step, declared in `thetis.steps`:

| Step id | Phase | Export | What it does |
|---|---|---|---|
| `compact` | `call` | `compact` | Reads its state and a pending request from the dock, measures the next request, compacts when it is due, and always answers with `call.messages` set to the projection and, when `enabled`, `call.hints.beforeRound` set to `{ package: "@thetis/compaction", export: "beforeRound" }`. |

It is a `call`-phase step and not a `history` one because the summary request re-sends the same `system`, `tools`, hints and message prefix the conversation already sent, which the `prompt` and `tools` phases build after `history`. The provider then reads its cached prefix and the summary costs only the instructions and the answer. `@thetis/prompt-cache` runs in the same phase, before this one by install order, so its cache hint is on the summary request too.

The round hook, `beforeRound(args, env)`: `@thetis/harness-core` reads `call.hints.beforeRound` before every completion after the first of a turn and, when it names a package export, calls it with the loop's live conversation, call, harness, the previous round's usage and how many messages that round priced. This package measures the next request from those, runs the same decision as the step, and answers with new `call.messages` and `harness` when it compacted, nothing otherwise. harness-core knows no package by name; the hint is the seam. A hook that throws is logged and the round goes on, and this one never throws anyway.

Three UI commands, declared in `thetis.ui.commands` and used by the package's page (built separately, in `ui/`):

| Verb | Export | Answer |
|---|---|---|
| `compaction-state` | `uiState` | The state view of one conversation: the model, its window, the trigger, how much is used and whether that is an estimate, the compaction state, a pending request, and one server-computed `sentence` the dock leads with. |
| `compaction-request` | `uiRequest` | Writes `{ at, instructions? }` to `compaction/requests/<session>.json` under the person's home; the step consumes it at the start of the next message and compacts whatever the size, with the instructions appended to the summary prompt. A file rather than `env.storage()`: the dock's command runs under the gateway's environment and the step under this package's, and the two see different storage namespaces, while the home is one place. |
| `compaction-reset` | `uiReset` | Writes `{ at, reset: true }`; the next message sends the full history again. A reset replaces a pending request and vice versa. |

The page: a `context` chip in the shell (`ctx 14%`, amber from 60% of the window, red from the trigger, `compacting…` while one runs); a `Compaction` dock with the meter, the sentence, the two actions and the current summary and ledger; and a transcript card that shows a compaction as it happens and marks the cut when a saved conversation is redrawn.

## How the cut is chosen

A cut may fall on any index after 0 whose message is not a tool result, since a tool message belongs to the assistant message that asked for it. Among those past the previous cut, the package takes the latest one that still leaves at least `keepTokens` (estimated) after it: the most recent part of the conversation is always sent verbatim, and everything before the cut is what the summary covers. A re-compaction summarizes the old note plus the messages between the old cut and the new one into one new summary. A compaction that would shed less than `minShedTokens` is skipped, because the summary breaks the prompt cache from the cut onwards and a small saving is not worth that.

The summary request is the projected prefix up to the cut with the instructions as a final user message, `tool_choice: "none"` and `max_tokens: summaryMaxTokens`, bounded by `summaryTimeoutMs`. A provider error, an answer with no text, a tool call instead of a summary, a timeout, or a summary no smaller than what it replaces is a failure: the state is kept, the failure is counted and shown, and the turn goes on with the old projection. After `maxFailures` consecutive failures auto compaction pauses for the conversation until a manual request succeeds. A compaction fewer than three rounds after another in the same turn is refused as thrashing and counted as a failure too.

## Measuring

The window is the longest matching key of `windows` when one names the model, taken as it is; otherwise the smaller of what the provider reports for the model (`contextLength`) and `window`, or `window` alone when the provider reports nothing. `window` is a ceiling on purpose: the number on the configuration page is the number compaction works to, and a 1M-token model is compacted as if it had 200k unless `windows` says otherwise. The trigger is `floor(window × threshold)`. The size of the next request is the provider's own `prompt_tokens` for the last request, plus an estimate of the messages added since, whenever that count describes the projection about to be sent: same model, taken after the projection last changed, and counting no more messages than the projection has. Otherwise the estimate stands alone (`ceil(chars / 4)` over every string a message carries) and the state view says so. A count taken before the last compaction describes a history that no longer exists, and trusting it is how a compaction loop starts. The model list is cached in the fence for five minutes.

## Configuration

`config.packages["@thetis/compaction"]`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Compact automatically when the next request would exceed `threshold × window`. Off, an existing summary is still sent until it is reset from the Compaction dock. |
| `threshold` | `0.75` | The fraction of the model's context window at which compaction starts. Well before 1.0: at the window the provider refuses the request. |
| `window` | `200000` | The most context, in tokens, compaction ever plans against: a model that reports less uses its own, one that reports more is compacted as if it had this; also the window assumed when the provider reports none. |
| `windows` | not set | Per-model windows in tokens, keyed by model id or id prefix (longest key wins), for example `{ "anthropic/": 400000 }`. A key here overrides what the provider reports: the way to compact a 1M-token model earlier. |
| `keepTokens` | `20000` | How much of the most recent conversation, in estimated tokens, is always sent verbatim after the summary. |
| `minShedTokens` | `20000` | A compaction that would summarize less than this, in estimated tokens, is not worth breaking the prompt cache for and is skipped. |
| `summaryModel` | not set | The model that writes the summary. Unset means the conversation's own model, which reads the cached prefix and so costs only the summary; a different model re-reads the whole history at full price. |
| `summaryMaxTokens` | `16000` | `max_tokens` of the summarization request. Reasoning counts against it on models that think. |
| `summaryTimeoutMs` | `240000` | How long one summarization request may take before it is abandoned and counted as a failure. Keep it under the fence's 300 s step deadline. |
| `maxFailures` | `3` | Consecutive failed attempts after which automatic compaction pauses for the conversation. A manual request from the dock tries again. |

Zod validates the configuration, the saved state, the stored request and the last-call record it reads from `@thetis/harness-core`; an unreadable value falls back to the default rather than failing the turn.

## Use

Nothing to do: with the package installed, a long conversation compacts itself when it reaches the trigger, and the chip shows how full the window is. During a compaction the transcript shows "Compacting… summarizing 84 messages (≈730k tokens)", then "Context compacted: 84 earlier messages summarized (730k → 21k tokens, $0.41)" with the summary behind a fold. The dock says the same in one sentence and keeps a ledger of the last twenty compactions, resets and failures.

To compact now, before the trigger, or to steer what the summary keeps: open the Compaction dock and press **Compact on next message**, with a line of focus if there is something the summary must not lose ("keep the list of files still to review"). The request runs at the start of the next message, whatever the size, and the focus is appended to the summary instructions. **Send the full history again** does the reverse: the next message goes out uncompacted, whatever the size, and automatic compaction resumes from the message after that (a tool round inside that turn can still compact, if it grows past the trigger).

When the dock says auto compaction is paused, the last three attempts failed for the reason it shows: most often the model called a tool instead of writing, the request timed out, or the summary came back longer than what it replaced. A manual request tries again and, when it succeeds, clears the counter. If the reason is the model, set `summaryModel` to one that follows the instructions, or raise `summaryTimeoutMs` within the fence's deadline.

The state is in the session record under `harness["@thetis/compaction"]`; `thetis sessions show --user <id> --session <id>` prints it. The record's `conversation` is complete whatever the state says.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: the step, the chip, the dock, the three commands and the configuration. |
| `src/schemas.ts` | The names every part shares: the state, the configuration, the request, the event, the hook and the state view. |
| `src/index.ts` | `compact` (the step), `beforeRound` (the hook), `uiState`, `uiRequest`, `uiReset`, `sentenceFor`, `fmtTokens`. |
| `src/select.ts` | `estimate`, `boundaries`, `chooseCut`, `shed`, `dangling`. |
| `src/project.ts` | `project`, `note`, `projectedIndex`. |
| `src/measure.ts` | `windowFor`, `measure`, `measureRound`, `descriptorsFor`, `readLastCall`. |
| `src/summarize.ts` | `SUMMARY_INSTRUCTIONS`, `summaryRequest`, `summarize`, `extractSummary`. |
| `src/engine.ts` | `decide`, `run`, `compactIfDue`, `recordFailure`, `resetState`: the one code path the step, the hook and a manual request share. |
| `ui/index.js`, `ui/index.css` | The chip, the dock and the transcript card. |

## Tests

`npm test` from the runtime root, or after `npx tsc -b`, `node --test "packages/compaction/dist/test/**/*.test.js"`. The files are `test/select.test.ts` (sizing, boundaries, the cut, the projection, the window and the count), `test/step.test.ts` (the step and the hook against a fake provider: the exact summary request, the state and events of a success, every failure path, the pause, thrashing, stale counts, manual requests and resets) and `test/ui.test.ts` (the three commands and the sentences). `test/fixtures.ts` builds the contexts. `test/ui.test.js` drives the page module (`ui/index.js`) with a fake `ext` against the gateway's DOM fixture: the chip's figures and classes, the live card across phases, the marker at the cut, the dock's actions and refresh discipline.

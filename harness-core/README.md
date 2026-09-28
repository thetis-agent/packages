# @thetis/harness-core

The default harness. It builds the system prompt that tells the model where it is, how to use the tools and how to work, attaches every installed tool to the call, sends the call and runs what the model asks for until it stops, and records what the provider received. A round the connection cuts is sent again after a short wait, and a turn that a restart, an update or a crash cut short is continued by itself when the space starts again. The prompt is policy, not a manual: package authoring is the `thetis/packages` skill and the installed packages are the `list_packages` tool, each paid for on the turns that want it. It is a `loader` package in the default `systemPackages["*"]`, so it runs in each person's fence on every turn.

The kernel runs no step of its own: without a package that declares a step in the `execute` phase, a turn shapes a call and never sends it. This package is that step for the default configuration.

## What it provides

Seven pipeline steps, declared in `thetis.steps`:

| Step id | Phase | Export | What it does |
|---|---|---|---|
| `resume` | `history` | `resumeTurn` | On a turn with no input (a resume), drops a trailing assistant message marked `partial`, so the request does not end in a prefill. See "Resume". Does nothing on any other turn. |
| `turn-context` | `history` | `turnContext` | Ends the turn's input message with `[Turn context: Monday 2026-09-21 20:40 Europe/Berlin]`, once. The line is saved with the conversation, so a later turn re-sends the message byte for byte and the prefix stays cached; the system prompt carries no clock. The web transcript hides the line; `skill_search` and the loader's ranking strip it from the query. |
| `system-prompt` | `prompt` | `systemPrompt` | Appends the guide to `call.system`: the user and the home, what is reachable, file tools against shell, the working style; one extra line when the session has a parent. The skills loader announces the skills, since it knows whether there are any. Nothing of the person's: no `THETIS.md`, no `harness.notes`, no package list, no session id. |
| `attach-tools` | `tools` | `attachTools` | Adds every tool declared by every installed package to `call.tools`. The first package with a given tool name wins. A tool with no `parameters` gets `{ type: "object", properties: {} }`. |
| `apply-effort` | `call` | `applyEffort` | Writes the conversation's reasoning effort to `call.params.reasoning`: `{ effort }` for a level, `{ enabled: false }` for Off. Nothing when there is no choice, or when the model list says the model does not think. See "Reasoning effort". |
| `call` | `execute` | `callModel` | The loop. Sends `call` through `kernel.providers.call`, streams `text`, `reasoning`, `tool.call` and `usage` as they come, appends the assistant message (`message`, with the usage), runs each tool call in this fence, appends the `tool` message to both the conversation and `call.messages`, and calls again until the model answers without tool calls; before each call after the first, asks whether a drain is pending (see "Drain") and offers the round to the package `call.hints.beforeRound` names (see "Between rounds"). Sends a failed round again when asking again could help (see "The round retry"). Watches a tool's silence and asks about it (`stall`, `nudge`); reports a model's silence. Returns `{ conversation, call }`. |
| `record-call` | `after` | `recordCall` | Preserves the latest call summary from `callModel` in `harness["@thetis/harness-core"].lastCall`; provides a legacy summary if another execute step made the call. |

One service, `resumer` (`thetis.service`), which continues cut turns when the space starts; see "Resume". Four UI commands (`thetis.ui.commands`): `retry-now` (export `uiRetryNow`), which the web page's "Retry now" button calls while a round waits to be sent again, and the three the Effort pill sends (see "Reasoning effort"). One page file, `ui/index.js` with `ui/index.css`: the Effort pill, in the composer slot `effort`. No tools, no bench suites.

### The loop

`callModel` starts from `call.messages` when a `call` step shaped it, else from the conversation. The provider is reached through the kernel, which routes the request to the provider's own fence: this fence never sees the key. A tool runs here, in the caller's fence, through `env.invokeTool`, under its own package with that package's effective configuration (`kernel.config.effective`), the turn's session, the turn's model (`call.model`, as `env.model`, so a tool that starts another turn keeps the conversation's model), and the turn's signal. A string result is passed as it is; anything else is JSON. A tool that throws is its own result: `error: <message>`, and the loop goes on.

Which tools may run: the ones in `call.tools`, plus any name a scoping step took out of the call and listed in `call.hints.withheld`, resolved against what the installed packages declare (`ctx.packages.list()`). Scoping is an attention and token optimisation, never a permission boundary, so a call to a withheld tool is honoured. A name that is neither is answered `error: unknown tool: <name>`; the turn does not fail.

The step never throws, because a step's result is atomic and whatever the turn did before it stopped is worth keeping: sixteen tool calls are not worth losing to one refusal. Three ways it stops early:

| Cause | Kept | Tool calls that never ran | Emitted |
|---|---|---|---|
| The provider fails, and sending the round again did not help or could not (an `error` event, or the kernel refusing the call) | the text streamed so far, as an assistant message marked `partial`; every tool call already run, with its result | closed with `error: the turn failed before this tool ran`, marked `notRun` | one `{ type: "error", code: "provider", message: "provider error: ...", retryable, kind }`; the `after` steps still run |
| The turn is cancelled (`ctx.signal` aborts) | the same | closed with `error: the turn was stopped before this tool ran`, marked `notRun`; a tool that had already started is closed with `error: the turn was stopped while this tool was running, ...` and not marked, because it may have done its work | nothing: the kernel ends the turn with the single `cancelled` error |
| A drain is pending at a round boundary | everything: nothing is streaming and every tool call has its result | none | one `{ type: "yield", why }`; the step returns normally |

The marks live in `message.extensions["@thetis/harness-core"]`: `{ partial: true }` on a cut assistant message, `{ notRun: true }` on a result written for a tool call that never started. They are kept in the record and never sent to a provider. `marksOf(message)` reads them. A tool call that arrives in the same round as the failure is dropped with the round: no assistant message asked for it, so nothing is dangling. The signal is checked mid-stream (the kernel call rejects with code `cancelled`), between tool calls, and between rounds. A tool receives it as `env.signal`; the step does not wait for a tool that ignores it. The wait is abandoned the moment the signal aborts, the call is closed as stopped, and whatever the tool started goes on in the fence (`shell` says as much of its command). The fence gives a cancelled step five seconds to return what it kept; a step that honours its signal returns well inside that.

Neither of the loop's two long waits is ever simply waited on; see "The nudge" below.

`retryable` and `kind` on the `error` event come from the provider's own labels when it gave them, else from the words of the failure (see "The round retry"). `kind` is one of `connection`, `rate-limit`, `overloaded`, `timeout`, `credits`, `context`, `output-limit`, `filter`, `auth`, `other`: the page says the sentence that fits, and the kernel copies both into the turn record's `interrupted`.

**Between rounds.** Before every request after the first, the loop reads `call.hints.beforeRound`. When it is `{ package, export }`, that export is invoked in this fence like a tool — `env.invokeTool({ package, export, name: "beforeRound" }, args, { session, config, model, signal })`, with `config` the named package's effective configuration — and given the loop's live state: `{ conversation, call, harness, round, usage, priced, turn: { id }, emit }`. `round` counts from 2; `usage` is what the provider reported for the previous request and `priced` is how many of `call.messages` that request carried, so a hook can put the provider's own count against the messages it covers and estimate only what came after. The answer may hold `call.messages`, which replaces the loop's messages whole, and `harness`, which replaces the live harness whole and is what the step's result carries (merged with this package's own key). Nothing else in the answer is read. The hint is set by whichever `call` step wants the seam — `@thetis/compaction` sets it to itself — and harness-core knows no package by name. A hook that throws, rejects or answers something unusable is one `console.error` line naming the package, and the round proceeds unchanged: a package that manages the conversation's size must never be the reason a turn fails. Both waits, the configuration read and the hook, end on the turn's signal. The types (`RoundHookArgs`, `RoundHookResult`, `RoundHookRef`) are exported for `import type` use.

A provider's `reasoning` events are forwarded as turn events and nothing more. A reasoning model's thinking is worth watching while it happens — a gateway shows it live, and the web transcript folds it away when the answer starts — but it never joins the streamed text, so it is in no assistant message, in no saved conversation and in nothing sent back on the next turn. Redrawing a record therefore redraws no thinking.

`callModel` saves the request before each model call to `home/harness-core/context/<session>.json`, atomically replacing the previous request. When the provider emits an inspection `request` event, its exact HTTP JSON body replaces the generic provider input. The `context: true` hint opts into this event; no authentication headers are captured. The snapshot also keeps a usage ledger, including partial usage from failed or cancelled turns. Each completed snapshot write emits a small `context.updated` event so an open inspector refreshes during the turn.

`recordCall` preserves the summary returned by `callModel`. `messages` counts the messages sent in the latest request, before its reply was appended. Full JSON lives only in the snapshot file; the small model, system, tools, time and usage summary remains in the session harness for existing inspectors. A provider that does not emit request bodies still has its complete provider input captured. Capture write failures are logged and do not stop the turn.

Steps declared with phase `bench` never run on an ordinary turn; `list_packages` still reports them.

## The round retry

A round that fails in a way asking again could fix is sent again, after a short and growing wait, and the turn goes on as if nothing happened. This is what stops one dropped connection from ending a long turn, and a subagent's whole task with it.

- **The same request.** The retry sends the same `call` object again, byte for byte: no round hook runs again and nothing is added to `call.messages`. By the time an upstream is streaming, it has already read and cached the prompt, so the second attempt reads the prefix from the cache and pays only for the reply again.
- **Nothing is redone.** The half round is thrown away: its text never becomes a message, and no tool of it has run, because tool calls arrive only with a finished stream and tools run after it. Finished rounds and their tool results stay exactly as they are.
- **Who decides.** The provider labels each `error` event (`retryable`, `kind`, `status`, `retryAfterMs`; see `@thetis/provider-openrouter`). This package decides, the same way for every provider. A provider that labels nothing is read by the words of its message, and only wording that says the line or the upstream failed counts as worth another try.

| Failure | Sent again |
|---|---|
| `connection`, `timeout`, `rate-limit`, `overloaded` (a dropped or silent stream, `fetch failed`, `429`, `5xx`) | up to `retryAttempts` times |
| The provider's request cancelled under a turn nobody stopped (its fence closing for an apply) | up to `retryAttempts` times, as `connection` |
| An empty reply, tool arguments that are not JSON, any other failure the provider called `retryable` | once |
| A content filter stop (`filter`) | once: in practice it is usually a false positive |
| The output limit (`output-limit`) | once, with `max_tokens` doubled (up to 128,000) and a one-line note for that attempt only: `[Harness note: your last reply hit the output limit and was discarded. Write large files in parts: several smaller writes or edits, not one.]`. The limit is known from `call.params.max_tokens` or the provider's message; when it is not, only the note is added. Neither the note nor the raised limit is kept for the next round. |
| `context`, `credits`, `auth`, anything the provider called not `retryable`, anything unlabelled whose words say nothing transient | never. The turn stops with the error, and a person's Retry can still help after a fix. |
| The person's Stop | never |

The waits are `retryBaseMs` doubled per retry, capped at `retryMaxMs`, with a fifth either way of jitter: 2, 4, 8, 16, 32 seconds with the defaults. A `retryAfterMs` the provider passed on (a `Retry-After`) is honoured when it is longer. All the waits of one turn together may take at most `retryBudgetMs`; a wait that does not fit ends the retrying at once, and the error says so. A Stop ends a wait at once. The waits are not silence: nothing watches the model while no request is open.

What the page sees is one `extension` event, `harness-core.retry`, per step:

```ts
{ type: "extension", name: "harness-core.retry", data: {
  phase: "waiting" | "sending" | "recovered" | "exhausted",
  round: number, attempt: number, of: number,
  inMs?: number, until?: string /* ISO */, kind, reason: string, dropped?: { text: number; tools: number } } }
```

- `waiting`: the half round was thrown away (the page withdraws its live text, thinking and tool progress); retry `attempt` of `of` is sent in `inMs`, at `until`. `dropped` is how many characters of reply text and of tool arguments were thrown away.
- `sending`: the wait is over and the request goes out.
- `recovered`: the first sign of the new reply.
- `exhausted`: the retries or the budget are used up; the turn's normal `error` follows.

**Retry now.** The UI command `retry-now { session }` writes `harness-core/retry/<session>.json` in the person's home. A waiting loop looks for that file every 500 ms, removes it and sends at once, so one click is one retry. A file rather than storage, for the reason `@thetis/compaction` gives for its requests: the command runs under the gateway's environment and the step under this package's, and the home is the one place both reach at the same path. A request left from before a wait began is removed when the wait begins.

## Resume

A resume is a turn with no input, `sessions.send(id, [])`: the pipeline runs over the saved conversation and appends nothing, so the person's message is never sent twice. The Retry and Continue buttons, the resumer below, `resume_subagent` and the workflows engine all resume this way. Two things a stopped turn leaves behind would make that conversation wrong to send, and both are marked when the turn stops:

- **A cut reply** (`partial`). Sent as the last message it would be a prefill, which some models refuse and the rest continue mid-sentence. The `resume` step, first in the `history` phase, drops it on a turn with no input, before compaction's projection and the prompt cache see the conversation. A record written before the marks existed has none; there, a trailing assistant message with no tool calls is dropped only when this package's usage ledger says the previous turn did not complete (`failed`, `cancelled`, or still `running` because the process died under it). A finished reply is never resumed away.
- **Tools that never ran** (`notRun`). On a turn with no input, `callModel` takes those results out of the conversation and the request, runs the tools, and only then sends the first request. A result the kernel wrote for a step that died (`error: the turn was interrupted: ...`) carries no mark and is left alone: that tool may have run halfway, and the model decides.

**The resumer** (`thetis.service`, export `resumer`) runs when the space starts, which is at boot and after every apply. About two seconds in, it lists the conversations and continues each one whose record says it was cut by a `restart`, a `reload` (an apply), a `crash` or a `yield` (a drain), when it is a root conversation (not a subagent: the parent decides about its child), has not been resumed automatically before (`interrupted.resumes` below 1), and was cut less than `resumeMaxAgeMs` ago. It resumes two at a time, starting them at least two seconds apart. Each one is read again just before it starts; one that is running, or no longer carries the same cut because somebody resumed it meanwhile, is skipped, and so is a `busy` refusal. A turn a person stopped, a workflow's budget cut and a provider failure are never resumed by it: each is somebody's decision or needs somebody's fix, and each has its own button. `autoResume: false` switches it off. It reads `interrupted` from the session summaries the kernel lists (`why`, `at`, `resumes`); on a kernel that does not list them it finds nothing to do.

## Drain

At the top of every round after the first, where the round hook runs, the loop asks the kernel `turns.yielding()`. While a drained restart or apply of this space is pending, the answer is `{ why: "restart" | "reload" }`: the turn stops right there, at a round boundary, with nothing streaming and every tool call answered, emits `{ type: "yield", why }` and returns everything it did. The kernel records the turn as cut by a `yield`, clean, and the resumer continues it once the space is back. A kernel without the question, an error, or no answer within five seconds all mean "go on"; such a turn is cut at the drain's deadline instead, as before, and resumed the same way.

## The nudge

The rule this section keeps, and the one to hold any change to it against:

> Every wait is bounded, and every bound ends in a decision. Continuing to wait is a decision somebody made, never a default that nobody chose.

A turn waits on two things that can take any length of time and give no sign either way: the model's stream, and a tool. Neither can be put on a deadline. A deadline cannot tell a twenty-minute build from a wedged socket, and killing the first to be safe from the second is how a turn that had done an hour of work came to be thrown away whole, with no reply saved at all.

So nothing here is killed on a timer. What is bounded is the silence.

Only a tool is asked about. A model's silence is the provider's to bound: its own stall watchdog abandons a stream that sends no bytes (`streamStallMs` in `@thetis/provider-openrouter`) and says so in a labelled error, and the round is then sent again (see "The round retry"). Asking a model about its own silence, through the same provider that was not answering, cancelled live calls three times in production and saved none. So when the model has sent nothing for `modelStallMs`, the step emits one `stall` with `what.kind: "model"`, for the page to say "waiting on the model", and nothing else: no question, no `nudge`, no cancel. The next sign of life ends that silence, and the next one is reported again.

1. Each tool call runs under its own `AbortController`, derived from `ctx.signal`, and is watched. For a tool there is nothing to see until it returns, so the clock is simply how long it has been running.
2. When a tool has produced nothing for its allowance, the step emits `stall` and asks the model about it. **The work keeps running while the question is out.** Nothing has been cancelled and nothing has failed.
3. The question is itself a wait, so it is bounded too, in time (`nudgeMs`) and in attempts (`nudgeAttempts`). This is the part that makes being stuck impossible: **a nudge that cannot be answered cancels.** Not "waits a bit longer", not "tries for ever". A refusal, a timeout, an unreadable answer and a used-up attempt count all land on `cancel`, reported as `by: "rule"`, with a `why` that says which it was in words a person can read.
4. The decision is emitted as `nudge`. A `continue` resets the clock and multiplies the allowance by `stallBackoff`, capped at `stallMaxMs`, so the next silence asks again with a longer fuse. Waiting for ever remains possible, but only as an unbroken series of deliberate decisions, each one of them on the page.
5. The person's own cancel wins over all of it, at any point, and a decision about work the person has already stopped is not announced.

Nothing in the watching can throw. It runs on a timer, where an exception is not a failed turn but a dead process, and an exception that merely escaped the asking would leave the watch mid-question for ever, which is the unbounded wait coming back through the one door left open. So the event stream is written to inside a `try`, the asking is settled through both of a promise's ends, and every road out of a stall is a decision.

What a cancel does: that one tool call's controller is aborted, and the tool receives it as `env.signal`. The loop goes on, and the model reads a `tool` message saying the call was cancelled, how long it was silent, who decided, why, and not to reissue it unchanged.

### What the model is told

The `stall` and `nudge` events go to whoever is watching the turn. They are not in the conversation, so a cancelled tool call is the only way the model finds out, and the wording is the whole mechanism by which it learns rather than simply retrying:

```
error: `shell` was cancelled after running for 4m 12s. It did not fail and it did not refuse
anything: it produced nothing for 4m 12s, this turn asked whether to keep waiting, and the
decision was to cancel it. Reason: a file read cannot take four minutes. Whatever it started may
still be running outside this turn, and anything it had already changed has changed. Do not issue
the same call again unchanged: it would go quiet in the same way. Make it smaller, bound it
yourself (a timeout, a narrower path, fewer results, one part of the work), or reach the same end
another way. If you are sure it only needed longer, say so in your reply instead of starting it
again.
```

It begins `error:` because that is the shape every other tool failure has and the model already reads it as "this did not work", but every sentence after that exists to stop it drawing the wrong conclusion: nothing broke, the work may still be running, and repeating the call would repeat the stall.

### The question

The question is a separate, tiny provider call. It carries **one** message and one tool, and none of the turn's own conversation: the prompt that stalled may be a million tokens, and asking about it must not cost what it cost. The message says what has gone quiet and for how long, what the tool was called with, how many times this has already been continued, and the last thing the person asked for. The answer comes back as a `decide` tool call with `decision` and `why`; a model that writes the word instead of calling the tool is read too, and where the prose is ambiguous the first of `continue` and `cancel` wins, which is deterministic and, when it is wrong, wrong towards cancelling.

By default the question goes to the turn's own model, which is the one that knows what the work is for. Set `nudgeModel` to a small fast model when the turn runs on a slow or expensive one.

## Reasoning effort

How hard the model thinks, chosen per conversation. This was `@thetis/effort` until 0.6.0; it is a parameter of the call this package makes, so it lives here now. Its files did not move, so a choice made before the merge still holds.

| Piece | Where | What |
|---|---|---|
| `applyEffort` | step `apply-effort`, phase `call` | Reads the conversation's choice and writes `call.params.reasoning`. Nothing when there is no choice, or when the fence's model list says the model does not think. |
| `effort-state` | UI command, export `uiEffortState` | The conversation's own choice, the remembered one, and what the step would send. |
| `effort-set` | UI command, export `uiEffortSet` | Records a choice. `effort: ""` means the default again. `remember: false` leaves the remembered choice alone. |
| `effort-models` | UI command, export `uiEffortModels` | The default model and, for every model that thinks, its reasoning descriptor from `kernel.models()`. |
| the pill | `ui/index.js`, `composer` slot `effort` | Beside the model picker. Hidden for a model that does not think. The list is cut to the efforts the model accepts, and **Off** is left out when its thinking is mandatory. |

The efforts are OpenRouter's: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, and `none` (Off). A level the model does not take is mapped by OpenRouter to the nearest one it does; `none` on a model whose thinking is mandatory is refused by OpenRouter with its own sentence, which the turn reports as its error. The step does not second-guess the provider: the page hides what the model rejects, and the request carries what was asked.

`call.params` is spread over the request body after the provider's `defaults`, so a choice made here wins over a deployment-wide `"reasoning": { "effort": "medium" }`. No choice means the deployment's default, or the model's own.

The pill needs each model's `reasoning` descriptor on `kernel.models()`: `{ mandatory, defaultEnabled?, defaultEffort?, supportedEfforts?, supportsMaxTokens? }`. `@thetis/provider-openrouter` carries it from OpenRouter's model listing. A provider that lists no descriptor hides the pill for its models, and the step sends nothing for them.

Two files under `effort/` in the person's home, written only by these commands: `sessions.json` (session id to effort) and `prefs.json` (`{ "default": "<effort>" }`, the choice made last, which a conversation without a choice of its own inherits). Choosing **Default** clears both, as the model picker's **Default** does.

**Moving from `@thetis/effort`.** Its files are gone from the checkout, so a workspace that had it installed keeps a record of nothing: the package is skipped, and the daemon logs `@thetis/effort is recorded for <id> but its files are missing` until the record goes. `thetis uninstall @thetis/effort --user <id>` removes it, for each person who has it (`thetis packages list --user <id>` says who); uninstall works without the files. A promoted copy or a fork of it still runs its own step beside this one, and both write the same `reasoning` from the same files.

## The turn context line

This package owns the line and its stripper. `TURN_CONTEXT` is the regex that matches it as a suffix (`/\n\n\[Turn context: [^\n\]]*\]$/`) and `withoutTurnContext(text)` takes it off. Anything that shows the person their own words, or matches on them, imports them from here: the web gateway strips it from the sidebar titles and previews, the skills packages from the ranking query. Code that must not depend on this package (a provider fixture, a browser file) copies the regex and says so.

Context snapshots and saved request summaries use Zod schemas. An unreadable or malformed diagnostic snapshot is logged and replaced with a fresh ledger, so diagnostics cannot interrupt a turn. Wire summaries validate only the fields they display; the complete provider request is preserved separately, including unfamiliar content.

## Configuration

`config.packages["@thetis/harness-core"]`:

| Key | Default | Effect |
|---|---|---|
| `turnContext` | `true` | Append the turn context line. `false` appends nothing. |
| `timeZone` | the daemon's zone | The IANA zone the line is written in, for example `Europe/Berlin`. An unknown zone falls back to `UTC`. |
| `modelStallMs` | `60000` | How long the model may send nothing at all before the page is told it is quiet (`stall`). Nothing is asked and nothing is cancelled. |
| `toolStallMs` | `120000` | How long a tool may run without returning before the turn asks. A build or a test run is silent for minutes and that is ordinary. |
| `stallBackoff` | `2` | What the allowance is multiplied by after each `continue`. Never less than 1. |
| `stallMaxMs` | `900000` | The longest the allowance grows to. With the defaults the questions come at 2, 4, 8, 15, 15 minutes and so on. |
| `nudgeMs` | `30000` | How long one attempt at asking may take. A small prompt to a fast model answers in seconds; this covers a cold provider. |
| `nudgeAttempts` | `2` | How many attempts the question gets. One retry, so a single dropped request is not a cancel, and at most a minute is spent before the rule decides. |
| `nudgeModel` | the turn's model | The model the question is put to. |
| `retryAttempts` | `5` | How many times a round that failed in a transient way is sent again. The once-only cases (empty reply, bad tool JSON, filter, output limit) get one each, never more than this. `0` sends nothing again. |
| `retryBaseMs` | `2000` | The first wait. Each later one doubles, with a fifth either way of jitter. |
| `retryMaxMs` | `60000` | The longest one wait grows to by doubling. A longer `Retry-After` is still honoured. |
| `retryBudgetMs` | `300000` | The most one turn spends waiting between retries, all rounds together. |
| `autoResume` | `true` | Whether the resumer continues cut turns when the space starts. |
| `resumeMaxAgeMs` | `1800000` | How old a cut turn may be and still be continued automatically. |

The numbers are chosen for a person watching a chat window, not for a batch job: the first check-in on a tool comes two minutes in, and a decision is reached within three. None of the nudge numbers can be set to `0` to switch the asking off. A value of `0` or less is ignored and the default stands, because a wait nobody is watching is the thing all of this exists to make impossible. The same holds for the three retry times; `retryAttempts` alone may be `0`, because sending nothing again is a choice with a visible result (the error and its Retry button), not an unwatched wait.

The package reads no environment variables and no file in the home. Text a person wants in every prompt is a universal skill under `home/skills/` (linted, at most eight, shown in the skills dock); text for one project is that project's instructions. Both are shown and capped where they live, which a file read into the prompt was not.

## Use

The package is installed for everyone by default. The prompt names no package and no tool: `list_packages` (from `@thetis/tool-exec`) says in its own description that the prompt does not carry the list, and every tool's description says when to use it, so nothing is paid for on every call that a description already carries. It names no session id either, so a subagent's prompt differs from its parent's by one line and the provider cache the parent warmed serves the child.

The guide is about 1,100 characters, the turn context line included. What a person adds through a project's instructions and the skills a loader pins is theirs to size.

Read what the last call received, after a turn:

```sh
thetis sessions show --user alice --session <id>
```

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: seven steps, the `resumer` service, the four UI commands, the `effort` composer slot, and the configuration keys. |
| `src/index.ts` | `turnContext`, `systemPrompt`, `attachTools`, `callModel` with the round retry and the drain, `recordCall`, the nudge (`NUDGE_DEFAULTS`, `nudgeConfig`, `readDecision`, `cancelledToolResult`, `fmtMs`), the guide text, the `LastCall` type, `TURN_CONTEXT` and `withoutTurnContext`; re-exports the three below. |
| `src/retry.ts` | The retry policy: `RETRY_DEFAULTS`, `retryConfig`, `classify`, `kindFromMessage`, `backoffMs`, the retry-now file and `backoffWait`, `withLongerLimit` and the output-limit note, and the `uiRetryNow` command. |
| `src/resume.ts` | The marks (`marksOf`, `mark`), the `resumeTurn` step, and `unrun`, which finds the tool calls a resume runs. |
| `src/resumer.ts` | The `resumer` service: `RESUME_DEFAULTS`, `resumerConfig`, `resumable`, `pick`, `resumeOnce`. |
| `src/effort.ts` | The reasoning effort: `EFFORTS`, the two files (`effortOf`, `setEffort`, `readEffortSessions`, `readRememberedEffort`), `reasoningFor`, the `applyEffort` step and the three commands. |
| `ui/index.js`, `ui/index.css` | The Effort pill. Built with `ext.dom.el`; the `.ef-` rules draw it from the shell's tokens. No inline style: the page's CSP forbids it. |
| `src/round.ts` | The round hook's shapes: `RoundHookRefSchema` (the hint), `RoundHookArgs`, `RoundHookResult` and the lenient `RoundHookResultSchema` the answer is read with. |
| `test/harness.test.ts` | The five steps over a fake context; the loop over a scripted provider, a recording `invokeTool` and a fake package list: withheld tool honoured, unknown tool refused, cancel mid-stream and between tool calls, provider failure, a tool that throws; the round hook called from round 2 with the live state, a throwing hook logged and the turn completing, no hint meaning no call. |
| `test/nudge.test.ts` | The nudge, on the shipped numbers scaled down by about a thousand: a quiet tool asked about and continued, a tool the model cancels, the three unanswerable cases, a quiet stream reported and never asked about, the person's stop winning over a question in flight, a watcher whose events nobody will accept, and the guarantee table. |
| `test/effort.test.ts` | The effort step and commands over a temporary home: no choice changes nothing, a level and Off, a model that does not think, a model the list does not know or a failing list, the remembered choice and Default, a word that is not an effort, a hand-edited file with junk in it. |
| `test/effort-browser.mjs` | The pill in Chromium over the real gateway page with a routed fake API. Not part of `npm test`; run it with `THETIS_PLAYWRIGHT_MODULE` and `THETIS_CHROMIUM_EXECUTABLE` set, as `packages/gateway-web/test/BROWSER.md` describes. |
| `test/retry.test.ts` | The round retry over a scripted provider: a cut round resent byte for byte, no tool run twice, retries running out with the marks and a labelled error, what is never resent, the once-only cases, the output-limit retry, Retry-After and the budget, a stop during a wait, retry-now; the resume step and the `notRun` tools; the drain; the resumer's choice, its two lanes and its skips. |

## Tests

`npm test` from the runtime root builds every package and runs `test/harness.test.ts`, `test/nudge.test.ts`, `test/retry.test.ts` and `test/effort.test.ts` with `node --test`.

`test/nudge.test.ts` ends in a table with one fixture per wait a turn can make, each arranged so that the wait never ends by itself: a model call only its provider's stall bound ends, every time; the stream after it has said something; a tool; a tool that ignores its signal; the read of a tool package's configuration; the question itself; and all of them at once. Every fixture asserts the same things. The turn ended. It kept what it had already done. It said out loud what was cancelled or abandoned and why, and a model's silence was sent again until the retries ran out. Every tool `stall` it emitted has a matching `nudge`, so no wait was left open, and no model `stall` was ever asked about. Every tool call in the returned conversation has an answer, so the next turn is not refused. Adding a new wait to this step means adding a row to that table.

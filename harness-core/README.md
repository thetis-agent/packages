# @thetis/harness-core

The default harness. It builds the system prompt that tells the model where it is, how to use the tools and how to work, attaches every installed tool to the call, sends the call and runs what the model asks for until it stops, and records what the provider received. The prompt is policy, not a manual: package authoring is the `thetis/packages` skill and the installed packages are the `list_packages` tool, each paid for on the turns that want it. It is a `loader` package in the default `systemPackages["*"]`, so it runs in each person's fence on every turn.

The kernel runs no step of its own: without a package that declares a step in the `execute` phase, a turn shapes a call and never sends it. This package is that step for the default configuration.

## What it provides

Five pipeline steps, declared in `thetis.steps`:

| Step id | Phase | Export | What it does |
|---|---|---|---|
| `turn-context` | `history` | `turnContext` | Ends the turn's input message with `[Turn context: Monday 2026-09-21 20:40 Europe/Berlin]`, once. The line is saved with the conversation, so a later turn re-sends the message byte for byte and the prefix stays cached; the system prompt carries no clock. The web transcript hides the line; `skill_search` and the loader's ranking strip it from the query. |
| `system-prompt` | `prompt` | `systemPrompt` | Appends the guide to `call.system`: the user and the home, what is reachable, file tools against shell, the working style; one extra line when the session has a parent. The skills loader announces the skills, since it knows whether there are any. Nothing of the person's: no `THETIS.md`, no `harness.notes`, no package list, no session id. |
| `attach-tools` | `tools` | `attachTools` | Adds every tool declared by every installed package to `call.tools`. The first package with a given tool name wins. A tool with no `parameters` gets `{ type: "object", properties: {} }`. |
| `call` | `execute` | `callModel` | The loop. Sends `call` through `kernel.providers.call`, streams `text`, `reasoning`, `tool.call` and `usage` as they come, appends the assistant message (`message`, with the usage), runs each tool call in this fence, appends the `tool` message to both the conversation and `call.messages`, and calls again until the model answers without tool calls. Watches both of its long waits for silence and asks about them (`stall`, `nudge`). Returns `{ conversation, call }`. |
| `record-call` | `after` | `recordCall` | Preserves the latest call summary from `callModel` in `harness["@thetis/harness-core"].lastCall`; provides a legacy summary if another execute step made the call. |

No tools, no service, no UI, no bench suites.

### The loop

`callModel` starts from `call.messages` when a `call` step shaped it, else from the conversation. The provider is reached through the kernel, which routes the request to the provider's own fence: this fence never sees the key. A tool runs here, in the caller's fence, through `env.invokeTool`, under its own package with that package's effective configuration (`kernel.config.effective`), the turn's session, and the turn's signal. A string result is passed as it is; anything else is JSON. A tool that throws is its own result: `error: <message>`, and the loop goes on.

Which tools may run: the ones in `call.tools`, plus any name a scoping step took out of the call and listed in `call.hints.withheld`, resolved against what the installed packages declare (`ctx.packages.list()`). Scoping is an attention and token optimisation, never a permission boundary, so a call to a withheld tool is honoured. A name that is neither is answered `error: unknown tool: <name>`; the turn does not fail.

The step never throws, because a step's result is atomic and whatever the turn did before it stopped is worth keeping: sixteen tool calls are not worth losing to one refusal. Two ways it stops early:

| Cause | Kept | Tool calls that never ran | Emitted |
|---|---|---|---|
| The provider fails (an `error` event, or the kernel refusing the call) | the text streamed so far, as an assistant message; every tool call already run, with its result | closed with `error: the turn failed before this tool ran` | one `{ type: "error", code: "provider", message: "provider error: ..." }`; the `after` steps still run |
| The turn is cancelled (`ctx.signal` aborts) | the same | closed with `error: the turn was stopped before this tool ran` | nothing: the kernel ends the turn with the single `cancelled` error |

A tool call that arrives in the same round as the failure is dropped with the round: no assistant message asked for it, so nothing is dangling. The signal is checked mid-stream (the kernel call rejects with code `cancelled`), between tool calls, and between rounds. A tool receives it as `env.signal`; the step does not wait for a tool that ignores it. The wait is abandoned the moment the signal aborts, the call is closed as stopped, and whatever the tool started goes on in the fence (`shell` says as much of its command). The fence gives a cancelled step five seconds to return what it kept; a step that honours its signal returns well inside that.

Neither of the loop's two long waits is ever simply waited on; see "The nudge" below.

A provider's `reasoning` events are forwarded as turn events and nothing more. A reasoning model's thinking is worth watching while it happens — a gateway shows it live, and the web transcript folds it away when the answer starts — but it never joins the streamed text, so it is in no assistant message, in no saved conversation and in nothing sent back on the next turn. Redrawing a record therefore redraws no thinking.

`callModel` saves the request before each model call to `home/harness-core/context/<session>.json`, atomically replacing the previous request. When the provider emits an inspection `request` event, its exact HTTP JSON body replaces the generic provider input. The `context: true` hint opts into this event; no authentication headers are captured. The snapshot also keeps a usage ledger, including partial usage from failed or cancelled turns. Each completed snapshot write emits a small `context.updated` event so an open inspector refreshes during the turn.

`recordCall` preserves the summary returned by `callModel`. `messages` counts the messages sent in the latest request, before its reply was appended. Full JSON lives only in the snapshot file; the small model, system, tools, time and usage summary remains in the session harness for existing inspectors. A provider that does not emit request bodies still has its complete provider input captured. Capture write failures are logged and do not stop the turn.

Steps declared with phase `bench` never run on an ordinary turn; `list_packages` still reports them.

## The nudge

The rule this section keeps, and the one to hold any change to it against:

> Every wait is bounded, and every bound ends in a decision. Continuing to wait is a decision somebody made, never a default that nobody chose.

A turn waits on two things that can take any length of time and give no sign either way: the model's stream, and a tool. Neither can be put on a deadline. A deadline cannot tell a twenty-minute build from a wedged socket, and killing the first to be safe from the second is how a turn that had done an hour of work came to be thrown away whole, with no reply saved at all.

So nothing here is killed on a timer. What is bounded is the silence.

1. Each wait runs under its own `AbortController`, derived from `ctx.signal`, and is watched. A sign of life resets the clock: for a tool there is nothing to see until it returns, so the clock is simply how long it has been running; for the stream, any event at all counts, text, thinking, a tool call or an accounting line.
2. When a wait has produced nothing for its allowance, the step emits `stall` and asks the model about it. **The work keeps running while the question is out.** Nothing has been cancelled and nothing has failed.
3. The question is itself a wait, so it is bounded too, in time (`nudgeMs`) and in attempts (`nudgeAttempts`). This is the part that makes being stuck impossible: **a nudge that cannot be answered cancels.** Not "waits a bit longer", not "tries for ever". A refusal, a timeout, an unreadable answer and a used-up attempt count all land on `cancel`, reported as `by: "rule"`, with a `why` that says which it was in words a person can read.
4. The decision is emitted as `nudge`. A `continue` resets the clock and multiplies the allowance by `stallBackoff`, capped at `stallMaxMs`, so the next silence asks again with a longer fuse. Waiting for ever remains possible, but only as an unbroken series of deliberate decisions, each one of them on the page.
5. The person's own cancel wins over all of it, at any point, and a decision about work the person has already stopped is not announced.

Nothing in the watching can throw. It runs on a timer, where an exception is not a failed turn but a dead process, and an exception that merely escaped the asking would leave the watch mid-question for ever, which is the unbounded wait coming back through the one door left open. So the event stream is written to inside a `try`, the asking is settled through both of a promise's ends, and every road out of a stall is a decision.

What a cancel does depends on which wait it was:

| Cancelled | Effect | What the turn ends up with |
|---|---|---|
| A tool | That one call's controller is aborted; the tool receives it as `env.signal`. The loop goes on. | A `tool` message the model reads, saying the call was cancelled, how long it was silent, who decided, why, and not to reissue it unchanged. |
| The model's stream | That request's controller is aborted. | The turn ends the way a provider failure ends it: one `error` event of code `provider` reading `the model call was cancelled after <duration> of silence: <why>`, every tool round already done kept, and the text that did arrive kept as a partial assistant message. |

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

By default the question goes to the turn's own model, which is the one that knows what the work is for. Set `nudgeModel` to a small fast model when the turn runs on a slow or expensive one. Note that on a model stall the default asks the model that has gone quiet, through the provider that is not answering: that question will usually time out and the rule will cancel, which is the right outcome and takes `nudgeMs * nudgeAttempts` to reach.

## The turn context line

This package owns the line and its stripper. `TURN_CONTEXT` is the regex that matches it as a suffix (`/\n\n\[Turn context: [^\n\]]*\]$/`) and `withoutTurnContext(text)` takes it off. Anything that shows the person their own words, or matches on them, imports them from here: the web gateway strips it from the sidebar titles and previews, the skills packages from the ranking query. Code that must not depend on this package (a provider fixture, a browser file) copies the regex and says so.

Context snapshots and saved request summaries use Zod schemas. An unreadable or malformed diagnostic snapshot is logged and replaced with a fresh ledger, so diagnostics cannot interrupt a turn. Wire summaries validate only the fields they display; the complete provider request is preserved separately, including unfamiliar content.

## Configuration

`config.packages["@thetis/harness-core"]`:

| Key | Default | Effect |
|---|---|---|
| `turnContext` | `true` | Append the turn context line. `false` appends nothing. |
| `timeZone` | the daemon's zone | The IANA zone the line is written in, for example `Europe/Berlin`. An unknown zone falls back to `UTC`. |
| `modelStallMs` | `60000` | How long the model may send nothing at all before the turn asks whether to keep waiting. |
| `toolStallMs` | `120000` | How long a tool may run without returning before the turn asks. Longer than the model's: a build or a test run is silent for minutes and that is ordinary, while a model that has said nothing for a minute is not. |
| `stallBackoff` | `2` | What the allowance is multiplied by after each `continue`. Never less than 1. |
| `stallMaxMs` | `900000` | The longest the allowance grows to. With the defaults the questions come at 2, 4, 8, 15, 15 minutes and so on. |
| `nudgeMs` | `30000` | How long one attempt at asking may take. A small prompt to a fast model answers in seconds; this covers a cold provider. |
| `nudgeAttempts` | `2` | How many attempts the question gets. One retry, so a single dropped request is not a cancel, and at most a minute is spent before the rule decides. |
| `nudgeModel` | the turn's model | The model the question is put to. |

The numbers are chosen for a person watching a chat window, not for a batch job: the first check-in on a tool comes two minutes in, and a decision is reached within three. None of them can be set to `0` to switch the asking off. A value of `0` or less is ignored and the default stands, because a wait nobody is watching is the thing all of this exists to make impossible.

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
| `package.json` | The manifest: five steps and two configuration keys. |
| `src/index.ts` | `turnContext`, `systemPrompt`, `attachTools`, `callModel`, `recordCall`, the nudge (`NUDGE_DEFAULTS`, `nudgeConfig`, `readDecision`, `cancelledToolResult`, `fmtMs`), the guide text, the `LastCall` type, `TURN_CONTEXT` and `withoutTurnContext`. |
| `test/harness.test.ts` | The five steps over a fake context; the loop over a scripted provider, a recording `invokeTool` and a fake package list: withheld tool honoured, unknown tool refused, cancel mid-stream and between tool calls, provider failure, a tool that throws. |
| `test/nudge.test.ts` | The nudge, on the shipped numbers scaled down by about a thousand: a quiet tool asked about and continued, a tool the model cancels, the three unanswerable cases, a quiet stream, the person's stop winning over a question in flight, a watcher whose events nobody will accept, and the guarantee table. |

## Tests

`npm test` from the runtime root builds every package and runs `test/harness.test.ts` and `test/nudge.test.ts` with `node --test`.

`test/nudge.test.ts` ends in a table with one fixture per wait a turn can make, each arranged so that the wait never returns: the model call, the stream after it has said something, a tool, a tool that ignores its signal, the read of a tool package's configuration, the question itself, and all of them at once. Every fixture asserts the same four things. The turn ended. It kept what it had already done. It said out loud what was cancelled and why. Every `stall` it emitted has a matching `nudge`, so no wait was left open, and every tool call in the returned conversation has an answer, so the next turn is not refused. Adding a new wait to this step means adding a row to that table.

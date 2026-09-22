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
| `call` | `execute` | `callModel` | The loop. Sends `call` through `kernel.providers.call`, streams `text`, `tool.call` and `usage` as they come, appends the assistant message (`message`, with the usage), runs each tool call in this fence, appends the `tool` message to both the conversation and `call.messages`, and calls again until the model answers without tool calls. Returns `{ conversation, call }`. |
| `record-call` | `after` | `recordCall` | Writes `{ model, system, systemChars, tools, messages, at }` to `harness["@thetis/harness-core"].lastCall`, keeps the other fields under that key, and returns only `harness`. |

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

`recordCall` runs after `callModel`, so `model`, `system` and `tools` are the ones that were sent, and `messages` counts `call.messages` after the reply and any tool rounds were appended. The Context dock of the web gateway (`@thetis/ui-context`) reads this record. The step never returns `call`: that is the prefix the provider cache saw, and a record of it must not change it.

Steps declared with phase `bench` never run on an ordinary turn; `list_packages` still reports them.

## The turn context line

This package owns the line and its stripper. `TURN_CONTEXT` is the regex that matches it as a suffix (`/\n\n\[Turn context: [^\n\]]*\]$/`) and `withoutTurnContext(text)` takes it off. Anything that shows the person their own words, or matches on them, imports them from here: the web gateway strips it from the sidebar titles and previews, the skills packages from the ranking query. Code that must not depend on this package (a provider fixture, a browser file) copies the regex and says so.

## Configuration

`config.packages["@thetis/harness-core"]`:

| Key | Default | Effect |
|---|---|---|
| `turnContext` | `true` | Append the turn context line. `false` appends nothing. |
| `timeZone` | the daemon's zone | The IANA zone the line is written in, for example `Europe/Berlin`. An unknown zone falls back to `UTC`. |

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
| `src/index.ts` | `turnContext`, `systemPrompt`, `attachTools`, `callModel`, `recordCall`, the guide text, the `LastCall` type, `TURN_CONTEXT` and `withoutTurnContext`. |
| `test/harness.test.ts` | The five steps over a fake context; the loop over a scripted provider, a recording `invokeTool` and a fake package list: withheld tool honoured, unknown tool refused, cancel mid-stream and between tool calls, provider failure, a tool that throws. |

## Tests

`npm test` from the runtime root builds every package and runs `test/harness.test.ts` with `node --test`.

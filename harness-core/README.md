# @thetis/harness-core

The default harness. It builds the system prompt that tells the model where it is, how to use the tools and how to work, attaches every installed tool to the call, and records what the provider received. The prompt is policy, not a manual: package authoring is the `thetis/packages` skill and the installed packages are the `list_packages` tool, each paid for on the turns that want it. It is a `loader` package in the default `systemPackages["*"]`, so it runs in each person's fence on every turn.

## What it provides

Four pipeline steps, declared in `thetis.steps`:

| Step id | Phase | Export | What it does |
|---|---|---|---|
| `turn-context` | `history` | `turnContext` | Ends the turn's input message with `[Turn context: Monday 2026-09-21 20:40 Europe/Berlin]`, once. The line is saved with the conversation, so a later turn re-sends the message byte for byte and the prefix stays cached; the system prompt carries no clock. The web transcript hides the line; `skill_search` and the loader's ranking strip it from the query. |
| `system-prompt` | `prompt` | `systemPrompt` | Appends the guide to `call.system`: the user and the home, what is reachable, file tools against shell, the working style; one extra line when the session has a parent. The skills loader announces the skills, since it knows whether there are any. Nothing of the person's: no `THETIS.md`, no `harness.notes`, no package list, no session id. |
| `attach-tools` | `tools` | `attachTools` | Adds every tool declared by every installed package to `call.tools`. The first package with a given tool name wins. A tool with no `parameters` gets `{ type: "object", properties: {} }`. |
| `record-call` | `after` | `recordCall` | Writes `{ model, system, systemChars, tools, messages, at }` to `harness["@thetis/harness-core"].lastCall`, keeps the other fields under that key, and returns only `harness`. |

No tools, no service, no UI, no bench suites.

`recordCall` runs after the built-in provider call, so `model`, `system` and `tools` are the ones that were sent, and `messages` counts `call.messages` after the reply and any tool rounds were appended. The Context dock of the web gateway (`@thetis/ui-context`) reads this record. The step never returns `call`: that is the prefix the provider cache saw, and a record of it must not change it.

Steps declared with phase `bench` never run on an ordinary turn; `list_packages` still reports them.

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
| `package.json` | The manifest: four steps and two configuration keys. |
| `src/index.ts` | `turnContext`, `systemPrompt`, `attachTools`, `recordCall`, the guide text, the `LastCall` type. |
| `test/harness.test.ts` | The four steps over a fake context. |

## Tests

`npm test` from the runtime root builds every package and runs `test/harness.test.ts` with `node --test`.

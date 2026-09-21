# @thetis/harness-core

The default harness. It builds the system prompt that teaches the model how to extend Thetis by writing packages, attaches every installed tool to the call, and records what the provider received. It is a `loader` package in the default `systemPackages["*"]`, so it runs in each person's fence on every turn.

## What it provides

Three pipeline steps, one per phase, declared in `thetis.steps`:

| Step id | Phase | Export | What it does |
|---|---|---|---|
| `system-prompt` | `prompt` | `systemPrompt` | Appends to `call.system`: the guide (who the model is, the pipeline, how to write and install a package, and that `list_packages` in `@thetis/tool-exec` tells it what is installed), the content of `home/THETIS.md` when it exists, and `harness.notes` when it is a string. The installed packages are not written into the prompt. |
| `attach-tools` | `tools` | `attachTools` | Adds every tool declared by every installed package to `call.tools`. The first package with a given tool name wins. A tool with no `parameters` gets `{ type: "object", properties: {} }`. |
| `record-call` | `after` | `recordCall` | Writes `{ model, system, systemChars, tools, messages, at }` to `harness["@thetis/harness-core"].lastCall`, keeps the other fields under that key, and returns only `harness`. |

No tools, no service, no UI, no bench suites.

`recordCall` runs after the built-in provider call, so `model`, `system` and `tools` are the ones that were sent, and `messages` counts `call.messages` after the reply and any tool rounds were appended. The Context dock of the web gateway (`@thetis/ui-context`) reads this record. The step never returns `call`: that is the prefix the provider cache saw, and a record of it must not change it.

Steps declared with phase `bench` are left out of the package list in the prompt, because no ordinary turn runs them.

## Configuration

`config.packages["@thetis/harness-core"]` has no keys. The package reads no environment variables.

Two things under the person's control shape the prompt:

- `THETIS.md` in the home: standing notes, included in every prompt under *Your standing notes (home/THETIS.md)*.
- `harness.notes`: a string another package may put in the harness state, included under *Session notes*.

## Use

The package is installed for everyone by default. The prompt names no packages: the model calls `list_packages` (from `@thetis/tool-exec`) when it needs to know what is installed, so the list is paid for when it is wanted and not on every call.

Read what the last call received, after a turn:

```sh
thetis sessions show --user alice --session <id>
```

A package that wants a per-session note in the prompt sets it from a step; the harness picks it up on the next turn:

```js
export async function remember(ctx) {
  return { harness: { ...ctx.harness, notes: "The person prefers short answers." } };
}
```

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: three steps. |
| `src/index.ts` | `systemPrompt`, `attachTools`, `recordCall`, the guide text, the `LastCall` type. |
| `test/harness.test.ts` | The three steps over a fake context. |

## Tests

`npm test` from the runtime root builds every package and runs `test/harness.test.ts` with `node --test`.

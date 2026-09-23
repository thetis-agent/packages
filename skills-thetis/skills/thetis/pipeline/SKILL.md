---
name: pipeline
description: How one turn runs: the phases, the step contract, the three variables, validation, the provider call and tool loop, turn events, the prompt cache rules. Use when you write a step or enumerator, keep state in harness, or ask which phase, why state vanished, why the cache is cold, or what ctx holds.
metadata:
  title: The pipeline
  tags: [pipeline, turn, phases, steps, enumerator, conversation, call, harness, variables, mutations, events, prompt, cache, prefix, provider]
  related: [thetis/packages, thetis/configuration, thetis/troubleshooting]
  version: 1
---
# The pipeline

A turn is one pass through the pipeline of a session. The pipeline is a list of steps. The kernel builds the list from the configuration and the installed packages. The kernel sends each step into the fence with the three variables. The step returns new values. The kernel validates and applies them, and relays what the step emits. Every step is package code; the kernel has none of its own.

## Phases

The configuration field `phases` gives the order. The default is:

```
history -> prompt -> tools -> call -> execute -> after
```

The kernel gives no meaning to phase names. The intended use:

| Phase | Intended use |
|---|---|
| `history` | Compact, trim, or rewrite the conversation. Set `call.messages`. |
| `prompt` | Build `call.system`. Inject memory or skills. Set `call.model` or `call.params`. |
| `tools` | Attach tools to `call.tools`. |
| `call` | Steps that shape the request just before it is sent: scoping, cache hints. |
| `execute` | Make the call. The `call` step of `@thetis/harness-core` runs here: the provider request, the tool loop. |
| `after` | Read the model output. Write memory. Update `harness`. |

A step declared with `phase: "bench"` never runs on an ordinary turn. Only the bench adds that phase.

## Enumeration

The default plan: for each phase in order, for each installed package in install order, add each declared step of that phase. There is no built-in step: the model call is `@thetis/harness-core`'s `call` step, declared in phase `execute` like any other.

A package can replace the plan. Set `config.enumerator` to `{ "package": "@alice/my-enumerator", "export": "enumerate" }`. The kernel sends the operation `enumerate` into the fence with `{ session, packages, phases }`. The function returns an array of step references `{ package, export, phase? }`. Every reference must name an installed package that declares a step with that `export`. Otherwise the turn fails with the code `enumerator`.

```js
export async function enumerate(ctx) {
  const steps = [];
  for (const phase of ctx.phases) {
    for (const pkg of ctx.packages.list()) {
      for (const s of pkg.thetis.steps ?? []) if (s.phase === phase) steps.push({ package: pkg.name, export: s.export, phase });
    }
  }
  return steps;
}
```

## The step contract

```ts
type Step = (ctx: PackageStepContext) => Promise<StepResult | void>;

interface PackageStepContext {
  session: { id: string; user: string; parent?: string };
  turn: { id: string; input: Message[] };
  conversation: Message[];
  call: ProviderCall;
  harness: HarnessState;
  packages: PackageQuery;          // has(name), get(name), list(type?)
  env: StepEnv;                    // cwd, root, store, shared, exec, readFile, writeFile, invokeTool, kernel
  config: Record<string, unknown>; // config.packages[<this package>]
  emit(event: TurnEvent): void;    // streamed to whoever watches the turn; the kernel reads only usage and error
  signal: AbortSignal;             // aborted when the turn is stopped
}

type StepResult = { conversation?: Message[]; call?: ProviderCall; harness?: HarnessState };
```

Rules:

- Return only the variables you change. Return nothing to change nothing.
- Return complete values. The kernel replaces the variable. It does not merge. To add one field to `call`, return `{ call: { ...ctx.call, system: "..." } }`.
- Do not mutate `ctx` and return nothing. The kernel reads only the return value.
- The context is a copy. It crosses the fence as JSON. Functions do not survive.
- `ctx.call.messages` is empty until the `execute` phase. The `call` step fills it from the conversation. A step that sets `call.messages` replaces that copy.

## The three variables

| Variable | Type | Content |
|---|---|---|
| `conversation` | `Message[]` | The message history of the session. The input of this turn is at the end. |
| `call` | `ProviderCall` | `{ model, system?, messages, tools, params, hints? }`. |
| `harness` | `HarnessState` | A JSON object. Per-session state that packages own. |

A message is `{ role, content, toolCalls?, toolCallId?, name? }`. `role` is `system`, `user`, `assistant`, or `tool`. A tool spec in `call.tools` is `{ name, description, parameters, package, export }`.

`call.params` goes to the provider as extra request fields. `call.hints` never goes to the API. A provider reads the hint keys it understands.

## Harness keys

Keep your state under your package name as the key: `harness["@alice/memory"]`. Spread the rest: `{ harness: { ...ctx.harness, "@alice/memory": state } }`. A step that returns `harness` without the other keys deletes them. Other packages read your key by name and tolerate its absence.

`@thetis/harness-core` writes `harness["@thetis/harness-core"].lastCall`. `@thetis/prompt-cache` writes `harness["@thetis/prompt-cache"]`. The bench writes `harness["@thetis/bench"]`.

## Validation

The runner checks each result. An invalid result ends the turn with an `error` event of code `step`. The variables keep the values from before that step.

| Field | Rule |
|---|---|
| result | An object or null. |
| `conversation` | An array. Each element has a `role` of the four kinds and a string `content`. |
| `call` | An object with a string `model` and an array `messages`. `tools` becomes `[]` when it is not an array. `params` becomes `{}` when missing. |
| `harness` | An object, not an array. |

## The turn

1. The kernel creates a turn id `t_<12 hex>` and reads the installed packages.
2. `conversation` is the saved conversation plus the input. `call` is `{ model: config.model, messages: [], tools: [], params: {} }`. `harness` is the saved harness.
3. The kernel emits `turn.start` and enumerates the plan.
4. For each step: `step.start`, run, apply, `step.end`.
5. On an error: `error` with the message and the code. The loop stops.
6. Always: save `conversation` and `harness`. Emit `turn.end`.

The `call` step of `@thetis/harness-core` (phase `execute`) sends `call` through `env.kernel.providers.call`; the kernel routes it by `call.model` to the provider's fence and streams the events back, so this fence never sees the key. It repeats until the model answers without a tool call. Each tool call runs in this fence through `env.invokeTool`, with the tool package's effective configuration. The tool message is `{ role: "tool", content, toolCallId, name }`. An unknown tool name gives `error: unknown tool: <name>`, unless the name is in `call.hints.withheld`: a scoping step (`@thetis/tool-groups`) lists there the tools it took out of `call.tools`, and the step resolves such a name against `ctx.packages` and runs it. A thrown tool error gives `error: <message>`. Tool results never end the turn. The step streams `text`, `tool.call`, `tool.result`, `message` and `usage` through `ctx.emit`.

The step returns `{ conversation, call }` with the reply and the tool rounds appended to both. It does not change `harness`. A step result is atomic, so the step never throws for a provider failure: it returns the partial reply with every dangling tool call closed, emits one `error` event of code `provider`, and the `after` steps still run.

A cancelled turn ends with one `error` event of code `cancelled`: the step honours `ctx.signal`, returns the partial conversation, and the runner produces the event at the next step. Streamed text stays as a partial assistant message. The event list is in [references/turn-events.md](references/turn-events.md).

## The default harness steps

| Package | Step | Phase | Effect |
|---|---|---|---|
| `@thetis/harness-core` | `turnContext` | `history` | Ends the input message with `[Turn context: <weekday> <date> <time> <zone>]`. |
| `@thetis/harness-core` | `systemPrompt` | `prompt` | Appends the guide (where you are, working style) to `call.system`. No file of the person's and no package list: a universal skill, a project's instructions and `list_packages` carry those. |
| `@thetis/harness-core` | `attachTools` | `tools` | Adds every declared tool of every package to `call.tools`. The first package with a name wins. |
| `@thetis/prompt-cache` | `cacheHints` | `call` | Sets `call.hints.cache` and records prefix fingerprints in `harness`. |
| `@thetis/projects` | `projectPrompt`, `projectTools` | `prompt`, `call` | Adds the project section. Drops switched-off tools. |
| `@thetis/harness-core` | `call` | `execute` | The provider request and the tool loop, above. |
| `@thetis/harness-core` | `recordCall` | `after` | Writes `lastCall` to its harness key. Returns only `harness`. |

## Prompt cache rules

The provider caches the unchanged prefix of a request. The prefix is `tools -> system -> messages`. One changed byte at position N invalidates everything after N. A cached token costs about a tenth of the input price.

Keep the prefix byte-stable:

- Keep `call.system` frozen inside a session. Do not put the time, a random id, or a per-turn value into it. Per-turn context goes on the turn's input message, which is new anyway: `@thetis/harness-core` ends it with a `[Turn context: ...]` line in the `history` phase, and the line is saved so the message is re-sent unchanged.
- Do not change the tool list or the model in the middle of a conversation. Both invalidate the whole prefix.
- Append to the conversation. Do not edit or delete a message in the middle. A `history` step that must cut must cut at a stable point and keep the cut for many turns.
- Serialize deterministically. Do not build tool schemas from unordered sets.
- A subagent that copies its parent's `system` and `tools` byte for byte reads the parent's cache.
- An `after` step must not return `call`. `recordCall` is the model for this.

What breaks the prefix, as `@thetis/prompt-cache` reports it in `harness["@thetis/prompt-cache"].last.kind`:

| Kind | Cause |
|---|---|
| `head` | The model, the system prompt, or the tool list changed. |
| `rewrite` | A step changed a message at index `at`. |
| `truncate` | A step cut the history to `at` messages. |

The agent logs one line per divergence: `prompt-cache: turn 7: message 3 changed; the prefix is re-written from there`. Read the record with `thetis sessions show`. A healthy conversation shows `cache_read_tokens` close to `prompt_tokens` on every turn after the first.

## Sources

- packages/harness-core/src/index.ts
- src/kernel/pipeline/runner.ts
- src/kernel/pipeline/enumerator.ts
- src/contracts/guest.ts

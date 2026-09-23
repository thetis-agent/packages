# Turn events and message shapes

`sessions.send` returns a stream of turn events. A gateway renders them. The web page receives them on its event stream.

| Type | Fields | When |
|---|---|---|
| `turn.start` | `turn`, `session` | Before enumeration. |
| `step.start` | `step` | Before each step. |
| `step.end` | `step`, `ms` | After each step. |
| `text` | `delta` | For each text chunk from the provider. |
| `reasoning` | `delta` | For each chunk of a reasoning model's thinking. Transient: it is in no message and in no saved conversation, so nothing replays it. |
| `tool.call` | `call: { id, name, args }` | When the provider emits a tool call. |
| `tool.result` | `id`, `name`, `result` | After the tool ran. |
| `message` | `message`, `usage?` | After each assistant message is complete. `usage` repeats the last usage the provider reported. |
| `usage` | `usage` | When the provider reports token usage. |
| `stall` | `what: { kind, id, name }`, `ms` | When a tool or the model stream has produced nothing for long enough to ask about. The work is still running. Transient. |
| `nudge` | `what`, `ms`, `decision`, `by`, `why` | When a stall has been decided. Follows every `stall` for the same `what.id`, unless the work finished first. Transient. |
| `error` | `message`, `code?` | When the turn fails. At most one per turn. |
| `turn.end` | `turn`, `session` | Always, last. |

`stall` and `nudge` come from the `execute` step, `@thetis/harness-core`. A turn never kills a wait on a timer; it bounds the silence instead. When a wait goes quiet the step emits `stall` and asks the model whether to keep waiting, with the work still running, and emits `nudge` with the answer. `what.kind` is `tool` or `model`; `what.id` is the tool call id, or `<turn>#<round>` for a stream; `what.name` is the tool's name or the model id; `ms` is how long it has been quiet.

`by` is `model` when somebody answered and `rule` when nobody could be asked inside the question's own budget, and a `rule` decision is always `cancel`: an unanswered question never keeps waiting, which is what makes a stuck turn impossible. `why` says which case it was, in a sentence meant to be read. A cancelled tool also gets a `tool` message saying so, which is the only way the model learns of it; a cancelled stream ends the turn with an `error` of code `provider`. A `continue` resets the clock and lengthens the allowance, so waiting for ever is possible only as a run of deliberate decisions, each one on the stream.

The usage fields `@thetis/provider-openrouter` reports: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost`, `cache_read_tokens`, `cache_write_tokens`, `cache_read_ratio`, and `reasoning_tokens` when the model reports it.

The shapes:

```ts
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]; // assistant only
  toolCallId?: string;  // tool only
  name?: string;        // tool only
}

interface ProviderCall {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  params: Record<string, unknown>;   // passed to the provider as extra fields
  hints?: Record<string, unknown>;   // never sent to the API
}

interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  package: string;   // the package that runs the tool
  export: string;    // the export in that package
}

type TurnEventStall = { type: "stall"; what: { kind: "tool" | "model"; id: string; name: string }; ms: number };
type TurnEventNudge = {
  type: "nudge";
  what: { kind: "tool" | "model"; id: string; name: string };
  ms: number;
  decision: "continue" | "cancel";
  by: "model" | "rule";
  why: string;
};

type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call: { id: string; name: string; args: Record<string, unknown> } }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "error"; message: string };
```

The session record on disk, `<userspace>/sessions/<id>.json`:

```ts
interface SessionRecord {
  id: string;             // s_<12 hex characters>
  user: string;
  parent?: string;        // set for subagents
  createdAt: string;
  updatedAt: string;
  turns: number;
  conversation: Message[];
  harness: HarnessState;
}
```

Sources: packages/kernel/src/pipeline/runner.ts, the package that owns it, the package that owns it, packages/prompt-cache/README.md, packages/harness-core/README.md.

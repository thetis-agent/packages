# Turn events and message shapes

`sessions.send` returns a stream of turn events. A gateway renders them. The web page receives them on its event stream.

| Type | Fields | When |
|---|---|---|
| `turn.start` | `turn`, `session`, `resumed?` | Before enumeration. `resumed: { why, from }` when the turn has no input and the record was `interrupted`: the resume of turn `from`. Gateways draw the "Resumed after…" divider from it. |
| `step.start` | `step` | Before each step. |
| `step.end` | `step`, `ms` | After each step. |
| `text` | `delta` | For each text chunk from the provider. |
| `content.start` / `content.end` | `messageId`, `part` with `id` | An ordered part starts or completes. End carries the full payload. |
| `content.delta` | `messageId`, `partId`, `delta` | A JSON delta; consumers may retain just the final snapshot. |
| `extension` | `name`, `data` | A namespaced transient package event. `harness-core.retry` is the round retry: `{ phase: "waiting" \| "sending" \| "recovered" \| "exhausted", round, attempt, of, inMs?, until?, kind, reason, dropped? }`. On `waiting` the half round was thrown away, so a gateway withdraws what it drew of it. |
| `reasoning` | `delta` | For each chunk of a reasoning model's thinking. Transient: it is in no message and in no saved conversation, so nothing replays it. |
| `tool.call` | `call: { id, name, args }` | When the provider emits a tool call. |
| `tool.result` | `id`, `name`, `content`, `result` (text preview) | After the tool ran. |
| `message` | `message`, `usage?` | After each assistant message is complete. `usage` repeats the last usage the provider reported. |
| `usage` | `usage` | When the provider reports token usage. |
| `stall` | `what: { kind, id, name }`, `ms` | When a tool or the model stream has produced nothing for a while. The work is still running. A tool's stall is asked about; a model's is only reported. Transient. |
| `nudge` | `what`, `ms`, `decision`, `by`, `why` | When a tool's stall has been decided. Follows every tool `stall` for the same `what.id`, unless the work finished first. Transient. |
| `error` | `message`, `code?`, `kind?`, `retryable?` | When the turn fails. At most one per turn. `kind` is `connection`, `rate-limit`, `overloaded`, `timeout`, `credits`, `context`, `output-limit`, `filter`, `auth` or `other`; the page says the sentence that fits. |
| `yield` | `why` | The execute step stopped at a round boundary because a restart or a drained reload asked it to (`turns.yielding()`). Nothing is partial. The turn is resumed by itself. |
| `turn.end` | `turn`, `session` | Always, last. |

`stall` and `nudge` come from the `execute` step, `@thetis/harness-core`. A turn never kills a wait on a timer; it bounds the silence instead. When a tool goes quiet the step emits `stall` and asks the model whether to keep waiting, with the work still running, and emits `nudge` with the answer. When the model stream goes quiet the step emits `stall` only: the provider's own stall bound ends a dead stream, and the round is then sent again. `what.kind` is `tool` or `model`; `what.id` is the tool call id, or `<turn>#<round>` for a stream; `what.name` is the tool's name or the model id; `ms` is how long it has been quiet.

`by` is `model` when somebody answered and `rule` when nobody could be asked inside the question's own budget, and a `rule` decision is always `cancel`: an unanswered question never keeps waiting, which is what makes a stuck turn impossible. `why` says which case it was, in a sentence meant to be read. A cancelled tool also gets a `tool` message saying so, which is the only way the model learns of it. A `continue` resets the clock and lengthens the allowance, so waiting for ever is possible only as a run of deliberate decisions, each one on the stream.

The usage fields `@thetis/provider-openrouter` reports: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost`, `cache_read_tokens`, `cache_write_tokens`, `cache_read_ratio`, and `reasoning_tokens` when the model reports it.

The shapes:

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface ContentPart { id?: string; type: string; data: JsonValue }

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  id?: string;
  content: ContentPart[];
  extensions?: Record<string, JsonValue>;
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
  | { type: "content.start" | "content.end"; messageId: string; part: ContentPart & { id: string } }
  | { type: "content.delta"; messageId: string; partId: string; delta: JsonValue }
  | { type: "extension"; name: string; data: JsonValue }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call: { id: string; name: string; args: Record<string, unknown> } }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "error"; message: string; retryable?: boolean; kind?: FailureKind; status?: number; retryAfterMs?: number };
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
  turn?: { id: string; startedAt: string; input?: string; streamed?: Message[]; resumes?: number }; // while a turn runs
  interrupted?: {         // the last turn did not finish; cleared when the next one starts
    turn: string; at: string;
    error: { message: string; code?: string; kind?: FailureKind; retryable?: boolean };
    why?: "provider" | "failed" | "reload" | "restart" | "crash" | "yield";
    clean?: boolean;      // stopped at a round boundary: nothing partial
    resumes?: number;     // automatic resumes this chain already had
  };
}
```

Marks a harness writes on messages live in `message.extensions["@thetis/harness-core"]`: `{ partial: true }` on a cut assistant message, `{ notRun: true }` on a tool result written for a call that never started. They are never sent to a provider.

Sources: src/contracts/schemas/identity.ts, src/contracts/schemas/pipeline.ts, src/contracts/content.ts, src/contracts/messages.ts, src/kernel/pipeline/runner.ts, docs/content.md, packages/prompt-cache/README.md, packages/harness-core/README.md.

Text parts carry `{ type: "text", data: { text } }`; asset parts carry `{ type: "asset", data: { id, mediaType, name? } }`. Other namespaced types pass through unchanged. Use `env.kernel.assets.put` for bytes, then reference the returned ID. `sessions.complete` returns a Message; `askText` is an explicit text projection. Both accept text, one message, or a message array. Legacy strings normalize at API and persistence boundaries. Tools opt into parts with `{ type: "tool-result", content }`.

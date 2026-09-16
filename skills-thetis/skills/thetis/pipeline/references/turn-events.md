# Turn events and message shapes

`sessions.send` returns a stream of turn events. A gateway renders them. The web page receives them on its event stream.

| Type | Fields | When |
|---|---|---|
| `turn.start` | `turn`, `session` | Before enumeration. |
| `step.start` | `step` | Before each step. |
| `step.end` | `step`, `ms` | After each step. |
| `text` | `delta` | For each text chunk from the provider. |
| `tool.call` | `call: { id, name, args }` | When the provider emits a tool call. |
| `tool.result` | `id`, `name`, `result` | After the tool ran. |
| `message` | `message`, `usage?` | After each assistant message is complete. `usage` repeats the last usage the provider reported. |
| `usage` | `usage` | When the provider reports token usage. |
| `error` | `message`, `code?` | When the turn fails. At most one per turn. |
| `turn.end` | `turn`, `session` | Always, last. |

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

type ProviderEvent =
  | { type: "text"; delta: string }
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

Sources: docs/04-pipeline.md, docs/06-sessions-and-users.md, docs/07-providers.md, docs/16-prompt-cache.md.

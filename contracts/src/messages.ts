// The conversation and the provider request: what a model sees and what it answers.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  package: string;
  export: string;
}

/** The parameterized provider request. Built by steps, executed by the built-in call step. */
export interface ProviderCall {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  params: Record<string, unknown>;
  /** Provider hints, keyed by concern (for example `cache`). Never sent to the API; a provider reads the keys it understands. */
  hints?: Record<string, unknown>;
}

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "error"; message: string };

export interface ModelDescriptor {
  id: string;
  name?: string;
  provider?: string;
}

/** The models a userspace can call, and the configured default. */
export interface ModelChoices {
  model: string;
  models: ModelDescriptor[];
}

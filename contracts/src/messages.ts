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

/**
 * The line the default harness appends to a message from the person, so the model knows when it was sent:
 * `[Turn context: Monday 2026-09-21 20:40 Europe/Berlin]`, after a blank line, at the very end. Anything that shows
 * the person their own words, or matches on them, takes it off with `withoutTurnContext`.
 */
export const TURN_CONTEXT = /\n\n\[Turn context: [^\n\]]*\]$/;

/** The message text without the turn context line, if it ends with one. */
export const withoutTurnContext = (text: string): string => text.replace(TURN_CONTEXT, "");

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
  /**
   * Provider hints, keyed by concern (for example `cache`). Never sent to the API; a provider reads the keys it
   * understands. One key the kernel reads: `withheld`, the names of tools a scoping step took out of `tools`,
   * which the built-in call still honours when the model calls one by name.
   */
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

// One turn: the steps the enumerator schedules, what each step sees, what it may change, and the events a turn emits.
import type { Message, ProviderCall, ToolCall } from "./messages.js";
import type { PackageInfo } from "./packages.js";
import type { SessionInfo } from "./identity.js";

/** The package name the built-in provider call step is scheduled under. A wire constant, not a dependency. */
export const KERNEL_PACKAGE = "@thetis/kernel";
export const PROVIDER_CALL_STEP = "provider-call";

export type HarnessState = Record<string, unknown>;

/** A reference to a step the enumerator scheduled: a package export, or the kernel built-in. */
export interface StepRef {
  package: string;
  export: string;
  id?: string;
  phase?: string;
}

export interface TurnInfo {
  id: string;
  input: Message[];
}

/** What every step sees. Serialized into the fence; mutations come back as a StepResult. */
export interface StepContext {
  session: SessionInfo;
  turn: TurnInfo;
  conversation: Message[];
  call: ProviderCall;
  harness: HarnessState;
  packages: PackageInfo[];
  config: Record<string, unknown>;
}

export type StepResult = Partial<Pick<StepContext, "conversation" | "call" | "harness">>;

/** What a caller may set for one turn. */
export interface TurnOptions {
  model?: string;
}

export type TurnEvent =
  | { type: "turn.start"; turn: string; session: string }
  | { type: "step.start"; step: StepRef }
  | { type: "step.end"; step: StepRef; ms: number }
  | { type: "text"; delta: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "tool.result"; id: string; name: string; result: string }
  | { type: "message"; message: Message; usage?: Record<string, number> }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "error"; message: string; code?: string }
  | { type: "turn.end"; turn: string; session: string };

/** One turn event of one session of a person, as `sessions.watch` reports it. */
export interface WatchedTurnEvent {
  session: string;
  /** The parent session, when the session is a subagent. */
  parent?: string;
  /** On `turn.start` only: the text the turn was sent, when it was sent as text. */
  input?: string;
  /** On `turn.start` only: when the turn started. */
  startedAt?: string;
  event: TurnEvent;
}

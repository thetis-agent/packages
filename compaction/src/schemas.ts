// The names every part of this package shares: the state kept in the session harness, the configuration
// as the manifest declares it, the transient events the page watches, the round hook's arguments (a
// structural copy of harness-core's, so nothing here imports harness-core) and the UI command shapes.
import { z } from "zod";
import type { HarnessState, Message, ProviderCall, TurnEvent } from "@thetis/runtime/contracts";

/** The harness key, the extension event name and the hint export: one string for all three. */
export const NAME = "@thetis/compaction";

export const TriggerSchema = z.enum(["auto", "manual"]);
export type Trigger = z.infer<typeof TriggerSchema>;

const CompactionSchema = z.looseObject({
  at: z.string(),
  turn: z.string(),
  round: z.number().int().nonnegative(),
  /** Messages [0, cut) of the conversation are covered by the summary. */
  cut: z.number().int().nonnegative(),
  /** The cut before this compaction; 0 for the first. */
  from: z.number().int().nonnegative(),
  tokensBefore: z.number().nonnegative(),
  tokensAfter: z.number().nonnegative(),
  cost: z.number().optional(),
  model: z.string(),
  ms: z.number().nonnegative(),
  /** How many conversation messages this compaction summarized (cut - from). */
  messages: z.number().int().nonnegative(),
  trigger: TriggerSchema,
});
export type Compaction = z.infer<typeof CompactionSchema>;

export const LedgerRowSchema = z.looseObject({
  at: z.string(),
  kind: z.enum(["compact", "reset", "failed"]),
  trigger: TriggerSchema,
  cut: z.number().int().nonnegative(),
  from: z.number().int().nonnegative(),
  tokensBefore: z.number().nonnegative().optional(),
  tokensAfter: z.number().nonnegative().optional(),
  cost: z.number().optional(),
  model: z.string().optional(),
  reason: z.string().optional(),
});
export type LedgerRow = z.infer<typeof LedgerRowSchema>;

/** Kept under `harness["@thetis/compaction"]`. The conversation itself is never edited. */
export const CompactionStateSchema = z.looseObject({
  version: z.literal(1),
  cut: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  compactions: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  last: CompactionSchema.optional(),
  lastFailure: z.looseObject({ at: z.string(), reason: z.string() }).optional(),
  /**
   * When the projection last changed: a compaction or a reset. A provider count taken before this moment
   * describes a history that is no longer what is sent, so `measure` falls back to the estimate. `last.at`
   * would do for compactions, but a reset has no `last` of its own and changes the projection just as much.
   */
  projectedAt: z.string().optional(),
  ledger: z.array(LedgerRowSchema),
});
export type CompactionState = z.infer<typeof CompactionStateSchema>;

export const LEDGER_LIMIT = 20;

export function freshState(): CompactionState {
  return { version: 1, cut: 0, summary: null, compactions: 0, failures: 0, ledger: [] };
}

/** The state as the harness holds it, or a fresh one when the key is missing or unreadable. */
export function readState(harness: HarnessState | Record<string, unknown> | undefined): CompactionState {
  const parsed = CompactionStateSchema.safeParse(harness?.[NAME]);
  return parsed.success ? parsed.data : freshState();
}

/** The manifest's `thetis.config`, with the defaults the manifest states. Read once per step or hook call. */
export const ConfigSchema = z.looseObject({
  enabled: z.boolean().default(true),
  threshold: z.number().positive().max(1).default(0.75),
  window: z.number().int().positive().default(200_000),
  windows: z.record(z.string(), z.number().int().positive()).default({}),
  keepTokens: z.number().int().nonnegative().default(20_000),
  minShedTokens: z.number().int().nonnegative().default(20_000),
  summaryModel: z.string().optional(),
  summaryMaxTokens: z.number().int().positive().default(16_000),
  summaryTimeoutMs: z.number().int().positive().default(240_000),
  maxFailures: z.number().int().positive().default(3),
});
export type Config = z.infer<typeof ConfigSchema>;

export function readConfig(raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : ConfigSchema.parse({});
}

/** A manual request written by the dock, consumed at the start of the next turn. Kept in the home as `compaction/requests/<session>.json`. */
export const RequestSchema = z.looseObject({
  at: z.string(),
  instructions: z.string().optional(),
  reset: z.boolean().optional(),
});
export type Request = z.infer<typeof RequestSchema>;

/** What the page sees on the live stream: `{ type: "extension", name: NAME, data: CompactionEvent }`. */
export const CompactionEventSchema = z.looseObject({
  phase: z.enum(["planning", "summarizing", "finished", "failed", "skipped", "reset"]),
  trigger: TriggerSchema,
  used: z.number().nonnegative(),
  window: z.number().positive(),
  threshold: z.number().positive(),
  cut: z.number().int().nonnegative().optional(),
  from: z.number().int().nonnegative().optional(),
  messages: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  detail: z.string(),
  tokensAfter: z.number().nonnegative().optional(),
  cost: z.number().optional(),
  ms: z.number().nonnegative().optional(),
});
export type CompactionEvent = z.infer<typeof CompactionEventSchema>;

/**
 * What harness-core hands `beforeRound` between tool rounds. A structural copy of harness-core's
 * `RoundHookArgs`: the two packages agree on a shape, not on an import.
 */
export interface RoundHookArgs {
  conversation: Message[];
  call: ProviderCall;
  harness: HarnessState;
  round: number;
  usage?: Record<string, number>;
  priced: number;
  turn: { id: string };
  emit: (event: TurnEvent) => void;
}
export interface RoundHookResult {
  call?: { messages: Message[] };
  harness?: HarnessState;
}

/** The dock's view of one conversation, answered by the `compaction-state` command. */
export interface StateView {
  enabled: boolean;
  model: string;
  window: number;
  threshold: number;
  trigger: number;
  used: number;
  estimated: boolean;
  usedAt?: string;
  state: CompactionState;
  pending: Request | null;
  status: "idle" | "running";
  turns: number;
  sentence: string;
}

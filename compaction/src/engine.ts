// The one code path the step, the round hook and a manual request share: `decide` says whether to compact
// and where, `run` does it and answers with the new state. Nothing here throws; every failure is a state
// row and an event, because a compaction that fails must never fail the turn it was trying to save.
import type { Message, ProviderCall, TurnEvent } from "@thetis/runtime/contracts";
import { NAME, LEDGER_LIMIT, type CompactionEvent, type CompactionState, type Config, type LedgerRow, type Trigger } from "./schemas.js";
import { chooseCut, dangling, estimate, shed as shedOf } from "./select.js";
import { project } from "./project.js";
import { summarize, summaryRequest, type ProviderCallFn } from "./summarize.js";

/** How many rounds must pass after a compaction before another may run in the same turn. */
export const THRASH_ROUNDS = 3;

/** Everything a decision and a run need, gathered once by the caller (the step or the hook). */
export interface Situation {
  conversation: Message[];
  call: ProviderCall;
  state: CompactionState;
  config: Config;
  used: number;
  estimated: boolean;
  window: number;
  turn: { id: string };
  /** 1 at the start of a turn; the loop's `nth` between rounds. */
  round: number;
  emit: (event: TurnEvent) => void;
  providers: { call: ProviderCallFn };
  signal?: AbortSignal;
  /** Present when a manual request is being honoured: compact whatever the size, with this focus. */
  manual?: { instructions?: string };
  now?: () => Date;
}

export type Decision =
  | { kind: "skip"; why: string; trigger: Trigger; /** True when the page should hear about it (paused, thrashing). */ announce: boolean; /** True when the skip counts against the failure budget (thrashing). */ failure: boolean }
  | { kind: "compact"; trigger: Trigger; cut: number; used: number; threshold: number; window: number; shed: number };

export function triggerOf(config: Pick<Config, "threshold">, window: number): number {
  return Math.floor(window * config.threshold);
}

/**
 * Whether to compact now. Auto compaction runs when it is on, the request is at the trigger, a cut exists
 * that leaves the kept tail, the cut sheds enough to be worth breaking the prompt cache, the failure budget
 * is not used up, and a compaction did not just happen in this turn. A manual request skips the size and
 * pause checks: the person asked, and asking is how a paused conversation tries again.
 */
export function decide(s: Situation): Decision {
  const threshold = triggerOf(s.config, s.window);
  const trigger: Trigger = s.manual ? "manual" : "auto";
  const skip = (why: string, announce = false, failure = false): Decision => ({ kind: "skip", why, trigger, announce, failure });
  if (!s.manual) {
    if (!s.config.enabled) return skip("auto compaction is off");
    if (s.used < threshold) return skip("below the trigger");
    if (s.state.failures >= s.config.maxFailures) return skip(`paused after ${s.state.failures} failed attempts`, true);
    const last = s.state.last;
    if (last && last.turn === s.turn.id && s.round - last.round < THRASH_ROUNDS) {
      const ago = s.round - last.round;
      return skip(`compacted ${ago} ${ago === 1 ? "round" : "rounds"} ago; refusing to thrash`, true, true);
    }
  }
  if (dangling(s.conversation)) return skip("the last assistant message has tool calls without results", s.manual !== undefined);
  const cut = chooseCut(s.conversation, s.state.cut, s.config.keepTokens);
  if (cut === undefined) return skip("nothing older than the kept tail", s.manual !== undefined);
  const shed = shedOf(s.conversation, s.state, cut);
  if (!s.manual && shed < s.config.minShedTokens) return skip("the shed would be smaller than minShedTokens");
  return { kind: "compact", trigger, cut, used: s.used, threshold, window: s.window, shed };
}

function extension(s: Situation, data: CompactionEvent): TurnEvent {
  // Undefined optional fields are dropped: the event crosses as JSON and a page's schema need not allow them.
  const clean: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data)) if (typeof value === "string" || typeof value === "number") clean[key] = value;
  return { type: "extension", name: NAME, data: clean };
}

function ledgerWith(ledger: LedgerRow[], row: LedgerRow): LedgerRow[] {
  return [...ledger, row].slice(-LEDGER_LIMIT);
}

/** The state after a failed attempt: one more consecutive failure, the reason kept, the projection unchanged. */
export function recordFailure(state: CompactionState, at: string, trigger: Trigger, cut: number, reason: string, model?: string): CompactionState {
  return {
    ...state,
    failures: state.failures + 1,
    lastFailure: { at, reason },
    ledger: ledgerWith(state.ledger, { at, kind: "failed", trigger, cut, from: state.cut, reason, ...(model ? { model } : {}) }),
  };
}

/** The state after a reset: nothing summarized, the failure budget fresh, the ledger remembering it happened. */
export function resetState(state: CompactionState, at: string): CompactionState {
  const { last: _last, lastFailure: _lastFailure, ...rest } = state;
  return { ...rest, cut: 0, summary: null, failures: 0, projectedAt: at, ledger: ledgerWith(state.ledger, { at, kind: "reset", trigger: "manual", cut: 0, from: state.cut }) };
}

/**
 * Runs one compaction to the decided cut and answers with the new state. Emits `planning` before the
 * request, `summarizing` when it is out, then exactly one of `finished` or `failed`. A summary that is not
 * smaller than what it replaces is a failure too: sending it would make the next request larger, not smaller.
 */
export async function run(s: Situation, decision: Extract<Decision, { kind: "compact" }>): Promise<CompactionState> {
  const now = s.now ?? (() => new Date());
  const at = now().toISOString();
  const base = { trigger: decision.trigger, used: s.used, window: s.window, threshold: s.config.threshold, cut: decision.cut, from: s.state.cut, messages: decision.cut - s.state.cut };
  const request = summaryRequest(s.conversation, s.state, decision.cut, s.call, s.config, s.manual?.instructions);
  const model = request.model;
  s.emit(extension(s, { ...base, phase: "planning", model, detail: `summarizing ${base.messages} messages (≈${decision.shed} tokens) with ${model}` }));
  s.emit(extension(s, { ...base, phase: "summarizing", model, detail: `the summary request is out (${request.messages.length} messages)` }));
  const outcome = await summarize(request, s.providers, s.config.summaryTimeoutMs, s.signal);
  const fail = (reason: string, ms: number): CompactionState => {
    s.emit(extension(s, { ...base, phase: "failed", model, ms, detail: reason }));
    return recordFailure(s.state, at, decision.trigger, decision.cut, reason, model);
  };
  if (!outcome.ok) return fail(outcome.reason, outcome.ms);
  const summaryTokens = estimate(outcome.summary);
  if (summaryTokens >= decision.shed) return fail(`the summary was not smaller than what it replaces (${summaryTokens} ≥ ${decision.shed} tokens)`, outcome.ms);

  const next: CompactionState = { ...s.state, cut: decision.cut, summary: outcome.summary, failures: 0, compactions: s.state.compactions + 1, projectedAt: at };
  delete next.lastFailure;
  // The provider count adjusted by the estimated difference, so before and after are comparable numbers.
  const tokensAfter = Math.max(0, estimate(project(s.conversation, next)) + (s.used - estimate(project(s.conversation, s.state))));
  const compaction = {
    at, turn: s.turn.id, round: s.round, cut: decision.cut, from: s.state.cut, tokensBefore: s.used, tokensAfter,
    ...(outcome.cost !== undefined ? { cost: outcome.cost } : {}), model, ms: outcome.ms, messages: base.messages, trigger: decision.trigger,
  };
  next.last = compaction;
  next.ledger = ledgerWith(s.state.ledger, {
    at, kind: "compact", trigger: decision.trigger, cut: decision.cut, from: s.state.cut, tokensBefore: s.used, tokensAfter, model,
    ...(outcome.cost !== undefined ? { cost: outcome.cost } : {}),
  });
  s.emit(extension(s, { ...base, phase: "finished", model, tokensAfter, cost: outcome.cost, ms: outcome.ms, detail: `${base.messages} earlier messages summarized (${s.used} → ${tokensAfter} tokens)` }));
  return next;
}

/**
 * Decide, then run or announce. The state comes back changed only by a compaction, a counted skip
 * (thrashing) or a failure; a quiet skip returns the very same object, so a caller can tell nothing happened.
 */
export async function compactIfDue(s: Situation): Promise<{ state: CompactionState; decision: Decision }> {
  const decision = decide(s);
  if (decision.kind === "compact") return { state: await run(s, decision), decision };
  let state = s.state;
  if (decision.announce) {
    s.emit(extension(s, { phase: "skipped", trigger: decision.trigger, used: s.used, window: s.window, threshold: s.config.threshold, detail: decision.why }));
  }
  if (decision.failure) state = recordFailure(state, (s.now ?? (() => new Date()))().toISOString(), decision.trigger, state.cut, decision.why);
  return { state, decision };
}

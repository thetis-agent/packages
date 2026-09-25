// The package's exports: the `call`-phase step, the round hook harness-core calls between tool rounds, and
// the three UI commands the Compaction dock uses. Each gathers a Situation and hands it to the engine; the
// step alone reads the manual request, because a request is consumed at the start of a turn and nowhere else.
import { z } from "zod";
import type { PackageStepContext, StepResult, ToolEnv, UiCommandEnv, UiCommandResult } from "@thetis/runtime/contracts";
import {
  NAME, RequestSchema, readConfig, readState,
  type CompactionState, type Config, type Request, type RoundHookArgs, type RoundHookResult, type StateView,
} from "./schemas.js";
import { project } from "./project.js";
import { descriptorsFor, measure, measureRound, readLastCall, windowFor, type Measure } from "./measure.js";
import { compactIfDue, resetState, triggerOf, type Situation } from "./engine.js";

export { NAME, readState, readConfig, freshState, CompactionStateSchema, ConfigSchema, RequestSchema, CompactionEventSchema } from "./schemas.js";
export type { CompactionState, Config, Request, CompactionEvent, RoundHookArgs, RoundHookResult, StateView, LedgerRow, Compaction } from "./schemas.js";
export { estimate, boundaries, chooseCut, shed, dangling } from "./select.js";
export { project, note, projectedIndex } from "./project.js";
export { windowFor, measure, measureRound, descriptorsFor, forgetDescriptors, readLastCall } from "./measure.js";
export { SUMMARY_INSTRUCTIONS, summaryRequest, summarize, extractSummary, instructionsWith } from "./summarize.js";
export { decide, run, compactIfDue, recordFailure, resetState, triggerOf, THRASH_ROUNDS } from "./engine.js";

const REQUEST_LIMIT = 4000;

/**
 * Where a manual request waits: one small file under the person's home, `compaction/requests/<session>.json`.
 * A file rather than `env.storage()`, because the dock's command runs under the gateway's environment and
 * the step under this package's, and the two see different storage namespaces; the home is the one place
 * both read and write the same path. The env has no unlink, so a consumed request is an empty file.
 */
function requestPath(session: string): string {
  // Session ids are kernel-issued; check at the filesystem boundary as well, since the id becomes a path.
  if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("invalid session id");
  return `compaction/requests/${session}.json`;
}

/** A pending request, or nothing: a missing, empty or unreadable file is not a request either. */
async function readRequest(env: Pick<ToolEnv, "readFile">, session: string): Promise<Request | undefined> {
  try {
    const raw = await env.readFile(requestPath(session));
    if (!raw.trim()) return undefined;
    return RequestSchema.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
}

async function deleteRequest(env: Pick<ToolEnv, "writeFile">, session: string): Promise<void> {
  try {
    await env.writeFile(requestPath(session), "");
  } catch (err) {
    console.error(`compaction: could not consume the request of ${session}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The step. It always answers with the projection as `call.messages` and, when auto compaction is on, the
 * `beforeRound` hint that harness-core reads between tool rounds; the state goes back under this package's
 * key whether or not it changed. Turning the setting off leaves an existing summary projected: a 700k-token
 * history must not go out unannounced because a switch was flipped. It never throws: a failure inside is a
 * console line and an unchanged state, because the turn matters more than the compaction.
 */
export async function compact(ctx: PackageStepContext): Promise<StepResult> {
  const config = readConfig(ctx.config);
  let state = readState(ctx.harness);
  try {
    const request = await readRequest(ctx.env, ctx.session.id);
    const descriptors = await descriptorsFor(ctx.env);
    const window = windowFor(ctx.call.model, config, descriptors);
    if (request) await deleteRequest(ctx.env, ctx.session.id);
    if (request?.reset) {
      const from = state.cut;
      state = resetState(state, new Date().toISOString());
      const measured = measure(project(ctx.conversation, state), ctx.call.model, state, readLastCall(ctx.harness));
      ctx.emit({ type: "extension", name: NAME, data: { phase: "reset", trigger: "manual", used: measured.used, window, threshold: config.threshold, from, cut: 0, detail: `the full history is sent again (${from} messages were summarized)` } });
    }
    const measured = measure(project(ctx.conversation, state), ctx.call.model, state, readLastCall(ctx.harness));
    const situation: Situation = {
      conversation: ctx.conversation, call: ctx.call, state, config, used: measured.used, estimated: measured.estimated, window,
      turn: { id: ctx.turn.id }, round: 1, emit: ctx.emit, providers: ctx.env.kernel.providers, signal: ctx.signal,
      ...(request && !request.reset ? { manual: { instructions: request.instructions } } : {}),
    };
    // A reset is a person asking for the full history: it goes out at least once, so the automatic check
    // waits for the next turn (the round hook still guards a turn that then grows past the window).
    if (!request?.reset) state = (await compactIfDue(situation)).state;
  } catch (err) {
    console.error(`compaction: the step failed and the turn goes on unchanged: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result(ctx, config, state);
}

function result(ctx: PackageStepContext, config: Config, state: CompactionState): StepResult {
  const hints = config.enabled ? { ...(ctx.call.hints ?? {}), beforeRound: { package: NAME, export: "beforeRound" } } : ctx.call.hints;
  return {
    call: { ...ctx.call, messages: project(ctx.conversation, state), ...(hints === undefined ? {} : { hints }) },
    harness: { ...ctx.harness, [NAME]: state },
  };
}

/**
 * The round hook: harness-core calls it before every completion after the first, with the loop's live
 * conversation, call and harness. The previous round's provider count plus what the loop appended since is
 * the size of the next request. Answers with nothing when nothing changed, so the loop goes on untouched.
 */
export async function beforeRound(args: RoundHookArgs, env: ToolEnv): Promise<RoundHookResult | void> {
  try {
    const config = readConfig(env.config);
    const state = readState(args.harness);
    const measured: Measure = measureRound(args.call.messages, args.usage, args.priced);
    const window = windowFor(args.call.model, config, await descriptorsFor(env));
    const situation: Situation = {
      conversation: args.conversation, call: args.call, state, config, used: measured.used, estimated: measured.estimated, window,
      turn: args.turn, round: args.round, emit: args.emit, providers: env.kernel.providers, signal: env.signal,
    };
    const { state: next } = await compactIfDue(situation);
    if (next === state) return;
    return { call: { messages: project(args.conversation, next) }, harness: { ...args.harness, [NAME]: next } };
  } catch (err) {
    console.error(`compaction: the round hook failed and the round goes on unchanged: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
}

// ---- UI commands -------------------------------------------------------------------------------------------

const SessionArgsSchema = z.looseObject({ session: z.string().min(1).optional() });
const RequestArgsSchema = SessionArgsSchema.extend({ instructions: z.string().max(REQUEST_LIMIT).optional() });

function sessionOf(args: Record<string, unknown>, env: UiCommandEnv): string {
  const parsed = SessionArgsSchema.safeParse(args);
  const session = parsed.success ? parsed.data.session ?? env.session : env.session;
  if (!session) throw new Error("no conversation is open");
  return session;
}

/** "730k", "21k", "1.2M", "850": tokens as a person reads them. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  // One decimal under ten thousand, so 1,520 reads "1.5k" here and in the page rather than "2k" in one place and "1.5k" in the other.
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The one plain sentence the dock leads with; the most pressing thing first. */
export function sentenceFor(view: Omit<StateView, "sentence">, config: Pick<Config, "maxFailures">): string {
  const pct = (n: number) => `${Math.round((n / Math.max(1, view.window)) * 100)}%`;
  if (view.pending?.reset) return "The full history is sent again from the start of the next message.";
  if (view.pending) return "A compaction is requested and runs at the start of the next message.";
  const { state } = view;
  if (!view.enabled) {
    return state.summary
      ? "Auto compaction is off for this package (Control panel → Packages → compaction); the existing summary is still sent."
      : "Auto compaction is off for this package (Control panel → Packages → compaction).";
  }
  if (state.failures >= config.maxFailures) {
    const reason = state.lastFailure?.reason ?? "no reason recorded";
    return `Auto compaction is paused after ${state.failures} failed attempts: ${reason}. Request a compaction to try again.`;
  }
  if (state.cut > 0 && state.summary && state.last) {
    const l = state.last;
    const times = state.compactions === 1 ? "once" : `${state.compactions} times`;
    const cost = l.cost !== undefined ? `, $${l.cost.toFixed(2)}` : "";
    return `${state.cut} messages are summarized (compacted ${times}, last ${fmtClock(l.at)}, ${l.trigger}, ${fmtTokens(l.tokensBefore)} → ${fmtTokens(l.tokensAfter)} tokens${cost}).`;
  }
  return `Auto compaction is on; the conversation is at ${pct(view.used)} of the window and compacts at ${pct(view.trigger)}.`;
}

/** `compaction-state`: everything the dock and the chip draw, for the conversation on screen. */
export async function uiState(args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const session = sessionOf(args, env);
  const record = await env.kernel.sessions.inspect(session);
  const config = readConfig(env.config);
  const state = readState(record.harness);
  const lastCall = readLastCall(record.harness);
  const descriptors = await descriptorsFor(env);
  let model = lastCall?.model ?? "";
  if (!model) {
    try {
      model = (await env.kernel.models()).model ?? "";
    } catch {
      model = "";
    }
  }
  const window = windowFor(model, config, descriptors);
  const conversation = Array.isArray(record.conversation) ? record.conversation : [];
  const measured = measure(project(conversation, state), model, state, lastCall);
  const pending = (await readRequest(env, session)) ?? null;
  const view: Omit<StateView, "sentence"> = {
    enabled: config.enabled, model, window, threshold: config.threshold, trigger: triggerOf(config, window),
    used: measured.used, estimated: measured.estimated, ...(measured.usedAt ? { usedAt: measured.usedAt } : {}),
    state, pending, status: record.status ?? "idle", turns: record.turns ?? 0,
  };
  return { data: { ...view, sentence: sentenceFor(view, config) } satisfies StateView };
}

async function putRequest(env: UiCommandEnv, session: string, request: Request): Promise<UiCommandResult> {
  await env.writeFile(requestPath(session), JSON.stringify(request));
  return { data: { pending: request } };
}

/** `compaction-request`: compact at the start of the next message, whatever the size, with an optional focus. Replaces a pending reset. */
export async function uiRequest(args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const session = sessionOf(args, env);
  const parsed = RequestArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error(`invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const instructions = parsed.data.instructions?.trim();
  return putRequest(env, session, { at: new Date().toISOString(), ...(instructions ? { instructions } : {}) });
}

/** `compaction-reset`: send the full history again from the next message. Replaces a pending request. */
export async function uiReset(args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const session = sessionOf(args, env);
  return putRequest(env, session, { at: new Date().toISOString(), reset: true });
}

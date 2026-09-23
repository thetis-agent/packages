import { assertJson, contentText, normalizeContent, textContent, textPart, toolContent } from "@thetis/runtime/lib/content";
import { ContentStream } from "@thetis/runtime/lib/content-stream";
// The default harness: a system prompt of where the model is and how to work, a step that attaches every
// installed tool, and the loop that sends the call and runs what the model asks for. Skills are the loader's
// to announce: it knows whether there are any. The prompt carries no manual and no per-tool advice: a tool's
// contract is its description, how to write a package is the `thetis/packages` skill, and the installed
// packages are a tool (`list_packages` in @thetis/tool-exec), each paid for on the turns that want it.
// The prompt names no session id, so a subagent's prompt is byte-identical to its parent's apart from one
// line, and the provider cache the parent warmed serves the child.
import type { HarnessState, Message, PackageInfo, PackageStepContext, ProviderCall, ProviderEvent, StepResult, ToolCall, ToolSpec, TurnEvent } from "@thetis/runtime/contracts";
import { ContextRecorder } from "./context.js";
import { z } from "zod";
import { LastCallSchema, type LastCall } from "./schemas.js";
export type { LastCall } from "./schemas.js";

/** The key this package keeps its per-session state under; other packages read it by name. */
const NAME = "@thetis/harness-core";

/**
 * The turn context line `turnContext` ends each input with, as a suffix match. Anything that shows the
 * person their own words, or matches on them, takes it off with `withoutTurnContext`. This package owns
 * the line and its stripper: a package that must not depend on it (a provider fixture, a browser file)
 * copies the regex and says so.
 */
export const TURN_CONTEXT = /\n\n\[Turn context: [^\n\]]*\]$/;

export const withoutTurnContext = (text: string): string => text.replace(TURN_CONTEXT, "");

/** The time zone the turn context is written in: the configured one, else the process's. */
function zoneOf(config: Record<string, unknown>): string {
  const z = typeof config.timeZone === "string" && config.timeZone.trim() ? config.timeZone.trim() : Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    Intl.DateTimeFormat("en-GB", { timeZone: z });
    return z;
  } catch {
    return "UTC";
  }
}

/** `Monday 2026-09-21 18:40 Europe/Berlin`, from a date and a zone. Exported for the tests. */
export function turnContextLine(at: Date, zone: string): string {
  const part = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...opts }).format(at);
  const [day, month, year] = part({ year: "numeric", month: "2-digit", day: "2-digit" }).split("/");
  const time = part({ hour: "2-digit", minute: "2-digit", hour12: false }).replace(/^24/, "00");
  return `[Turn context: ${part({ weekday: "long" })} ${year}-${month}-${day} ${time} ${zone}]`;
}

/**
 * history: the date and time, on the turn's own input and nowhere else. The system prompt is frozen for the
 * cache, and the input message is new every turn, so this is the one place a per-turn fact costs nothing.
 * The line stays in the saved conversation: a later turn re-sends this message byte for byte, which is
 * what keeps the prefix cached. The web transcript hides the line when it draws the row.
 */
export async function turnContext(ctx: PackageStepContext): Promise<StepResult | void> {
  if (ctx.config?.turnContext === false) return;
  const conversation = ctx.conversation;
  let i = conversation.length - 1;
  while (i >= 0 && conversation[i].role !== "user") i--;
  if (i < 0 || TURN_CONTEXT.test(contentText(conversation[i].content))) return;
  const line = turnContextLine(new Date(), zoneOf(ctx.config ?? {}));
  const input = { ...conversation[i], content: [...normalizeContent(conversation[i].content), textPart(`\n\n${line}`)] };
  return { conversation: [...conversation.slice(0, i), input, ...conversation.slice(i + 1)] };
}

/**
 * prompt: the guide, and nothing of the person's: standing text in every prompt is a universal skill, per-project text is
 * the project's instructions, and both are shown, linted and capped where they live.
 */
export async function systemPrompt(ctx: PackageStepContext): Promise<StepResult> {
  return { call: { ...ctx.call, system: [ctx.call.system, GUIDE(ctx)].filter(Boolean).join("\n\n") } };
}

/** tools: attach every tool declared by installed tool packages. */
export async function attachTools(ctx: PackageStepContext): Promise<StepResult> {
  const tools: ToolSpec[] = [...ctx.call.tools];
  for (const pkg of ctx.packages.list()) {
    for (const t of pkg.thetis.tools ?? []) {
      if (tools.some((x) => x.name === t.name)) continue;
      tools.push({ name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} }, package: pkg.name, export: t.export });
    }
  }
  return { call: { ...ctx.call, tools } };
}

/**
 * after: preserve the latest request summary captured by `callModel`. Another execute step may have
 * made the call without recording it; retain the legacy summary in that case. Only `harness` comes back:
 * the request itself must not be changed by recording it.
 */
export async function recordCall(ctx: PackageStepContext): Promise<StepResult> {
  const recorded = LastCallSchema.safeParse(ownState(ctx.harness).lastCall).data;
  if (recorded?.turn === ctx.turn.id) return { harness: ctx.harness };
  const system = ctx.call.system ?? "";
  const lastCall: LastCall = {
    model: ctx.call.model,
    system,
    systemChars: system.length,
    tools: ctx.call.tools.map((t) => t.name),
    messages: ctx.call.messages.length,
    at: new Date().toISOString(),
  };
  return { harness: { ...ctx.harness, [NAME]: { ...ownState(ctx.harness), lastCall } } };
}

const STOPPED = "the turn was stopped before this tool ran";
const FAILED = "the turn failed before this tool ran";

// ---- the nudge ----
//
// The rule the whole of this section exists to keep:
//
//   Every wait is bounded, and every bound ends in a decision. Continuing to wait is a decision somebody
//   made, never a default that nobody chose.
//
// A turn waits on two things that can take any length of time and give no sign either way: the model's
// stream, and a tool. Neither can be put on a deadline, because a deadline cannot tell a twenty-minute build
// from a wedged socket, and killing the first to be safe from the second is how a turn that had done an
// hour of work came to be thrown away whole.
//
// So nothing here is killed on a timer. What is bounded is the silence. When a wait has produced nothing for
// long enough to be worth a question, the turn says so (`stall`) and asks the model, while the work goes on
// running: keep waiting, or cancel this one piece. The answer is a `nudge` event, and it says who decided.
//
// The question is itself a wait, so it is bounded too -- in time and in attempts -- and this is the part that
// makes being stuck impossible: **a nudge that cannot be answered cancels.** Not "waits a bit longer", not
// "tries for ever": cancels. Every path out of a stall reaches a decision, and only one of the two decisions
// is "keep waiting", and that one can only be reached by somebody actually choosing it. A `continue` resets
// the clock, so the next silence asks again, with a longer fuse. Waiting for ever remains possible, but only
// as an unbroken series of deliberate decisions, each one of them on the page.

/** The numbers. Exported so the manifest, the README and the tests cannot quietly disagree with the code. */
export const NUDGE_DEFAULTS = {
  /** A model that has sent no text, no reasoning and no tool call for this long is worth a question. */
  modelStallMs: 60_000,
  /** A tool that has been running this long without returning is worth a question. Builds and test runs live here. */
  toolStallMs: 120_000,
  /** What the silence allowance is multiplied by after each `continue`: the second question comes later than the first. */
  stallBackoff: 2,
  /** The longest the allowance grows to, however many times it was continued. */
  stallMaxMs: 900_000,
  /** How long one attempt at asking may take before it counts as unanswered. */
  nudgeMs: 30_000,
  /** How many attempts the question gets. When they are used up, the rule cancels. */
  nudgeAttempts: 2,
} as const;

export interface NudgeConfig {
  modelStallMs: number;
  toolStallMs: number;
  stallBackoff: number;
  stallMaxMs: number;
  nudgeMs: number;
  nudgeAttempts: number;
  /** The model the question is put to. Unset means the turn's own. */
  nudgeModel?: string;
}

/** A positive finite number, or undefined. A configured `0` is not a way to switch a bound off; nothing is. */
const positive = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);

export function nudgeConfig(config: Record<string, unknown>): NudgeConfig {
  const model = config.nudgeModel;
  return {
    modelStallMs: positive(config.modelStallMs) ?? NUDGE_DEFAULTS.modelStallMs,
    toolStallMs: positive(config.toolStallMs) ?? NUDGE_DEFAULTS.toolStallMs,
    stallBackoff: Math.max(1, positive(config.stallBackoff) ?? NUDGE_DEFAULTS.stallBackoff),
    stallMaxMs: positive(config.stallMaxMs) ?? NUDGE_DEFAULTS.stallMaxMs,
    nudgeMs: positive(config.nudgeMs) ?? NUDGE_DEFAULTS.nudgeMs,
    nudgeAttempts: Math.max(1, Math.floor(positive(config.nudgeAttempts) ?? NUDGE_DEFAULTS.nudgeAttempts)),
    nudgeModel: typeof model === "string" && model.trim() ? model.trim() : undefined,
  };
}

type Watched = { kind: "tool" | "model"; id: string; name: string };
type Decision = { decision: "continue" | "cancel"; by: "model" | "rule"; why: string };
type Cancelled = { ms: number; by: "model" | "rule"; why: string };

/** `4m 12s`, `45s`. Written for the model and for a person, in one wording used everywhere. */
export function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The tool the question is answered with. It is never run: `callModel` reads the `tool_call` event and
 * throws the call away, so `package` and `export` are here only because a ToolSpec has them.
 */
const DECIDE: ToolSpec = {
  name: "decide",
  description: "Say whether the quiet work keeps running or is cancelled. Call this exactly once, and say nothing else.",
  parameters: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["continue", "cancel"], description: "`continue` leaves it running and asks again after a longer silence. `cancel` stops this one piece of work; the turn goes on without it." },
      why: { type: "string", description: "One short sentence, for a person watching and for the agent whose work this is. Say what you think is happening." },
    },
    required: ["decision", "why"],
  },
  package: NAME,
  export: "decide",
};

const NUDGE_SYSTEM = `You are deciding one thing about an agent's turn that is running right now. Something it started has gone quiet and nobody can tell whether it is working or wedged. It is still running while you read this, and it keeps running unless you say otherwise.

Call \`decide\` exactly once. Judge it on whether the work plausibly takes this long: a build, a test run, a large download or a model thinking hard can be silent for minutes; a read of a small file cannot. Prefer \`continue\` when the silence fits the work, and \`cancel\` when it does not, or when it has already been continued several times and nothing has changed.

There is no third answer, and there is no way to ask for more. If you do not answer, the work is cancelled, because waiting must be something somebody chose.`;

/** What the deciding model is told. Short on purpose: it must be cheap and fast, and the turn's own prompt may be enormous. */
function question(what: Watched, quiet: number, continued: number, args: Record<string, unknown> | undefined, asked: string): string {
  const lines =
    what.kind === "tool"
      ? [`The tool \`${what.name}\` has been running for ${fmtMs(quiet)} and has returned nothing.`, args && Object.keys(args).length ? `It was called with: ${clip(safeJson(args), 600)}` : ""]
      : [`The model \`${what.name}\` has sent nothing for ${fmtMs(quiet)}: no text, no reasoning, no tool call. The request is open.`];
  if (continued) lines.push(`This has already been continued ${continued === 1 ? "once" : `${continued} times`}.`);
  if (asked) lines.push(`The turn was asked to: ${clip(asked, 400)}`);
  lines.push("Keep waiting, or cancel it?");
  return lines.filter(Boolean).join("\n");
}

/** The arguments as text, or a note that they could not be written: the question must not fail over them. */
const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "(arguments that could not be written down)";
  }
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The last thing the person said this turn, without the turn context line: why the work is being done at all. */
function lastAsk(conversation: Message[]): string {
  for (let i = conversation.length - 1; i >= 0; i--) if (conversation[i].role === "user") return withoutTurnContext(contentText(conversation[i].content)).trim();
  return "";
}

/**
 * Reads a decision out of one answer. The tool call is the way it is meant to arrive; the text scan is
 * there because a small model told to use a tool sometimes just writes the word. Where the text is
 * ambiguous the first of the two words wins, which is deterministic and, when it is wrong, wrong towards
 * cancelling -- the direction that cannot leave anybody stuck.
 */
export function readDecision(text: string, calls: ToolCall[]): Decision | undefined {
  for (const c of calls) {
    if (c.name !== DECIDE.name) continue;
    const decision = String((c.args as { decision?: unknown })?.decision ?? "").toLowerCase();
    const why = String((c.args as { why?: unknown })?.why ?? "").trim();
    if (decision === "continue" || decision === "cancel") return { decision, by: "model", why: why || `the model said ${decision} and gave no reason` };
  }
  const word = /\b(continue|cancel)\b/i.exec(text);
  if (!word) return undefined;
  const decision = word[1].toLowerCase() as "continue" | "cancel";
  return { decision, by: "model", why: clip(text.replace(/\s+/g, " ").trim(), 300) || `the model wrote ${decision}` };
}

/**
 * Puts the question, bounded in time and in attempts, and answers with a decision whatever happens. There is
 * no path out of here that is not a decision: a refusal, a timeout, an unreadable answer and a used-up
 * attempt count all land on `cancel` by `rule`, and the `why` says which it was in words a person can read.
 */
async function askAbout(ctx: PackageStepContext, cfg: NudgeConfig, what: Watched, quiet: number, continued: number, args?: Record<string, unknown>): Promise<Decision> {
  const call: ProviderCall = {
    model: cfg.nudgeModel || ctx.call.model,
    system: NUDGE_SYSTEM,
    messages: [{ role: "user", content: textContent(question(what, quiet, continued, args, lastAsk(ctx.conversation))) }],
    tools: [DECIDE],
    params: {},
  };
  let last = "the question was never answered";
  for (let attempt = 1; attempt <= cfg.nudgeAttempts; attempt++) {
    if (ctx.signal.aborted) return { decision: "cancel", by: "rule", why: "the turn was stopped while the question was out" };
    const own = new AbortController();
    const bound = AbortSignal.any([ctx.signal, own.signal]);
    const timer = setTimeout(() => own.abort(), cfg.nudgeMs);
    timer.unref?.();
    let text = "";
    const calls: ToolCall[] = [];
    let failure: string | undefined;
    try {
      await untilAborted(
        bound,
        ctx.env.kernel.providers.call(
          call,
          (e: ProviderEvent) => {
            if (e.type === "text") text += e.delta;
            else if (e.type === "tool_call") calls.push(e.call);
            else if (e.type === "error") failure = e.message;
          },
          bound,
        ),
      );
    } catch (err) {
      failure = ctx.signal.aborted ? "the turn was stopped" : isCancelled(err) ? `no answer within ${fmtMs(cfg.nudgeMs)}` : errorMessage(err);
    } finally {
      clearTimeout(timer);
    }
    if (ctx.signal.aborted) return { decision: "cancel", by: "rule", why: "the turn was stopped while the question was out" };
    if (failure === undefined) {
      const read = readDecision(text, calls);
      if (read) return read;
      last = "the answer named neither continue nor cancel";
    } else last = failure;
  }
  return { decision: "cancel", by: "rule", why: `nobody could be asked whether to keep waiting (${last}, after ${cfg.nudgeAttempts} ${cfg.nudgeAttempts === 1 ? "attempt" : "attempts"}), and an unanswered question cancels rather than waits` };
}

/** A watch on one wait. `touch` is a sign of life; `give_up` is what a cancel does to the work itself. */
interface Watch {
  touch(): void;
  stop(): void;
  /** Set once, when a nudge decided to cancel this wait. */
  cancelled?: Cancelled;
}

/**
 * Watches one wait and asks about it when it goes quiet. The timer here never ends anything by itself: all
 * it can do is start the question. `stop()` makes a question already in flight moot, which is the ordinary
 * case -- most stalls end because the work finished while somebody was being asked about it.
 */
function watch(ctx: PackageStepContext, cfg: NudgeConfig, what: Watched, giveUp: () => void, args?: Record<string, unknown>): Watch {
  let last = Date.now();
  let allowance = what.kind === "model" ? cfg.modelStallMs : cfg.toolStallMs;
  let continued = 0;
  let asking = false;
  let stopped = false;
  const self: Watch = {
    touch: () => {
      last = Date.now();
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };

  /** Streams an event and swallows whatever the listener does with it. A watcher is not a place to fail from. */
  const say = (event: TurnEvent): void => {
    try {
      ctx.emit(event);
    } catch {
      // Whoever is watching the turn has gone. The decision still has to be made and acted on.
    }
  };

  /** Acts on one decision, once. Called with a model's answer, or with the rule's when there was none. */
  const settle = (read: Decision): void => {
    if (stopped) return; // the work finished while the question was out: the answer is about something over
    say({ type: "nudge", what, ms: Date.now() - last, ...read });
    if (read.decision === "cancel") {
      self.cancelled = { ms: Date.now() - last, by: read.by, why: read.why };
      self.stop();
      giveUp();
      return;
    }
    continued += 1;
    last = Date.now();
    allowance = Math.min(cfg.stallMaxMs, Math.round(allowance * cfg.stallBackoff));
    asking = false;
  };

  /** What the rule decides when the question could not even be put. Always a cancel; never a longer wait. */
  const unaskable = (err: unknown): Decision => ({
    decision: "cancel",
    by: "rule",
    why: `the question could not even be put (${errorMessage(err)}), and a question that cannot be asked cancels rather than waits`,
  });

  // Nothing in this callback may throw. An exception out of a timer is not a failed turn, it is a dead
  // process; and an exception that merely escaped the asking would leave `asking` true for ever, which is
  // the unbounded wait this whole section exists to make impossible. Both roads end in a decision instead.
  const timer = setInterval(() => {
    if (stopped || asking || Date.now() - last < allowance) return;
    asking = true;
    try {
      say({ type: "stall", what, ms: Date.now() - last });
      void askAbout(ctx, cfg, what, Date.now() - last, continued, args).then(settle, (err) => settle(unaskable(err)));
    } catch (err) {
      settle(unaskable(err));
    }
  }, Math.max(10, Math.min(1000, Math.floor(allowance / 4))));
  timer.unref?.();
  return self;
}

/**
 * What the model is told when a nudge cancelled its tool call. This is the only way it finds out: the `nudge`
 * event goes to whoever is watching the turn, not into the conversation. So it says the four things the model
 * has to know -- that the call did not fail, how long it was silent, who decided, and that the work may still
 * be going on outside the turn -- and then says outright not to reissue it unchanged, because a model handed
 * a bare "error" reissues the same call, and the same call would stall in the same way.
 */
export function cancelledToolResult(name: string, ran: number, cancel: Cancelled): string {
  const who = cancel.by === "model" ? "the decision was to cancel it" : "the question could not be answered, so the rule cancelled it";
  return [
    `error: \`${name}\` was cancelled after running for ${fmtMs(ran)}.`,
    `It did not fail and it did not refuse anything: it produced nothing for ${fmtMs(cancel.ms)}, this turn asked whether to keep waiting, and ${who}.`,
    `Reason: ${cancel.why}.`,
    `Whatever it started may still be running outside this turn, and anything it had already changed has changed.`,
    `Do not issue the same call again unchanged: it would go quiet in the same way. Make it smaller, bound it yourself (a timeout, a narrower path, fewer results, one part of the work), or reach the same end another way.`,
    `If you are sure it only needed longer, say so in your reply instead of starting it again.`,
  ].join(" ");
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isCancelled = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === "cancelled";
const cancelled = () => Object.assign(new Error("the turn was stopped"), { code: "cancelled" });

/**
 * `work`, unless the signal aborts first: then a rejection with code `cancelled`, at once. The kernel's own
 * calls end on the signal by themselves; a tool need not, and one that keeps waiting on what it started must
 * not keep the turn open. The abandoned work goes on in this process, and its outcome is dropped.
 */
async function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  work.catch(() => {});
  if (signal.aborted) throw cancelled();
  let onAbort = () => {};
  const stop = new Promise<never>((_, fail) => {
    onAbort = () => fail(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stop]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Gives every tool call of the last assistant message a result when the turn ended before the tool ran.
 *  Only the results after that message count as answers: a provider may reuse an id across turns. */
function closeDangling(conversation: Message[], reason: string): void {
  let at = conversation.length - 1;
  while (at >= 0 && conversation[at].role !== "assistant") at--;
  const last = at >= 0 ? conversation[at] : undefined;
  if (!last?.toolCalls?.length) return;
  const answered = new Set(conversation.slice(at + 1).filter((m) => m.role === "tool").map((m) => m.toolCallId));
  for (const tc of last.toolCalls) if (!answered.has(tc.id)) conversation.push({ role: "tool", content: textContent(`error: ${reason}`), toolCallId: tc.id, name: tc.name });
}

/**
 * A tool a scoping step took out of the call and named in `hints.withheld`, resolved against what the installed
 * packages declare. Scoping is an attention and token optimisation, never a permission boundary, so a call to
 * such a tool is honoured; a tool nothing withheld, or no package declares, stays unknown.
 */
function withheldTool(call: ProviderCall, packages: readonly PackageInfo[], name: string): ToolSpec | undefined {
  const withheld = call.hints?.withheld;
  if (!Array.isArray(withheld) || !withheld.includes(name)) return undefined;
  for (const pkg of packages) {
    const t = pkg.thetis.tools?.find((x) => x.name === name);
    if (t) return { name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} }, package: pkg.name, export: t.export };
  }
  return undefined;
}

/** One request to the provider: the streamed text, the tool calls it asked for, and how it ended. */
interface Round {
  toolCalls: ToolCall[];
  usage?: Record<string, number>;
  /** The provider's `error` event, or why its stream ended. */
  failure?: string;
  cancelled?: boolean;
}

async function callOnce(ctx: PackageStepContext, call: ProviderCall, partial: ContentStream, cfg: NudgeConfig, nth: number, context: ContextRecorder): Promise<Round> {
  const round: Round = { toolCalls: [] };
  // The stream's own controller, under the turn's: a nudge can end this one request without ending the turn,
  // and everything the turn has already done is kept either way.
  const own = new AbortController();
  const bound = AbortSignal.any([ctx.signal, own.signal]);
  const watcher = watch(ctx, cfg, { kind: "model", id: `${ctx.turn.id}#${nth}`, name: call.model }, () => own.abort());
  const onEvent = (e: ProviderEvent) => {
    watcher.touch(); // any event at all is the stream alive: text, thinking, a tool call, an accounting line
    if (e.type === "request") {
      context.request(e.body, e.at);
    } else if (e.type === "text") {
      partial.text(e.delta);
      ctx.emit({ type: "text", delta: e.delta });
    } else if (e.type === "content.start" || e.type === "content.delta" || e.type === "content.end") {
      partial.accept(e);
      ctx.emit(e);
    } else if (e.type === "extension") {
      assertJson(e.data);
      ctx.emit(e);
    } else if (e.type === "reasoning") {
      // Forwarded and then forgotten. A reasoning model's thinking is worth watching while it happens, so a
      // long wait is visibly a model working rather than a stall, but it is not the answer: it never joins
      // `partial.text`, so it is in no assistant message, in no saved conversation and in nothing sent back
      // on the next turn. A gateway that redraws a record therefore redraws no thinking, which is right.
      ctx.emit({ type: "reasoning", delta: e.delta });
    } else if (e.type === "tool_call") {
      round.toolCalls.push(e.call);
      ctx.emit({ type: "tool.call", call: e.call });
    } else if (e.type === "usage") {
      round.usage = e.usage;
      context.usage(e.usage);
      ctx.emit({ type: "usage", usage: e.usage });
    } else if (e.type === "error") round.failure = e.message;
  };
  try {
    await untilAborted(bound, ctx.env.kernel.providers.call(call, onEvent, bound));
    partial.finish();
  } catch (err) {
    // Three ways out, and the order matters. The person stopping the turn wins over everything. A nudge that
    // cancelled the stream is a failure of this request, not a stop of the turn: it is reported, the text
    // streamed so far is kept, and the turn ends saying why. Anything else is the provider's own failure.
    if (ctx.signal.aborted) round.cancelled = true;
    else if (watcher.cancelled) round.failure = `the model call was cancelled after ${fmtMs(watcher.cancelled.ms)} of silence: ${watcher.cancelled.why}`;
    else if (isCancelled(err)) round.cancelled = true;
    else round.failure = errorMessage(err);
  } finally {
    watcher.stop();
  }
  return round;
}

/**
 * Runs one tool call in this fence, under the tool's package with that package's effective configuration.
 * Whatever goes wrong is the tool's result, so the model sees it; `undefined` means the turn was stopped
 * and there is no result to record. A stop does not wait for the tool: it gets the signal, and what it
 * started may go on (`shell` says so of its command), but the turn is over now.
 */
async function runTool(ctx: PackageStepContext, call: ProviderCall, tc: ToolCall, cfg: NudgeConfig): Promise<Message | undefined> {
  const spec = call.tools.find((t) => t.name === tc.name) ?? withheldTool(call, ctx.packages.list(), tc.name);
  let content: Message["content"];
  // This call's own controller, under the turn's. A nudge aborts it to cancel one tool; the turn is untouched,
  // so the model gets a result it can act on and the loop goes on.
  const own = new AbortController();
  const bound = AbortSignal.any([ctx.signal, own.signal]);
  const watcher = watch(ctx, cfg, { kind: "tool", id: tc.id, name: tc.name }, () => own.abort(), tc.args);
  const started = Date.now();
  try {
    if (!spec) throw new Error(`unknown tool: ${tc.name}`);
    // Reading the package's configuration is a round trip to the kernel, so it is inside the watch too: a
    // wait nobody is watching is the thing this whole section exists to make impossible, and "it is only a
    // config read" is exactly how one gets left out.
    const config = await untilAborted(bound, ctx.env.kernel.config.effective(spec.package));
    const raw = await untilAborted(bound, ctx.env.invokeTool(spec, tc.args, { session: ctx.session, config, signal: bound }));
    content = toolContent(raw);
  } catch (err) {
    if (ctx.signal.aborted) return undefined;
    if (watcher.cancelled) content = textContent(cancelledToolResult(tc.name, Date.now() - started, watcher.cancelled));
    else if (isCancelled(err)) return undefined;
    else content = textContent(`error: ${errorMessage(err)}`);
  } finally {
    watcher.stop();
  }
  ctx.emit({ type: "tool.result", id: tc.id, name: tc.name, content, result: contentText(content) });
  return { role: "tool", content, toolCallId: tc.id, name: tc.name };
}

/**
 * execute: send the call, append the assistant message, run what the model asked for, and loop until it stops.
 * The provider is reached through the kernel (`kernel.providers.call`), which routes to the provider's own fence:
 * this fence never sees the key. A tool runs here, in the caller's fence, under its package's effective
 * configuration. A tool the call withheld (`hints.withheld`) is resolved by name against the installed packages.
 *
 * The step never throws. A step's result is atomic, so whatever the turn did before it stopped, by cancel or by
 * failure, is returned: text streamed so far becomes a partial assistant message, and a tool call that never ran
 * gets a result saying so, so the record stays a conversation the provider will accept on the next turn. Sixteen
 * tool calls are not worth losing to one refusal. On a provider failure the step emits one `error` event of code
 * `provider` and the `after` steps still run. On a cancel it emits nothing: the kernel ends the turn with the
 * single `cancelled` error. `ctx.signal` is checked mid-stream, between tool calls, and between rounds.
 *
 * Neither of the two long waits in here -- the stream, and each tool -- is ever simply waited on. Each runs
 * under its own controller beneath `ctx.signal`, watched for silence; see "the nudge" above for what happens
 * then. A cancelled tool is a tool result the model reads and the loop goes on; a cancelled stream ends the
 * turn the way a provider failure does, keeping everything.
 */
export async function callModel(ctx: PackageStepContext): Promise<StepResult> {
  const conversation = [...ctx.conversation];
  const call: ProviderCall = { ...ctx.call, messages: ctx.call.messages.length ? [...ctx.call.messages] : [...conversation], hints: { ...ctx.call.hints, context: true } };
  const context = await ContextRecorder.open(ctx);
  const finish = async (status: "complete" | "failed" | "cancelled"): Promise<StepResult> => {
    await context.finish(status);
    // Keep the legacy summary for other inspectors, without duplicating the full request in the session.
    const { request: _request, ...lastCall } = context.lastCall ?? {};
    return { conversation, call, harness: { ...ctx.harness, [NAME]: { ...ownState(ctx.harness), lastCall } } };
  };
  let partial = new ContentStream();
  const stop = (reason: string, failure?: string): Promise<StepResult> => {
    const message = partial.message();
    if (message.content.length) conversation.push(message);
    closeDangling(conversation, reason);
    if (failure !== undefined) ctx.emit({ type: "error", message: `provider error: ${failure}`, code: "provider" });
    return finish(failure === undefined ? "cancelled" : "failed");
  };
  const cfg = nudgeConfig(ctx.config ?? {});
  for (let nth = 1; ; nth++) {
    if (ctx.signal.aborted) return stop(STOPPED);
    await context.start(call);
    const round = await callOnce(ctx, call, partial, cfg, nth, context);
    if (round.cancelled) return stop(STOPPED);
    if (round.failure !== undefined) return stop(FAILED, round.failure);
    const assistant = partial.message();
    partial = new ContentStream();
    if (round.toolCalls.length) assistant.toolCalls = round.toolCalls;
    conversation.push(assistant);
    call.messages.push(assistant);
    ctx.emit({ type: "message", message: assistant, usage: round.usage });
    if (!assistant.toolCalls?.length) break;
    for (const tc of assistant.toolCalls) {
      if (ctx.signal.aborted) return stop(STOPPED);
      const result = await runTool(ctx, call, tc, cfg);
      if (!result) return stop(STOPPED);
      conversation.push(result);
      call.messages.push(result);
    }
  }
  return finish("complete");
}

const HarnessRecordSchema = z.record(z.string(), z.unknown());

/** This package's own record in `harness`, or an empty one; whatever else it holds is kept. */
function ownState(harness: HarnessState): Record<string, unknown> {
  return HarnessRecordSchema.safeParse(harness[NAME]).data ?? {};
}

const GUIDE = (ctx: PackageStepContext) => `You are Thetis, an agent working for ${ctx.session.user} in their own workspace on this Thetis server.

## Where you are
- Home: ${ctx.env.cwd}. Relative paths resolve against it. New files go under it unless the task names a mounted directory.
- You can read and write home, read the shared directory, and reach each directory an admin has mounted for you. Nothing else on the host is visible to you. A refusal from a file tool names the roots you can reach.
- Read, edit, search, and list files with the file tools; use \`shell\` to run programs, builds, tests, and git.${
  ctx.config?.turnContext === false ? "" : "\n- Each message from the person ends with a [Turn context: ...] line that says when it was sent. It is not their words."
}${
  ctx.session.parent ? "\n- You are a subagent. Your final reply goes to the agent that spawned you, not to a person: make it complete, with paths, quoted output, and what you could not find." : ""
}

## Working style
- Lead with the answer. Keep a reply as short as the question allows: no preamble, no closing offer.
- Read before you change. Change one thing at a time. Prefer editing a file to creating one.
- Verify before you report: run it and quote the output that shows it worked. Say plainly what failed or did not run.
- Report what happened, not what you intended. Never describe an outcome you did not observe.`;

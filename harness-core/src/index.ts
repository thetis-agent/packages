// The default harness: a system prompt of where the model is and how to work, a step that attaches every
// installed tool, and the loop that sends the call and runs what the model asks for. Skills are the loader's
// to announce: it knows whether there are any. The prompt carries no manual and no per-tool advice: a tool's
// contract is its description, how to write a package is the `thetis/packages` skill, and the installed
// packages are a tool (`list_packages` in @thetis/tool-exec), each paid for on the turns that want it.
// The prompt names no session id, so a subagent's prompt is byte-identical to its parent's apart from one
// line, and the provider cache the parent warmed serves the child.
import type { HarnessState, Message, PackageInfo, PackageStepContext, ProviderCall, ProviderEvent, StepResult, ToolCall, ToolSpec } from "@thetis/contracts";

/** The key this package keeps its per-session state under; other packages read it by name. */
const NAME = "@thetis/harness-core";

/** What the provider received on the last turn, as a Context inspector shows it. */
export interface LastCall {
  model: string;
  /** The whole system prompt: it is per-session state on disk, and an inspector shows it. */
  system: string;
  systemChars: number;
  /** The names of the tools that were attached. */
  tools: string[];
  /** How many messages `call.messages` holds after the turn: the request plus the reply and any tool rounds. */
  messages: number;
  at: string;
}

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
  if (i < 0 || TURN_CONTEXT.test(conversation[i].content)) return;
  const line = turnContextLine(new Date(), zoneOf(ctx.config ?? {}));
  const input = { ...conversation[i], content: `${conversation[i].content}\n\n${line}` };
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
 * after: what the provider received this turn, kept in `harness` for a Context inspector, since nothing on the
 * event stream carries it. `callModel` returns `ctx.call` with the reply and the tool rounds appended to
 * `messages`, so `model`, `system` and `tools` here are the ones that were sent. Only `harness` comes back:
 * `call` is the prefix the provider cache saw, and a record of it must not touch it.
 */
export async function recordCall(ctx: PackageStepContext): Promise<StepResult> {
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
  for (const tc of last.toolCalls) if (!answered.has(tc.id)) conversation.push({ role: "tool", content: `error: ${reason}`, toolCallId: tc.id, name: tc.name });
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

async function callOnce(ctx: PackageStepContext, call: ProviderCall, partial: { text: string }): Promise<Round> {
  const round: Round = { toolCalls: [] };
  const onEvent = (e: ProviderEvent) => {
    if (e.type === "text") {
      partial.text += e.delta;
      ctx.emit({ type: "text", delta: e.delta });
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
      ctx.emit({ type: "usage", usage: e.usage });
    } else if (e.type === "error") round.failure = e.message;
  };
  try {
    await untilAborted(ctx.signal, ctx.env.kernel.providers.call(call, onEvent, ctx.signal));
  } catch (err) {
    if (ctx.signal.aborted || isCancelled(err)) round.cancelled = true;
    else round.failure = errorMessage(err);
  }
  return round;
}

/**
 * Runs one tool call in this fence, under the tool's package with that package's effective configuration.
 * Whatever goes wrong is the tool's result, so the model sees it; `undefined` means the turn was stopped
 * and there is no result to record. A stop does not wait for the tool: it gets the signal, and what it
 * started may go on (`shell` says so of its command), but the turn is over now.
 */
async function runTool(ctx: PackageStepContext, call: ProviderCall, tc: ToolCall): Promise<Message | undefined> {
  const spec = call.tools.find((t) => t.name === tc.name) ?? withheldTool(call, ctx.packages.list(), tc.name);
  let result: string;
  try {
    if (!spec) throw new Error(`unknown tool: ${tc.name}`);
    const config = await ctx.env.kernel.config.effective(spec.package);
    const raw = await untilAborted(ctx.signal, ctx.env.invokeTool(spec, tc.args, { session: ctx.session, config, signal: ctx.signal }));
    result = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
  } catch (err) {
    if (ctx.signal.aborted || isCancelled(err)) return undefined;
    result = `error: ${errorMessage(err)}`;
  }
  ctx.emit({ type: "tool.result", id: tc.id, name: tc.name, result });
  return { role: "tool", content: result, toolCallId: tc.id, name: tc.name };
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
 */
export async function callModel(ctx: PackageStepContext): Promise<StepResult> {
  const conversation = [...ctx.conversation];
  const call: ProviderCall = { ...ctx.call, messages: ctx.call.messages.length ? [...ctx.call.messages] : [...conversation] };
  const partial = { text: "" };
  const stop = (reason: string, failure?: string): StepResult => {
    if (partial.text) conversation.push({ role: "assistant", content: partial.text });
    closeDangling(conversation, reason);
    if (failure !== undefined) ctx.emit({ type: "error", message: `provider error: ${failure}`, code: "provider" });
    return { conversation, call };
  };
  for (;;) {
    if (ctx.signal.aborted) return stop(STOPPED);
    const round = await callOnce(ctx, call, partial);
    if (round.cancelled) return stop(STOPPED);
    if (round.failure !== undefined) return stop(FAILED, round.failure);
    const assistant: Message = { role: "assistant", content: partial.text };
    partial.text = "";
    if (round.toolCalls.length) assistant.toolCalls = round.toolCalls;
    conversation.push(assistant);
    call.messages.push(assistant);
    ctx.emit({ type: "message", message: assistant, usage: round.usage });
    if (!assistant.toolCalls?.length) break;
    for (const tc of assistant.toolCalls) {
      if (ctx.signal.aborted) return stop(STOPPED);
      const result = await runTool(ctx, call, tc);
      if (!result) return stop(STOPPED);
      conversation.push(result);
      call.messages.push(result);
    }
  }
  return { conversation, call };
}

/** This package's own record in `harness`, or an empty one; whatever else it holds is kept. */
function ownState(harness: HarnessState): Record<string, unknown> {
  const own = harness[NAME];
  return own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
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

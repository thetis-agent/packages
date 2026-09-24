// The engine: one run, step by step, against an injected kernel and fence environment. It holds no
// queue and no socket; the service hands it a run and a definition and is told of every change through
// `save` (write now) and `touch` (write soon). It never decides that a run is cancelled: when `signal`
// aborts — the person cancelled, or the service is stopping — it stops where it is, changes nothing more
// and returns, and the caller says what the run's state is.
//
// Prompt steps are ordinary turns of the person's own conversations, driven with `kernel.sessions.send`
// and the step's model as the per-turn `model`. Cost and prompt size are read from the turn's events:
// the harness emits a `usage` event for each model call and then the same numbers again on the `message`
// that call produced, so `usage` events are the one source, and a message's `usage` counts only when no
// `usage` event came before it (a harness that reports usage on the message alone).
import { fill, fillDeep, scopeOf } from "./template.js";
import { sourcesOf } from "./validate.js";
import { isProjectId } from "./definition.js";

export const DEFAULT_NUDGE = "Budget reached. Stop exploring and finish now with what you have; say plainly what is unverified.";
export const CONTINUE_MESSAGE = "Your previous turn was interrupted. Continue where you left off.";
/** A turn that fails this way is the provider's trouble, not the step's: the conversation is continued. */
export const TRANSIENT_ERROR = /provider error|no response|timed? ?out|rate.?limit|overloaded|\b(429|5\d\d)\b|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i;
export const TRANSIENT_RETRIES = 2;
export const TRANSIENT_WAIT_MS = 30_000;
/** Steps one execution may take before it is judged to be going round a cycle with no loop step in it. */
export const MAX_STEPS = 1000;
/** How long a cancelled turn is given to end on its own before the send is abandoned. */
export const GRACE_MS = 30_000;
export const ACTIVITY_KEPT = 20;

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const nowIso = () => new Date().toISOString();

/** A message's text: a string, or the text parts of a content list (`{type:"text", data:{text}}`). */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && p.type === "text" ? (typeof p.data?.text === "string" ? p.data.text : typeof p.text === "string" ? p.text : "") : ""))
    .join("");
}

/** A tool's output as text: a string as it is, a result envelope's text parts, `{ text }`, else JSON. */
export function outputText(output) {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (isObject(output)) {
    if (output.type === "tool-result" && Array.isArray(output.content)) return contentText(output.content);
    if (typeof output.text === "string") return output.text;
    if (Array.isArray(output.content)) {
      const t = contentText(output.content);
      if (t) return t;
    }
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/** `$40`, `$12.50`: how the cost cap is named in a reason. */
export const dollars = (n) => `$${Number.isInteger(n) ? n : Number(n).toFixed(2)}`;

const argsText = (args) => {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "";
  }
};

/** The last assistant message with text in a conversation, or null when the last message is not one. */
export function finishedReply(record) {
  const conv = Array.isArray(record?.conversation) ? record.conversation : [];
  const last = conv.at(-1);
  if (!last || last.role !== "assistant" || (Array.isArray(last.toolCalls) && last.toolCalls.length)) return null;
  const text = contentText(last.content);
  return text.trim() ? text : null;
}

// ---- the run ----

/**
 * Executes `run` from its current step until it ends, waits for a person, or `deps.signal` aborts.
 *
 * `deps`: `kernel` (the fence's `KernelClient`), `env` (the fence env: `cwd`, `readFile`, `writeFile`,
 * `invokeTool`), `signal`, `save(run)` (persist now, may be async), `touch(run)` (persist soon),
 * `user` (the person's id, for a tool step's session), `resume` (true when the run was left `running`
 * by a service that stopped), `graceMs`, `now()` for tests.
 */
export async function executeRun(run, definition, deps) {
  const ctx = context(run, definition, deps);
  const aborted = () => deps.signal?.aborted === true;
  run.state = "running";
  run.reason = "";
  // `retry` marks a run whose failed prompt step should continue its conversation rather than start over.
  let resume = deps.resume === true || run.resume === true;
  delete run.resume;
  if (resume) {
    // An entry left running by the stopped service belongs to the current step only if it is the last one;
    // anything else left running is stale and is closed as interrupted.
    const current = lastRunning(run, run.step);
    for (const e of run.history) {
      if (e.status === "running" && e !== current) close(ctx, e, "failed", "Interrupted by a restart.");
    }
  }
  await ctx.save();
  for (let taken = 0; ; taken++) {
    if (aborted()) return run;
    if (taken >= MAX_STEPS) return ctx.end("failed", `The run took ${MAX_STEPS} steps without finishing; the graph goes round a cycle with no loop step to bound it.`);
    const id = run.step;
    const step = definition.steps?.[id];
    if (!isObject(step)) return ctx.end("failed", `The workflow has no step "${id}"; fix the definition and retry.`);
    const runner = STEPS[step.type];
    if (!runner) return ctx.end("failed", `Step "${id}" has an unknown type ${JSON.stringify(step.type)}.`);
    let out;
    try {
      out = await runner(ctx, id, step, resume);
    } catch (e) {
      if (aborted()) return run;
      const entry = lastRunning(run, id);
      if (entry) close(ctx, entry, "failed", e?.message ?? String(e));
      out = { end: "failed", reason: `Step "${id}" failed: ${e?.message ?? String(e)}` };
    }
    resume = false;
    if (aborted() || out.end === null) return run;
    if (out.wait) {
      run.state = "waiting";
      await ctx.save();
      return run;
    }
    if (out.end) return ctx.end(out.end, out.reason ?? "");
    if (!Object.prototype.hasOwnProperty.call(definition.steps, out.goto)) {
      return ctx.end("failed", `Step "${id}" goes to "${out.goto}", which is not a step.`);
    }
    run.step = out.goto;
    await ctx.save();
  }
}

function context(run, definition, deps) {
  const now = deps.now ?? nowIso;
  const ctx = {
    run,
    definition,
    deps,
    kernel: deps.kernel,
    env: deps.env,
    now,
    scope: () => scopeOf(run),
    save: async () => {
      run.updatedAt = now();
      await deps.save?.(run);
    },
    touch: () => {
      run.updatedAt = now();
      deps.touch ? deps.touch(run) : void deps.save?.(run);
    },
    async end(state, reason) {
      run.state = state;
      run.reason = reason;
      await ctx.save();
      return run;
    },
  };
  return ctx;
}

function lastRunning(run, stepId) {
  const e = run.history.at(-1);
  return e && e.status === "running" && e.step === stepId ? e : null;
}

function begin(ctx, id, type, extra = {}) {
  const entry = { step: id, type, status: "running", startedAt: ctx.now(), ...extra };
  ctx.run.history.push(entry);
  return entry;
}

function close(ctx, entry, status, note) {
  entry.status = status;
  entry.endedAt = ctx.now();
  if (note) entry.note = note;
  if (entry.startedAt) entry.ms = Math.max(0, Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) || entry.ms || 0;
}

/** Where to go: the target, or the end the README names for a missing one. */
const route = (target, state, reason) => (typeof target === "string" && target ? { goto: target } : { end: state, reason });

// ---- one turn ----

/**
 * Sends one message and follows its events until the turn is saved. Accounting goes into `entry` (the
 * step's history line) and the run; `budget` is checked against this turn alone.
 *
 * Answers `{ kind }`: `done` (with `reply`), `breach`, `cap`, `error` (with `message`) or `aborted`.
 */
async function turn(ctx, { conversation, message, model, entry, budget, seg: carried }) {
  const { run, kernel, deps } = ctx;
  const own = new AbortController();
  const onOuter = () => own.abort();
  deps.signal?.addEventListener("abort", onOuter, { once: true });
  if (deps.signal?.aborted) own.abort();
  const cap = Number(run.costCapUsd);
  const seg = carried ?? { toolCalls: 0, tokens: 0, startedAt: Date.now() };
  seg.startedAt ??= Date.now();
  let stop = null; // "breach" | "cap"
  let failure = null;
  let reply = "";
  let usageSeen = false;
  let grace = null;
  let clock = null;

  const halt = (why) => {
    if (stop) return;
    stop = why;
    Promise.resolve()
      .then(() => kernel.sessions.cancel(conversation))
      .catch(() => {});
    grace = setTimeout(() => own.abort(), deps.graceMs ?? GRACE_MS);
    grace.unref?.();
  };

  const account = (usage) => {
    if (!isObject(usage)) return;
    const cost = Number(usage.cost);
    if (Number.isFinite(cost) && cost > 0) {
      entry.cost = round((entry.cost ?? 0) + cost);
      run.cost = round((run.cost ?? 0) + cost);
    }
    const size = Number(usage.prompt_tokens ?? usage.input_tokens);
    if (Number.isFinite(size) && size > 0) {
      seg.tokens = Math.max(seg.tokens, size);
      entry.tokens = Math.max(entry.tokens ?? 0, size);
      if (budget?.tokens && seg.tokens > budget.tokens) halt("breach");
    }
    if (Number.isFinite(cap) && cap > 0 && run.cost >= cap) halt("cap");
  };

  const onEvent = (e) => {
    if (own.signal.aborted && deps.signal?.aborted) return;
    if (!e || typeof e !== "object") return;
    switch (e.type) {
      case "tool.call": {
        entry.toolCalls = (entry.toolCalls ?? 0) + 1;
        seg.toolCalls++;
        const name = e.call?.name ?? "tool";
        entry.activity = [...(entry.activity ?? []), `${name}: ${argsText(e.call?.args).slice(0, 120)}`].slice(-ACTIVITY_KEPT);
        if (budget?.toolCalls && seg.toolCalls > budget.toolCalls) halt("breach");
        break;
      }
      case "usage":
        usageSeen = true;
        account(e.usage);
        break;
      case "message":
        if (e.message?.role === "assistant") {
          const text = contentText(e.message.content);
          if (text.trim()) reply = text;
        }
        if (e.usage && !usageSeen) account(e.usage);
        usageSeen = false;
        break;
      case "error":
        if (!stop && !failure) failure = e.message || "the turn failed without saying why.";
        break;
    }
    entry.ms = Math.max(0, Date.now() - Date.parse(entry.startedAt)) || entry.ms || 0;
    ctx.touch();
  };

  if (budget?.minutes) {
    clock = setTimeout(() => halt("breach"), Math.max(0, budget.minutes * 60_000 - (Date.now() - seg.startedAt)));
    clock.unref?.();
  }
  if (Number.isFinite(cap) && cap > 0 && run.cost >= cap) {
    deps.signal?.removeEventListener("abort", onOuter);
    clearTimeout(clock);
    return { kind: "cap", reply };
  }
  try {
    await kernel.sessions.send(conversation, message, onEvent, { model }, own.signal);
  } catch (e) {
    if (!stop && !failure) failure = e?.message ?? String(e);
  } finally {
    clearTimeout(clock);
    clearTimeout(grace);
    deps.signal?.removeEventListener("abort", onOuter);
  }
  if (deps.signal?.aborted) return { kind: "aborted", reply };
  if (stop === "cap" || (Number.isFinite(cap) && cap > 0 && run.cost >= cap)) return { kind: "cap", reply };
  if (failure) return { kind: "error", message: failure, reply, seg };
  if (stop === "breach") return { kind: "breach", reply };
  return { kind: "done", reply };
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/** Waits `ms`, or less if the run is aborted; true when the wait ran its course. */
function pause(ctx, ms) {
  const signal = ctx.deps.signal;
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(ok); };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
const capReason = (run) => `Cost cap of ${dollars(Number(run.costCapUsd))} reached`;

// ---- the steps ----

async function assignProject(ctx, session) {
  const project = ctx.definition.project;
  if (!isProjectId(project)) return;
  const { env } = ctx;
  let map = {};
  try {
    const parsed = JSON.parse(await env.readFile("projects/sessions.json"));
    if (isObject(parsed)) map = parsed;
  } catch {
    // a missing or unreadable map is an empty one
  }
  map[session] = project;
  await env.writeFile("projects/sessions.json", JSON.stringify(map, null, 2) + "\n");
}

async function waitIdle(ctx, conversation, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    let rec;
    try {
      rec = await ctx.kernel.sessions.inspect(conversation);
    } catch {
      return null;
    }
    if (rec?.status !== "running" || Date.now() >= until || ctx.deps.signal?.aborted) return rec;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function promptStep(ctx, id, step, resume) {
  const { run, kernel } = ctx;
  const scope = ctx.scope();
  const model = step.model;
  const budget = isObject(step.budget) ? step.budget : null;
  let entry = resume ? lastRunning(run, id) : null;
  let conversation = entry?.conversation ?? null;
  let message;
  let breaches = entry?.breaches ?? 0;
  let reply = "";

  if (entry && conversation) {
    // Resume: a finished turn is taken as the step's result; anything else is continued once.
    // A step retried after a failure is continued, never taken as finished: its last reply was not its result.
    const retried = entry.retried === true;
    delete entry.retried;
    const rec = await waitIdle(ctx, conversation, 0);
    const done = !retried && rec && rec.status !== "running" && !rec.turn ? finishedReply(rec) : null;
    if (done !== null) return finishPrompt(ctx, id, step, entry, conversation, done);
    if (rec?.status === "running") {
      await kernel.sessions.cancel(conversation).catch(() => {});
      await waitIdle(ctx, conversation);
    }
    message = CONTINUE_MESSAGE;
  } else {
    if (entry) close(ctx, entry, "failed", "Interrupted by a restart before its conversation opened.");
    if (Number(run.costCapUsd) > 0 && run.cost >= Number(run.costCapUsd)) return { end: "needs", reason: capReason(run) };
    const conv = step.conversation ?? "new";
    const body = fill(step.prompt, scope);
    if (conv === "new") {
      const ref = await kernel.sessions.create();
      conversation = ref?.id;
      if (typeof conversation !== "string" || !conversation) throw new Error("the kernel opened a conversation but did not say its id.");
      run.conversations.push(conversation);
      await assignProject(ctx, conversation);
      const title = fill(step.title, scope).trim();
      message = title ? `${title}\n\n${body}` : body;
      // The web page names conversations itself (its store, not the kernel's record), so the title is kept
      // here for the page to apply: see the `titles` op and ui/titles.js.
      if (title) run.titles = { ...(run.titles ?? {}), [conversation]: title.replace(/\s+/g, " ").slice(0, 120) };
    } else {
      conversation = run.vars?.[conv]?.conversation;
      if (typeof conversation !== "string" || !conversation) {
        return { end: "failed", reason: `Step "${id}" continues the conversation of "${conv}", which has not run in this run yet.` };
      }
      message = body;
    }
    entry = begin(ctx, id, "prompt", { model, conversation, toolCalls: 0, tokens: 0, cost: 0, ms: 0, breaches: 0, activity: [] });
    breaches = 0;
  }
  await ctx.save();

  let seg;
  let transient = 0;
  for (;;) {
    const out = await turn(ctx, { conversation, message, model, entry, budget, seg });
    seg = undefined;
    if (out.reply) reply = out.reply;
    if (out.kind === "aborted") return { end: null };
    if (out.kind === "cap") {
      close(ctx, entry, "failed", capReason(run));
      saveVars(ctx, id, entry, conversation, reply);
      return { end: "needs", reason: capReason(run) };
    }
    if (out.kind === "error" && TRANSIENT_ERROR.test(out.message) && transient < TRANSIENT_RETRIES) {
      // The work so far is in the conversation; losing it to a provider hiccup would throw away the step.
      transient++;
      entry.note = `Provider trouble (${out.message.slice(0, 120)}); continuing the conversation, attempt ${transient} of ${TRANSIENT_RETRIES}.`;
      await ctx.save();
      if (!(await pause(ctx, (ctx.deps.transientWaitMs ?? TRANSIENT_WAIT_MS) * transient))) return { end: null };
      await waitIdle(ctx, conversation);
      seg = out.seg;
      message = CONTINUE_MESSAGE;
      continue;
    }
    if (out.kind === "error") {
      close(ctx, entry, "failed", out.message);
      saveVars(ctx, id, entry, conversation, reply);
      return { end: "failed", reason: `Step "${id}" failed: ${out.message}` };
    }
    if (out.kind === "breach") {
      breaches++;
      entry.breaches = breaches;
      if (breaches === 1) {
        entry.note = "Budget reached; nudged to finish.";
        await ctx.save();
        const nudge = fill(step.nudge, ctx.scope()).trim();
        message = nudge || DEFAULT_NUDGE;
        continue;
      }
      close(ctx, entry, "failed", "Budget reached a second time.");
      saveVars(ctx, id, entry, conversation, reply);
      return route(step.onBreach, "needs", `Step "${id}" went over its budget twice.`);
    }
    return finishPrompt(ctx, id, step, entry, conversation, reply);
  }
}

function saveVars(ctx, id, entry, conversation, text) {
  ctx.run.vars[id] = {
    text: text ?? "",
    conversation,
    cost: entry.cost ?? 0,
    toolCalls: entry.toolCalls ?? 0,
    tokens: entry.tokens ?? 0,
    ms: entry.ms ?? 0,
  };
}

function finishPrompt(ctx, id, step, entry, conversation, reply) {
  close(ctx, entry, "done", entry.note);
  saveVars(ctx, id, entry, conversation, reply);
  return route(step.next, "needs", `Step "${id}" has no next step.`);
}

async function toolStep(ctx, id, step) {
  const { run, env, kernel, deps } = ctx;
  const entry = begin(ctx, id, "tool");
  await ctx.save();
  const args = fillDeep(isObject(step.args) ? step.args : {}, ctx.scope());
  let text = "";
  let error = "";
  try {
    const config = (await kernel.config?.effective?.(step.package)) ?? {};
    const session = { id: run.conversations[0] ?? run.id, user: deps.user || process.env.THETIS_USER || "unknown" };
    const output = await env.invokeTool({ package: step.package, export: step.export, name: step.name }, args, { session, config, signal: deps.signal });
    text = outputText(output);
    // The repository's tools answer a refusal as a string beginning `error:` rather than by throwing.
    if (/^error:/i.test(text.trimStart())) error = text.trimStart().replace(/^error:\s*/i, "");
  } catch (e) {
    if (deps.signal?.aborted) return { end: null };
    error = e?.message ?? String(e);
  }
  run.vars[id] = { text, error };
  entry.activity = [`${step.name}: ${argsText(args).slice(0, 120)}`];
  if (error) {
    close(ctx, entry, "failed", error);
    return route(step.onError, "failed", `Tool step "${id}" (${step.name}) failed: ${error}`);
  }
  close(ctx, entry, "done");
  return route(step.next, "needs", `Step "${id}" has no next step.`);
}

/** Of the listed steps, the one whose history entry finished last (by `endedAt`), or the first listed. */
function pickSource(run, sources) {
  let best = null;
  let bestAt = "";
  for (const e of run.history) {
    if (e.status !== "done" || !sources.includes(e.step) || !e.endedAt) continue;
    if (!run.vars?.[e.step]) continue;
    if (e.endedAt >= bestAt) (best = e.step), (bestAt = e.endedAt);
  }
  return best;
}

export function parseFields(text, fields) {
  const values = {};
  for (const [name, source] of Object.entries(fields ?? {})) {
    let m = null;
    try {
      m = new RegExp(source, "m").exec(text ?? "");
    } catch {
      m = null;
    }
    if (!m) continue;
    const value = m.length > 1 ? m[1] : m[0];
    if (value !== undefined) values[name] = value.trim();
  }
  return values;
}

async function parseStep(ctx, id, step) {
  const { run, definition } = ctx;
  const sources = sourcesOf(step);
  const fields = isObject(step.fields) ? step.fields : {};
  const required = Array.isArray(step.required) ? step.required : Object.keys(fields);
  const source = pickSource(run, sources) ?? "";
  const entry = begin(ctx, id, "parse", source ? { note: `Parsed ${source}.` } : {});
  await ctx.save();
  let text = source ? (run.vars[source]?.text ?? "") : "";
  let values = parseFields(text, fields);
  let missing = required.filter((n) => values[n] === undefined);

  const from = definition.steps?.[source];
  if (missing.length && typeof step.followUp === "string" && step.followUp.trim() && from?.type === "prompt" && run.vars[source]?.conversation) {
    const conversation = run.vars[source].conversation;
    Object.assign(entry, { model: from.model, conversation, toolCalls: 0, tokens: 0, cost: 0, activity: [] });
    await ctx.save();
    const out = await turn(ctx, { conversation, message: fill(step.followUp, ctx.scope()), model: from.model, entry, budget: null });
    if (out.kind === "aborted") return { end: null };
    if (out.kind === "cap") {
      close(ctx, entry, "failed", capReason(run));
      return { end: "needs", reason: capReason(run) };
    }
    if (out.kind === "error") {
      close(ctx, entry, "failed", out.message);
      return { end: "failed", reason: `Step "${id}" failed while following up on "${source}": ${out.message}` };
    }
    if (out.reply) {
      run.vars[source] = { ...run.vars[source], text: out.reply };
      text = out.reply;
      values = parseFields(text, fields);
      missing = required.filter((n) => values[n] === undefined);
    }
    entry.note = `Parsed ${source}; followed up once.`;
  }

  const saved = {};
  for (const name of Object.keys(fields)) saved[name] = values[name] ?? "";
  run.vars[id] = { ...saved, matched: missing.length ? "false" : "true", text, source };
  if (missing.length) {
    close(ctx, entry, "done", `No match for ${missing.join(", ")}.`);
    const where = source ? `the text of "${source}"` : `any of ${sources.map((s) => `"${s}"`).join(", ")}, none of which has finished`;
    return route(step.onNoMatch, "needs", `Step "${id}" could not find ${missing.join(", ")} in ${where}.`);
  }
  close(ctx, entry, "done");
  return route(step.next, "needs", `Step "${id}" has no next step.`);
}

async function branchStep(ctx, id, step) {
  const entry = begin(ctx, id, "branch");
  const value = fill(step.on, ctx.scope()).trim();
  ctx.run.vars[id] = { value };
  const cases = isObject(step.cases) ? step.cases : {};
  const target = Object.prototype.hasOwnProperty.call(cases, value) ? cases[value] : step.default;
  close(ctx, entry, "done", `Value "${value}".`);
  return route(target, "needs", `Step "${id}" has no case for "${value}" and no default.`);
}

async function loopStep(ctx, id, step) {
  const entry = begin(ctx, id, "loop");
  const count = (Number(ctx.run.vars[id]?.count) || 0) + 1;
  ctx.run.vars[id] = { count };
  const max = Number(step.max) || 0;
  if (count <= max) {
    close(ctx, entry, "done", `Pass ${count} of ${max}.`);
    return route(step.target, "needs", `Loop "${id}" has no target.`);
  }
  close(ctx, entry, "done", `Exhausted after ${max}.`);
  return route(step.exhausted, "needs", `Loop "${id}" ran its ${max} time${max === 1 ? "" : "s"} and has nowhere to go next.`);
}

async function approvalStep(ctx, id, step, resume) {
  const existing = resume ? lastRunning(ctx.run, id) : null;
  const entry = existing ?? begin(ctx, id, "approval");
  entry.note = fill(step.message, ctx.scope()) || "Waiting for your approval.";
  return { wait: true };
}

async function doneStep(ctx, id, step) {
  const entry = begin(ctx, id, "done");
  const summary = fill(step.summary, ctx.scope());
  close(ctx, entry, "done");
  return { end: "done", reason: summary };
}

async function needsStep(ctx, id, step) {
  const entry = begin(ctx, id, "needs");
  const reason = fill(step.reason, ctx.scope()) || `The run reached "${id}".`;
  close(ctx, entry, "done");
  return { end: "needs", reason };
}

const STEPS = { prompt: promptStep, tool: toolStep, parse: parseStep, branch: branchStep, loop: loopStep, approval: approvalStep, done: doneStep, needs: needsStep };

// ---- decisions from outside ----

/**
 * A person's answer to a waiting approval. Changes the run in place: saves the decision, closes the
 * step's entry, and either queues the run at the next step or ends it. The caller persists it.
 */
export function decide(run, definition, decision, note = "", now = nowIso()) {
  if (run.state !== "waiting") throw new Error(`Run ${run.id} is ${run.state}, not waiting for an approval.`);
  const step = definition.steps?.[run.step];
  if (step?.type !== "approval") throw new Error(`Run ${run.id} is not at an approval step.`);
  if (decision !== "approved" && decision !== "rejected") throw new Error('decision must be "approved" or "rejected".');
  const id = run.step;
  run.vars[id] = { decision, note: typeof note === "string" ? note : "" };
  const entry = run.history.findLast((e) => e.step === id && e.status === "running");
  if (entry) {
    entry.status = "done";
    entry.endedAt = now;
    entry.note = `${decision === "approved" ? "Approved" : "Rejected"}${note ? `: ${note}` : "."}`;
  }
  run.updatedAt = now;
  const target = decision === "approved" ? step.next : step.onReject;
  if (typeof target === "string" && target) {
    run.state = "queued";
    run.step = target;
    run.reason = "";
  } else if (decision === "approved") {
    run.state = "needs";
    run.reason = `Step "${id}" was approved but has no next step.`;
  } else {
    run.state = "cancelled";
    run.reason = `Rejected at "${id}"${note ? `: ${note}` : "."}`;
  }
  return run;
}

/** Queues an ended run again from `from` (default: the step it stopped at), keeping what it saved. */
export function retry(run, definition, from, now = nowIso()) {
  if (["queued", "running", "waiting"].includes(run.state)) throw new Error(`Run ${run.id} is ${run.state}; only an ended run can be retried. Cancel it first.`);
  const step = from ?? run.step;
  if (!definition.steps?.[step]) throw new Error(`Version ${run.version} of this workflow has no step "${step}".`);
  // Retried at the prompt step it failed in: that conversation holds the work so far, so it is continued.
  const last = run.history?.at(-1);
  if (last && last.step === step && last.type === "prompt" && last.status === "failed" && last.conversation && definition.steps[step].type === "prompt") {
    last.status = "running";
    delete last.endedAt;
    last.note = "Retried; continuing its conversation.";
    last.retried = true;
    run.resume = true;
  }
  run.state = "queued";
  run.step = step;
  run.reason = "";
  run.updatedAt = now;
  return run;
}

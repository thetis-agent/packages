// The harness writes an atomic snapshot before each call and as usage arrives. Inspect the session
// first to authorize it, then read that person's snapshot. Older sessions retain their saved summary
// and the usage already recorded by the web gateway.
//
// Nothing here may answer more than the gateway carries (256 KiB a result), and a long conversation's
// last request is megabytes. So `context` answers a summary that is bounded by construction — the
// scalars, one short row per message and per tool definition, the newest usage rows and the totals of
// all of them — and `context-page` answers the big texts (the system prompt, the whole request, one
// message, one tool definition) a page at a time, each page measured before it is sent.

/** The key `@thetis/harness-core` keeps its per-session state under. */
const HARNESS = "@thetis/harness-core";

/** What one answer may weigh, with room under the gateway's 256 KiB for the envelope around it. */
export const ANSWER_BYTES = 192 * 1024;
/** The first guess at a page, in characters; halved until the page fits `ANSWER_BYTES`. */
export const PAGE_CHARS = 64_000;
/** Usage rows sent for the per-turn ledger, newest; the totals always cover every row. */
export const USAGE_ROWS = 200;
/** Message rows sent in the summary, newest; the rest are counted. */
export const MESSAGE_ROWS = 400;
const GIST_CHARS = 120;

export async function uiContext(_args, env) {
  const { record, lastCall, status, usage } = await read(env);
  const totals = {};
  for (const row of usage) for (const [key, value] of Object.entries(row.usage ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
  }
  const data = {
    turns: record.turns, status,
    started: status === "running" || record.turns > 0 || Boolean(record.conversation?.length),
    lastCall: lastCall ? summarize(lastCall) : null,
    usage: usage.slice(-USAGE_ROWS),
    usageCount: usage.length,
    usageTotals: totals,
  };
  return { data: fit(data) };
}

/**
 * `context-page { part, index?, offset?, at? }`: one page of a big text of the last call. `part` is
 * `system` (the prompt as text), `request` (the whole request, as indented JSON), `message` or `tool`
 * (one entry by `index`, as the summary numbers them). Answers `{ at, part, index, offset, text, next,
 * total }`, where `next` is the offset of the next page or null at the end. When `at` is given and the
 * capture has been replaced since, answers `{ at, changed: true }` instead, so the page starts again
 * rather than stitching two requests together.
 */
export async function uiContextPage(args, env) {
  const { lastCall } = await read(env);
  if (!lastCall) throw new Error("No request has been captured in this conversation yet.");
  const at = lastCall.at ?? null;
  if (typeof args?.at === "string" && args.at !== at) return { data: { at, changed: true } };
  const part = typeof args?.part === "string" ? args.part : "";
  const index = Number.isInteger(args?.index) ? args.index : null;
  const whole = textOf(lastCall, part, index);
  const offset = Number.isInteger(args?.offset) && args.offset > 0 ? Math.min(args.offset, whole.length) : 0;
  let size = PAGE_CHARS;
  let text = whole.slice(offset, offset + size);
  // Measured, not assumed: escaping and multi-byte characters can make a page three times its length.
  while (size > 1024 && Buffer.byteLength(JSON.stringify(text)) > ANSWER_BYTES) {
    size = Math.floor(size / 2);
    text = whole.slice(offset, offset + size);
  }
  const end = offset + text.length;
  return { data: { at, part, index, offset, text, next: end < whole.length ? end : null, total: whole.length } };
}

async function read(env) {
  if (!env.session) throw new Error("no conversation is open");
  const record = await env.kernel.sessions.inspect(env.session);
  if (!/^[a-zA-Z0-9_-]+$/.test(env.session)) throw new Error("invalid context session id");
  const snapshot = await readJson(env, `harness-core/context/${env.session}.json`);
  const legacy = lastCallOf(record.harness);
  const captured = isRecord(snapshot?.lastCall) ? snapshot.lastCall : null;
  const lastCall = captured && (!legacy || Date.parse(captured.at) >= Date.parse(legacy.at)) ? captured : legacy;
  const status = record.status ?? "idle";
  const current = (Array.isArray(snapshot?.usage) ? snapshot.usage : []).filter(isRecord).map((entry) => ({
    ...entry,
    status: entry.status === "running" && !(status === "running" && entry.id === record.turn?.id) ? "interrupted" : entry.status,
  }));
  const gateway = await readJson(env, `gateway-web/sessions/${env.user}/${env.session}.json`);
  const before = current.length ? Math.min(...current.map((entry) => entry.firstMessage ?? 0)) : Infinity;
  const historical = historicalUsage(record.conversation ?? [], gateway?.usage, before);
  return { record, lastCall, status, usage: [...historical, ...current] };
}

/** The messages the Request view lists: the wire body's own, or the provider input with its system first. */
function shownMessages(call) {
  const body = isRecord(call.request) ? call.request : null;
  if (!body) return [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return call.format === "wire" || !body.system ? messages : [{ role: "system", content: body.system }, ...messages];
}

function textOf(call, part, index) {
  const body = isRecord(call.request) ? call.request : null;
  if (part === "system") return typeof call.system === "string" ? call.system : "";
  if (!body) throw new Error("The full request was not captured for this call.");
  if (part === "request") return json(body);
  const list = part === "message" ? shownMessages(call) : part === "tool" ? (Array.isArray(body.tools) ? body.tools : []) : null;
  if (!list) throw new Error(`There is no part called ${JSON.stringify(part)}; ask for system, request, message or tool.`);
  if (index === null || index < 0 || index >= list.length) throw new Error(`There is no ${part} ${index} in this request.`);
  return json(list[index]);
}

/** The last call without its big texts: the scalars, and one short row per message and tool definition. */
function summarize(call) {
  const out = {};
  for (const [key, value] of Object.entries(call)) if (key !== "request" && key !== "system") out[key] = value;
  if (!Number.isFinite(out.systemChars)) out.systemChars = typeof call.system === "string" ? call.system.length : 0;
  const body = isRecord(call.request) ? call.request : null;
  if (!body) return out;
  const messages = shownMessages(call).map((message, index) => {
    const calls = Array.isArray(message?.tool_calls ?? message?.toolCalls) ? message.tool_calls ?? message.toolCalls : [];
    const names = calls.map((c) => c?.function?.name ?? c?.name ?? "?");
    const reply = message?.tool_call_id ?? message?.toolCallId;
    const gist = [names.length ? `tool calls: ${names.join(", ")}` : "", reply ? `for ${reply}` : "", contentText(message?.content)].filter(Boolean).join(" · ");
    return { index, role: message?.role ?? "?", gist: cut(gist), bytes: bytes(message), cache: hasCache(message) };
  });
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((tool, index) => ({ index, name: tool?.function?.name ?? tool?.name ?? "?", bytes: bytes(tool), cache: hasCache(tool) }));
  const params = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "messages" && key !== "tools" && key !== "system"));
  out.request = { params, messages: messages.slice(-MESSAGE_ROWS), messageCount: messages.length, tools, bytes: bytes(body) };
  return out;
}

/**
 * The summary is small by construction; this is the guarantee. Anything still over the answer's weight
 * gives up its oldest message rows, then its oldest usage rows, then the request parameters, and says so.
 */
function fit(data) {
  const weight = () => Buffer.byteLength(JSON.stringify(data));
  const request = data.lastCall?.request;
  while (weight() > ANSWER_BYTES && request?.messages.length > 20) request.messages = request.messages.slice(Math.floor(request.messages.length / 2));
  while (weight() > ANSWER_BYTES && data.usage.length > 20) data.usage = data.usage.slice(Math.floor(data.usage.length / 2));
  if (weight() > ANSWER_BYTES && request) request.params = { note: "The request parameters are too large to list; open the full request." };
  return data;
}

async function readJson(env, path) {
  try { return JSON.parse(await env.readFile(path)); }
  catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

function historicalUsage(conversation, usage, before) {
  const turns = [];
  let turn;
  for (let i = 0; i < Math.min(conversation.length, before); i++) {
    if (conversation[i].role === "user") {
      turn = { id: `history-${i}`, firstMessage: i, status: "complete", calls: 0, usage: {} };
      turns.push(turn);
    }
    const reported = usage?.[i];
    if (!turn || !isRecord(reported)) continue;
    turn.calls++;
    for (const [key, value] of Object.entries(reported)) {
      if (typeof value === "number" && Number.isFinite(value) && !key.endsWith("_ratio")) turn.usage[key] = (turn.usage[key] ?? 0) + value;
    }
  }
  return turns.filter((turn) => turn.calls);
}

function lastCallOf(harness) {
  const own = isRecord(harness) ? harness[HARNESS] : null;
  const lastCall = isRecord(own) ? own.lastCall : null;
  return isRecord(lastCall) ? lastCall : null;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => typeof b === "string" ? b : b?.text ?? (b?.type === "text" ? b.data?.text : undefined) ?? `[${b?.type ?? "block"}]`).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

function hasCache(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(value.cache_control) || Object.values(value).some((child) => child && typeof child === "object" && hasCache(child));
}

const json = (value) => JSON.stringify(value, null, 2);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value) ?? "");
const cut = (value) => value.replace(/\s+/g, " ").trim().slice(0, GIST_CHARS);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

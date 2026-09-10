/* The Context inspector's fold: what the model actually received, computed from the stream alone.
 *
 * Three turn-event payloads carry all of it, and this panel reads them where they land rather than
 * asking anyone for them (see KINDS below for what the wire does and does not carry today):
 *
 *   `context`      contract/turn-events $defs/context    sections {system, skills, harness, history} + budget
 *   `model.begin`  contract/turn-events $defs/modelBegin  provider, model, and the exact request that went out,
 *                                                         as contract/provider $defs/requestEvent rows
 *   `model.end`    contract/turn-events $defs/modelEnd    the stop reason and this call's usage counters
 *
 * The legacy Context tab fetched an equivalent capture over a `debug-request` side channel, so it was
 * always one round trip behind and could show a body belonging to no particular turn. Nothing here asks
 * for anything: it is a fold, so it is current by construction, there is nothing to refuse or retry, and
 * the panel can say plainly which turn each number came from.
 *
 * No DOM: this module is the whole reading of the stream, and surface/view.js draws what it returns.
 */

export const limits = {
  /** Model calls kept per conversation for the usage ledger; older calls survive only in the totals. */
  calls: 200,
  /** Message or tool rows listed for one request; a longer request is counted rather than drawn. */
  rows: 200,
  /** Characters shown of any one message or system prompt before it is cut. */
  chars: 8000,
  /** Conversations whose context is remembered at once; the least recently touched is dropped first. */
  conversations: 16,
};

/** Every frame kind this panel folds.
 *
 * The dotted names are the contract's own event types (contract/turn-events $defs/envelope) and the
 * hyphenated ones follow the wire's convention for the kinds it already carries (`turn-finished`,
 * `tool-call`). Which of the two these payloads arrive under is gateway-web's render.ts to decide, and
 * that mapping is not written yet — nor does anything emit these onto the wire, since
 * lib/session/index.ts observes only `['token', 'output', 'end']` — so both spellings are accepted
 * rather than one of them guessed at.
 */
export const KINDS = ["context", "model-begin", "model.begin", "model-end", "model.end"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The payload of a frame, whether the wire flattened it or left it in an envelope.
 *
 * render.ts flattens every kind it maps today (`retrieve` becomes `{kind, session, entries, dropped}`),
 * but it maps none of these three, so no shape for them is fixed. Reading either costs one line. */
function fields(frame) {
  return isObject(frame["payload"]) ? frame["payload"] : frame;
}

function number(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cut(value) {
  return value.length > limits.chars ? `${value.slice(0, limits.chars)}\n…` : value;
}

export function blank() {
  return { begin: undefined, context: undefined, calls: [], totals: {}, forgotten: 0 };
}

/** The state for one conversation, keeping at most `limits.conversations` of them.
 *
 * Panels outlive tabs — the surface keeps every open conversation's frames coming — so this map is a
 * queue like every other buffer here, and the conversation being asked for is never the one evicted. */
export function forConversation(states, id) {
  const existing = states.get(id);
  if (existing) return existing;
  const state = blank();
  states.set(id, state);
  for (const key of [...states.keys()]) {
    if (states.size <= limits.conversations) break;
    if (key !== id) states.delete(key);
  }
  return state;
}

/** Folds one frame into a conversation's state. Unknown kinds and malformed payloads change nothing. */
export function apply(state, frame) {
  const value = fields(frame);
  if (frame.kind === "context") {
    if (isObject(value["sections"])) state.context = value;
    return state;
  }
  if (frame.kind === "model-begin" || frame.kind === "model.begin") {
    if (Array.isArray(value["request"])) state.begin = value;
    return state;
  }
  if (frame.kind === "model-end" || frame.kind === "model.end") return ended(state, value);
  return state;
}

function ended(state, value) {
  const usage = isObject(value["usage"]) ? value["usage"] : {};
  const counters = {};
  for (const [name, count] of Object.entries(usage)) {
    if (typeof count !== "number" || !Number.isFinite(count)) continue;
    counters[name] = count;
    state.totals[name] = (state.totals[name] ?? 0) + count;
  }
  state.calls.push({ stop: typeof value["stop"] === "string" ? value["stop"] : "", usage: counters });
  while (state.calls.length > limits.calls) {
    state.calls.shift();
    state.forgotten += 1;
  }
  return state;
}

/** Plain text of one contract/provider $defs/content part. Every member of that union is named, and
 *  a part from a later contract major is labelled by its own type rather than dropped silently. */
function partText(part) {
  if (!isObject(part)) return "";
  const type = typeof part["type"] === "string" ? part["type"] : "part";
  if (type === "text" || type === "reasoning") return typeof part["text"] === "string" ? part["text"] : `[${type}]`;
  if (type === "tool_call") return `→ ${String(part["name"] ?? "")}(${String(part["args"] ?? "")})`;
  if (type === "image" || type === "resource" || type === "artifact") return `[${type} ${String(part["path"] ?? "")}]`;
  return `[${type}]`;
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content.map(partText).filter(Boolean).join("\n");
}

function messageRow(row, index) {
  const text = contentText(row["content"]);
  return {
    index,
    role: typeof row["role"] === "string" ? row["role"] : "?",
    text: cut(text),
    chars: text.length,
    cut: text.length > limits.chars,
    cached: false,
  };
}

/** The request segment: the exact event array `model.begin` carried, read back as rows.
 *
 * `truncated` is the projection's own admission. A `model.begin` carries the whole rendered prefix and
 * history, which can be orders of magnitude larger than a token, and lib/session/batch.ts fails the
 * whole subscriber at `limits.eventBytes` rather than trimming — so a projection that has to shorten a
 * frame to fit says so on the frame, and this panel repeats it rather than presenting a partial request
 * as the exact one. Absent, it is false, which is what every frame that fits says. */
function request(begin) {
  if (!begin) return undefined;
  const rows = Array.isArray(begin["request"]) ? begin["request"] : [];
  const head = rows.find(row => isObject(row) && row["type"] === "begin") ?? {};
  const messages = [];
  const tools = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    if (row["type"] === "message") messages.push(messageRow(row, messages.length));
    else if (row["type"] === "tool") tools.push({ name: String(row["name"] ?? ""), description: String(row["description"] ?? ""), schema: row["schema"] });
  }
  const cache = isObject(head["cache"]) ? head["cache"] : {};
  const cachedThrough = number(cache["prefixThrough"], -1);
  for (const row of messages) row.cached = row.index <= cachedThrough;
  return {
    provider: String(begin["provider"] ?? ""),
    model: String(begin["model"] ?? head["model"] ?? ""),
    options: isObject(head["options"]) ? head["options"] : {},
    cachedThrough,
    messages: messages.slice(0, limits.rows),
    tools: tools.slice(0, limits.rows),
    counts: { messages: messages.length, tools: tools.length },
    hidden: Math.max(0, messages.length - limits.rows) + Math.max(0, tools.length - limits.rows),
    truncated: begin["truncated"] === true,
  };
}

/** The four sections contract/turn-events $defs/context requires, in the order the prompt renders them. */
const SECTIONS = ["system", "skills", "harness", "history"];

function group(sections, name) {
  const list = Array.isArray(sections[name]) ? sections[name].filter(isObject) : [];
  const texts = list.map(message => contentText(message["content"]));
  return {
    name,
    count: list.length,
    chars: texts.reduce((sum, text) => sum + text.length, 0),
    text: cut(texts.join("\n\n")),
  };
}

/** The prompt segment: what each section contributes, and how much of the window it leaves. */
function prompt(context) {
  if (!context) return undefined;
  const sections = isObject(context["sections"]) ? context["sections"] : {};
  const budget = isObject(context["budget"]) ? context["budget"] : {};
  const total = number(budget["window"], 0);
  const reserve = number(budget["reserve"], 0);
  const used = number(budget["used"], 0);
  const available = Math.max(0, total - reserve);
  return {
    groups: SECTIONS.map(name => group(sections, name)),
    budget: { total, reserve, used, available, share: available > 0 ? Math.min(1, used / available) : 0 },
    truncated: context["truncated"] === true,
  };
}

/** The usage segment: every counter the provider reported, summed, and the per-call ledger. */
function usage(state) {
  return {
    counters: Object.entries(state.totals).sort(([left], [right]) => left.localeCompare(right)).map(([name, total]) => ({ name, total })),
    calls: state.calls.map((call, index) => ({ n: state.forgotten + index + 1, stop: call.stop, usage: call.usage })).reverse(),
    forgotten: state.forgotten,
    count: state.forgotten + state.calls.length,
  };
}

export function describe(state) {
  return { request: request(state.begin), prompt: prompt(state.context), usage: usage(state) };
}

/* The Tools inspector's fold: everything the agent can call here, and what this mode is holding back.
 *
 * One payload carries it: `offer` (contract/turn-events $defs/offer), whose `tools` are
 * $defs/toolDef rows — name, description, schema, readOnly, endsTurn, destructive, source — and
 * whose `mode` is the $defs/offerRequest mode the turn ran under, `{readOnly, deny}`.
 *
 * What the wire cannot tell this panel, and why it says so rather than guessing:
 * packages/core/dispatcher.ts drops a tool the mode withholds *before* the offer is emitted
 * (`if (request.mode.readOnly && !tool.readOnly || request.mode.deny.includes(...)) continue`), so an
 * offer names only survivors. A withheld tool is therefore nameable from exactly two true sources —
 * the deny list, which names it outright, and this conversation's own earlier offers, which carry the
 * definition of anything that was available before the mode narrowed. Both are used; nothing else is
 * invented. A tool this conversation has never been offered cannot be named at all, and the panel says
 * that plainly instead of implying the list is complete.
 *
 * No DOM: this module is the whole reading, and surface/view.js draws what it returns.
 */

export const limits = {
  /** Tools remembered for one conversation, offered and withdrawn together; mirrors the loop's own cap. */
  tools: 256,
  /** Conversations whose offers are remembered at once; the least recently touched is dropped first. */
  conversations: 16,
};

/** Every frame kind this panel folds. `offer` is the contract's own event type, and nothing renames it
 *  on the way to the browser today because nothing carries it at all: lib/session/index.ts observes
 *  only `['token', 'output', 'end']` and gateway-web/render.ts maps no `offer` frame. Naming the
 *  contract's own type is the one choice here that cannot be wrong. */
export const KINDS = ["offer"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The payload of a frame, flattened by the wire or still in an envelope; see the note in KINDS. */
function fields(frame) {
  return isObject(frame["payload"]) ? frame["payload"] : frame;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

export function blank() {
  return { offer: undefined, seen: new Map() };
}

/** The state for one conversation, keeping at most `limits.conversations` of them; the conversation
 *  being asked for is never the one evicted. */
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

/** One contract/turn-events $defs/toolDef row, read back with only what it actually declared. */
function definition(tool) {
  return {
    name: text(tool["name"]),
    description: text(tool["description"]),
    source: text(tool["source"]),
    schema: tool["schema"],
    readOnly: tool["readOnly"] === true,
    endsTurn: tool["endsTurn"] === true,
    destructive: tool["destructive"] === true,
    derived: tool["derived"] === true,
    data: isObject(tool["data"]) ? Object.keys(tool["data"]).sort() : [],
  };
}

/** Folds one frame into a conversation's state. Unknown kinds and malformed payloads change nothing. */
export function apply(state, frame) {
  if (frame.kind !== "offer") return state;
  const value = fields(frame);
  if (!Array.isArray(value["tools"])) return state;
  const mode = isObject(value["mode"]) ? value["mode"] : {};
  const tools = value["tools"].filter(isObject).slice(0, limits.tools).map(definition).filter(tool => tool.name);
  state.offer = {
    tools,
    // Bounded like the offer itself: `deny` has no length in the contract, and it feeds both the
    // banner and the withheld rows, so it is read up to the same cap rather than trusted whole.
    mode: { readOnly: mode["readOnly"] === true, deny: Array.isArray(mode["deny"]) ? mode["deny"].filter(entry => typeof entry === "string").slice(0, limits.tools) : [] },
  };
  for (const tool of tools) {
    if (!state.seen.has(tool.name) && state.seen.size >= limits.tools) break;
    state.seen.set(tool.name, tool);
  }
  return state;
}

/** A deny entry is a bare tool name or `source/name`; the tool it withholds is the last segment. */
function denied(entry) {
  const parts = entry.split("/");
  return parts[parts.length - 1] ?? entry;
}

/** Grouped by the package that offers each tool, because that is the answer to "who is providing this". */
function grouped(tools) {
  const sources = new Map();
  for (const tool of tools) {
    const source = tool.source || "unattributed";
    const list = sources.get(source) ?? [];
    list.push(tool);
    sources.set(source, list);
  }
  return [...sources.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([source, list]) => ({ source, tools: list.slice().sort((left, right) => left.name.localeCompare(right.name)) }));
}

/** Why a named tool is not in this turn's offer. Each reading is a fact the stream actually carries. */
function withheld(offer, seen) {
  const offered = new Set(offer.tools.map(tool => tool.name));
  const rows = [];
  const named = new Set();
  for (const entry of offer.mode.deny) {
    const name = denied(entry);
    if (offered.has(name) || named.has(name)) continue;
    named.add(name);
    rows.push({ name, entry, why: "denied", tool: seen.get(name) });
  }
  for (const [name, tool] of seen) {
    if (offered.has(name) || named.has(name)) continue;
    named.add(name);
    rows.push({ name, entry: name, why: offer.mode.readOnly && !tool.readOnly ? "read-only" : "gone", tool });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export function describe(state) {
  const offer = state.offer;
  if (!offer) return { known: false, mode: { readOnly: false, deny: [] }, sources: [], withheld: [], counts: { offered: 0, sources: 0, withheld: 0 } };
  const sources = grouped(offer.tools);
  const rows = withheld(offer, state.seen);
  return {
    known: true,
    mode: offer.mode,
    sources,
    withheld: rows,
    counts: { offered: offer.tools.length, sources: sources.length, withheld: rows.length },
  };
}

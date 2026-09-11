/* The usage ledger: what a turn spent, and what this conversation has spent.
 *
 * Every number here came from the provider by way of `model.end` (contract/turn-events
 * `$defs/modelEnd`), which carries an open map of counters — `in`, `out`, `cached`, `cost` and
 * whatever else a particular provider reports. Nothing is estimated and no price table lives in this
 * surface: if a provider reported no cost, the chip shows tokens and stops there. Inventing a price
 * from a model name would be a number a person could act on and we could not stand behind.
 *
 * One turn makes as many `model.end` events as it takes round trips — a turn that calls three tools
 * makes four — so the counters are summed across the turn and drawn once, when `turn-finished`
 * arrives. Hence two shapes: a turn ledger being filled in, and the conversation total it folds into
 * when the turn ends.
 *
 * No DOM anywhere in this file, on purpose: the summing and the wording are the parts with branches
 * worth testing and neither needs a document, so `usage.test.ts` can exercise them directly the way
 * dispatch.test.ts exercises the renderer choice. An import of ./dom.js here would take that with it.
 */

/** A turn with nothing counted yet. */
export function blankTurn() {
  return { calls: 0, counters: {}, stop: "" };
}

/** A conversation with nothing counted yet. */
export function blankTotal() {
  return { turns: 0, calls: 0, counters: {} };
}

/** Both halves of one conversation's ledger, as the store holds it. */
export function blankLedger() {
  return { turn: blankTurn(), total: blankTotal() };
}

/** Adds two counter maps, keeping every name either side reported. Non-numbers are dropped rather
 *  than coerced: a provider that reports a string has reported nothing this surface can add up. */
function sum(left, right) {
  const out = { ...left };
  for (const [name, value] of Object.entries(right || {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[name] = (out[name] || 0) + value;
  }
  return out;
}

/* Stop reasons worth reading, in words rather than in the provider's vocabulary.
 *
 * `end` and `tool_calls` are ordinary — the turn either answered or went off to run a tool — and say
 * nothing. `cancel` says nothing either: the transcript already draws "Turn stopped." where the stop
 * button was pressed, and saying it twice reads like two different things happened. Anything absent
 * from this table still gets a line, carrying the provider's own word, because a reply that ended for
 * a reason nobody anticipated is exactly the case where silence is worst. */
const STOPS = {
  length: "cut off at the model's length limit",
  refusal: "the model declined to answer",
  content_filter: "stopped by the model's safety filter",
  error: "the model stopped with an error",
};

export function stopNote(stop) {
  if (typeof stop !== "string" || !stop || stop === "end" || stop === "tool_calls" || stop === "cancel") return "";
  return STOPS[stop] || `ended early — ${stop}`;
}

/** Folds one `model-end` frame into the turn in flight. The stop reason kept is the last one that
 *  was not a clean finish, because that is the one worth saying out loud. */
export function addCall(turn, usage, stop) {
  return { calls: turn.calls + 1, counters: sum(turn.counters, usage), stop: stopNote(stop) ? stop : turn.stop };
}

/** Folds a finished turn into the conversation total. */
export function addTurn(total, turn) {
  return { turns: total.turns + 1, calls: total.calls + turn.calls, counters: sum(total.counters, turn.counters) };
}

/** A token count at a glance: exact below a thousand, one decimal place above it. */
export function count(value) {
  if (!Number.isFinite(value)) return "0";
  const n = Math.round(value);
  if (n < 1000) return String(n);
  if (n < 1000000) return `${trim((n / 1000).toFixed(1))}k`;
  return `${trim((n / 1000000).toFixed(2))}M`;
}

function trim(text) {
  return text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;
}

/** Money, at enough precision to be worth printing. A turn that cost a fraction of a cent is shown
 *  to four places rather than rounded to `$0.00`, which reads as free. */
export function money(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return `$${value >= 0.01 ? value.toFixed(2) : value.toFixed(4)}`;
}

/** The chip for a finished turn, as a list of short phrases to join with separators. `end` is the
 *  `turn-finished` frame, which is where the step and summary counts come from; the tokens and the
 *  cost come from the `model.end` events summed into `turn`. Empty when there is nothing to say,
 *  which is what a turn that never reached a model looks like. */
export function turnSummary(turn, end = {}) {
  const note = stopNote(turn.stop);
  if (!turn.calls && !note) return [];
  const parts = [];
  const steps = end.iterations;
  if (Number.isFinite(steps) && steps > 0) parts.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
  const summaries = end.compactions;
  if (Number.isFinite(summaries) && summaries > 0) parts.push(`${summaries === 1 ? "summarised once" : `summarised ${summaries} times`} to save room`);
  const into = turn.counters.in;
  const out = turn.counters.out;
  if (into > 0) parts.push(`${count(into)} tokens in`);
  if (out > 0) parts.push(`${count(out)} out`);
  const cost = money(turn.counters.cost);
  if (cost) parts.push(`${cost} this turn`);
  if (note) parts.push(note);
  return parts;
}

/** The one calm line for a whole conversation, or null while there is nothing to show. `detail` is
 *  the longer reading, for a tooltip: it says plainly that the count starts when the page opens,
 *  because nothing in this wire carries a conversation's spend from before that. */
export function conversationSummary(total) {
  if (!total.calls) return null;
  const into = total.counters.in || 0;
  const out = total.counters.out || 0;
  const tokens = into + out;
  const parts = [];
  if (tokens > 0) parts.push(`${count(tokens)} tokens`);
  const cost = money(total.counters.cost);
  if (cost) parts.push(cost);
  if (!parts.length) return null;
  return {
    text: parts.join(" · "),
    detail: `${count(into)} in, ${count(out)} out over ${total.turns} ${total.turns === 1 ? "turn" : "turns"}, counted since this page opened`,
  };
}

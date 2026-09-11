/* The `load_skill` transcript rows, and the record of what this conversation has loaded.
 *
 * This is the half of the package the other two skills panels do not have. `retriever-local` and
 * `skills-all` decide for the model, so their whole story is told by the `retrieve` answer; here the
 * model decides, one call at a time, and the decision is a row in the reading order of the
 * conversation. Drawing it as a generic tool call would hide the one thing worth seeing: which skill
 * the model reached for, and whether it already had it.
 *
 * It keys off the frame kinds `render.ts` emits for a call and its answer, and returns null for every
 * tool that is not `load_skill`, so the surface's own row is still what draws the rest.
 */

import { registerRenderer, onEvent, el } from "/lib/surface.js";

/** Bounded, like every other pool here: a long conversation must not grow this without limit. */
const LIMITS = { calls: 512 };

/** Call id -> the skill that call asked for, learned when the call frame arrives. A result frame
 *  carries only an id, so without this the result row could not name its skill. */
const calls = new Map();
/** Session -> the set of skills whose level 2 reached that conversation. */
const loaded = new Map();
const watchers = [];

function link(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

/** The skill a `load_skill` frame names, or null when the frame is some other tool's. */
function named(frame) {
  if (frame.name !== "load_skill") return null;
  const name = frame.args && typeof frame.args.name === "string" ? frame.args.name : "";
  return name || null;
}

/** What this conversation has loaded so far; a live set, so the panel reads it on each redraw. */
export function loadedIn(session) {
  return loaded.get(session) ?? new Set();
}

/** Called whenever a conversation's loaded set changes, so a panel can redraw itself. */
export function watchLoads(handler) {
  watchers.push(handler);
}

function card(name, state, tone) {
  return el("div", { class: `msg is-note sl-load${tone ? ` is-${tone}` : ""}` },
    el("span", { class: "sl-load-label" }, "skill"),
    el("span", { class: "sl-load-name" }, name),
    el("span", { class: "sl-load-state" }, state));
}

link("/surface/skills-l1/panel.css");

onEvent("tool-call", (frame) => {
  const name = named(frame);
  if (!name) return;
  if (calls.size >= LIMITS.calls) calls.delete(calls.keys().next().value);
  calls.set(frame.id, { session: frame.session, name });
});

onEvent("tool-result", (frame) => {
  const call = calls.get(frame.id);
  if (!call || frame.ok === false) return;
  const set = loaded.get(call.session) ?? new Set();
  set.add(call.name);
  loaded.set(call.session, set);
  for (const handler of watchers) handler(call.session);
});

registerRenderer("tool-call", (frame) => {
  const name = named(frame);
  return name ? card(name, "loading instructions…", "running") : null;
});

registerRenderer("tool-result", (frame) => {
  const call = calls.get(frame.id);
  if (!call) return null;
  // The stage answers a repeated load with one line rather than the body again; saying so here is
  // the difference between "the model wasted a turn" and "the model already had it".
  const already = frame.ok !== false && /already loaded/.test(frame.summary || "");
  if (frame.ok === false) return card(call.name, frame.summary || "refused", "error");
  return card(call.name, already ? "already loaded" : "instructions in context", already ? "" : "on");
});

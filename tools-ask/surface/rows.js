/* The `ask_user` form as a transcript row: a question the agent asked, answered where it was asked.
 *
 * This is the one interactive thing on this surface that lives inside the conversation rather than in
 * the rail, and that is the whole point of drawing it as a contributed row. The question is a message.
 * It belongs in the reading order of the messages around it, because the sentence before it is what
 * makes it answerable. A rail tab would separate the two, and a modal would cover the part of the
 * conversation a person needs to re-read in order to reply.
 *
 * It draws from the frames the surface already has: the question is the `tool-call` frame's arguments,
 * and the name the answer travels under is that frame's own id, which is also the name the package
 * gave the call it left unfinished. The answer goes back as `reply`, one of the two verbs this package
 * declared in its own manifest; the host checks it against that list, against the signed-in role and
 * against the conversation on screen before it forwards anything (ADR 0051).
 */

import { registerRenderer, onEvent, request, el } from "/lib/surface.js";
import { form, question, WORDING } from "/surface/tools-ask/form.js";

/** Cards on screen, by the name their answer travels under, so a second frame naming the same call
 *  finds the card that was already drawn, and so a question answered in the panel can settle here. */
const cards = new Map();
const LIMITS = { cards: 256 };
const watchers = [];

function link(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

/** Called whenever a question settles, so the Questions panel can redraw without asking again. */
export function watchAnswers(handler) { watchers.push(handler); }

/** Settles the row for a question that was answered somewhere other than in it. */
export function settle(handle, state, said) {
  cards.get(handle)?.settle(state, said);
}

function card(frame, ask) {
  const status = el("span", { class: "ask-status" }, WORDING.waiting);
  // `mark` is how the chrome follows the form, whichever of the two settled first: answering here
  // runs it through the form's own callback, and answering in the panel runs it through `settle`.
  const mark = (state) => {
    status.textContent = WORDING[state] || WORDING.expired;
    node.className = `msg ask is-${state}`;
    for (const handler of watchers) handler(frame.session);
  };
  const body = form(ask, (answer) => request("reply", { conversation: frame.session, handle: frame.id, answer }), mark);
  const node = el("div", { class: "msg ask is-waiting" },
    el("div", { class: "ask-head" }, el("span", { class: "ask-mark" }, "?"), el("span", { class: "ask-title" }, "A question for you"), status),
    body.node);

  return { node, settle: (state, said) => { body.settle(state, said); } };
}

link("/surface/tools-ask/ask.css");

onEvent("tool-call", (frame) => {
  if (frame.name !== "ask_user" || cards.size < LIMITS.cards) return;
  // Oldest first: a card whose question was settled long ago is the one nothing is still pointing at.
  cards.delete(cards.keys().next().value);
});

registerRenderer("tool-call", (frame) => {
  if (frame.name !== "ask_user") return null;
  const ask = question(frame.args);
  if (!ask) return null;
  const drawn = cards.get(frame.id);
  if (drawn) return drawn.node;
  const made = card(frame, ask);
  cards.set(frame.id, made);
  return made.node;
});

/* A question draws one row, not two.
 *
 * The surface reports a call and its answer as separate frames and draws a row for each, which is
 * right for a tool that ran and came back with something. A question has not come back: the package
 * answered the call as unfinished so the turn would stop here, and everything the result frame could
 * say is already the line under the question. Returning the card the call drew declines the second row
 * without declining the frame — a contributed renderer that returns nothing falls through to the
 * surface's own tool card (lib/dispatch.js), which would draw the unfinished call as a tool that ran.
 */
registerRenderer("tool-result", (frame) => cards.get(frame.id)?.node ?? null);

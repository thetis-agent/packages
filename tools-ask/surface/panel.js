/* The Questions panel: what the agent has asked here, what was said back, and the last place a
 * question can still be answered.
 *
 * The form belongs in the transcript (rows.js says why), but a transcript scrolls and a page reloads.
 * The surface replays a conversation's saved messages, not its tool rows, so after a refresh the row
 * is gone while the question is still waiting — and a question nobody can answer any more is worse
 * than one that was never asked. So this is not only the list: a question still waiting is drawn here
 * with the same controls it had in the conversation, and answering it settles the row too when there
 * still is one.
 *
 * It reads through `asked`, one of the two verbs this package declared in its own manifest. Nothing on
 * the wire carries a question's state — the frames say a call was made and answered as unfinished, and
 * what a person said came later — so this is a question the panel could not answer by reading.
 */

import { registerPanel, onEvent, conversation, request, el, icon, section } from "/lib/surface.js";
import { form, question, WORDING } from "/surface/tools-ask/form.js";
import { settle, watchAnswers } from "/surface/tools-ask/rows.js";

/** A speech bubble with a question mark in it. */
const ASK = ["M3.5 5.2a1.7 1.7 0 0 1 1.7-1.7h9.6a1.7 1.7 0 0 1 1.7 1.7v6.1a1.7 1.7 0 0 1-1.7 1.7H8l-3.3 3v-3h-1.2Z", "M8.5 6.6a1.6 1.6 0 0 1 3 .7c0 1-1.5 1.2-1.5 2.2"];

/** The newest list read, per conversation, so a tab switch shows that tab's own questions. */
const lists = new Map();
const LIMITS = { conversations: 32 };
let reading = false;

function link(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

/** Reads this conversation's questions. Never called from `draw`: drawing must not send, or every
 *  answer would ask again. */
function refresh() {
  const session = conversation.current;
  if (reading || !session) return;
  reading = true;
  request("asked", { conversation: session })
    .then((answer) => {
      const value = JSON.parse(answer.text || "{}");
      if (lists.size >= LIMITS.conversations && !lists.has(session)) lists.delete(lists.keys().next().value);
      lists.set(session, Array.isArray(value.questions) ? value.questions : []);
      panel.redraw();
    })
    .catch((error) => { console.error("the questions asked here could not be read", error); })
    .finally(() => { reading = false; });
}

/** A question still waiting, with the controls to answer it. Answering settles the transcript row as
 *  well, when this conversation still has one, so the two never disagree on screen. */
function waitingCard(session, item) {
  const ask = question(item);
  if (!ask) return null;
  const body = form(ask, (answer) => request("reply", { conversation: session, handle: item.handle, answer })
    .then((result) => { settle(item.handle, "answered", Array.isArray(answer) ? answer.join(", ") : answer); refresh(); return result; }));
  return el("div", { class: "aq-card is-waiting" }, el("p", { class: "aq-state" }, WORDING.waiting), body.node);
}

function settledCard(item) {
  return el("div", { class: `aq-card is-${item.state}` },
    el("p", { class: "aq-question" }, item.question),
    el("p", { class: "aq-state" }, WORDING[item.state] || WORDING.expired),
    item.state === "answered" && item.answer ? el("p", { class: "aq-answer" }, item.answer) : null);
}

function draw() {
  const session = conversation.current;
  const items = (session && lists.get(session)) || [];
  if (!items.length) return { title: "Questions", items: [], empty: "The agent has not asked you anything here." };
  const waiting = items.filter((item) => item.state === "waiting");
  const done = items.filter((item) => item.state !== "waiting");
  const blocks = [];
  if (waiting.length) {
    blocks.push(section({ title: "Still waiting", count: waiting.length, note: "The agent stopped here. It reads your answer the next time you send it a message." }));
    blocks.push(...waiting.map((item) => waitingCard(session, item)));
  }
  if (done.length) {
    blocks.push(section({ title: "Already dealt with", count: done.length }));
    blocks.push(...done.map(settledCard));
  }
  return { title: "Questions", subtitle: waiting.length ? `${String(waiting.length)} waiting for you` : `${String(done.length)} asked here`, blocks };
}

link("/surface/tools-ask/ask.css");

const panel = registerPanel({
  id: "questions",
  label: "Questions",
  hint: "Questions — what the agent has asked you here, and what you said",
  icon: () => icon(ASK, { size: 17, width: 1.5 }),
  draw,
});

conversation.watch(() => { panel.redraw(); refresh(); });
// A question appears when a call draws one, and settles when the form in the transcript is used.
onEvent("tool-call", (frame) => { if (frame.name === "ask_user" && frame.session === conversation.current) refresh(); });
watchAnswers((session) => { if (session === conversation.current) refresh(); });

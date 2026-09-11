/* The question itself: what was asked, the controls for answering it, and what it says afterwards.
 *
 * Drawn in two places, which is why it is here rather than in either. The transcript row is where a
 * question is answered while it is on screen (rows.js). The panel is where it is answered after that
 * row has gone (panel.js) — the surface replays a conversation's saved messages and not its tool rows,
 * so a reload takes the form with it, and a question a person cannot answer is worse than no question.
 *
 * The four shapes are the ones the question tool accepts and the ones the legacy form supported: an
 * open question, one answer to pick, any number to pick, and a yes/no. Every one of them can be left,
 * because a question a person cannot get out of is a conversation they cannot get out of, and the
 * agent is better off being told nobody wants to answer.
 */

import { el } from "/lib/surface.js";

/** The three things a question can be, in the words the package uses for them everywhere. */
export const WORDING = { waiting: "Waiting for your answer", answered: "Answered", expired: "No longer needed" };

/** Reads a question out of whatever described it — a `tool-call` frame's arguments, or the package's
 *  own answer to `asked` — into the one shape both callers draw. Null when it is not a question. */
export function question(value) {
  const source = value && typeof value === "object" ? value : {};
  const asked = typeof source.question === "string" ? source.question.trim() : "";
  if (!asked) return null;
  const offered = (Array.isArray(source.options) ? source.options : []).filter((option) => typeof option === "string" && option.trim()).map((option) => option.trim());
  const shape = source.shape === "confirm" ? "confirm"
    : source.shape === "multiple" && offered.length ? "multiple"
    : source.shape === "choice" && offered.length ? "choice"
    : offered.length ? "choice" : "text";
  return { question: asked, shape, options: shape === "confirm" ? ["Yes", "No"] : shape === "text" ? [] : offered };
}

/**
 * The body of a question: the sentence, the controls, the two buttons and the line under them.
 *
 * @param {object} ask       what `question` above returned
 * @param {(answer: string | string[]) => Promise<unknown>} send  hands the answer to the package
 * @param {(state: string, said: string) => void} [after]  told once the form has settled, so the
 *   chrome around it — a status line, a card class — can say the same thing the form now says
 * @returns {{node: Node, settle: (state: string, said: string) => void}}
 */
export function form(ask, send, after = () => {}) {
  const picked = new Set();
  let written = "";
  const note = el("p", { class: "ask-note" }, "");
  const go = el("button", { type: "button", class: "ask-send", disabled: true, onClick: () => submit(answer()) }, "Send answer");
  const skip = el("button", { type: "button", class: "ask-skip", onClick: () => submit("") }, "Not now");
  const controls = [];

  function answer() {
    if (ask.shape === "text") return written.trim();
    if (ask.shape === "multiple") return [...picked];
    return [...picked][0] || "";
  }
  function refresh() {
    const value = answer();
    go.disabled = ask.shape === "multiple" ? !value.length : !value;
  }
  function lock(message) {
    for (const control of node.querySelectorAll("input, textarea, button")) control.disabled = true;
    note.textContent = message;
  }
  function settle(state, said) {
    lock(state === "answered" ? (said ? `You said: ${said}` : "You left this one.") : "The agent stopped waiting for this.");
    after(state, said);
  }
  function submit(value) {
    go.disabled = true; skip.disabled = true;
    note.textContent = "Sending…";
    send(value).then(
      () => { settle("answered", ask.shape === "multiple" ? value.join(", ") : value); },
      (error) => {
        // A refusal is a sentence the host or the package wrote for a person to read, so it is shown
        // as it is; the controls come back, so an answer refused by a connection that dropped between
        // the click and the reply can be given again once it is back.
        note.textContent = error.message;
        skip.disabled = false; refresh();
      });
  }

  if (ask.shape === "text") {
    controls.push(el("textarea", { class: "ask-text", rows: "2", placeholder: "Your answer", onInput: (event) => { written = event.target.value; refresh(); } }));
  } else {
    const group = `ask-${Math.random().toString(36).slice(2, 8)}`;
    for (const option of ask.options) {
      const input = el("input", {
        type: ask.shape === "multiple" ? "checkbox" : "radio",
        name: group,
        onChange: (event) => {
          if (ask.shape !== "multiple") picked.clear();
          if (event.target.checked) picked.add(option); else picked.delete(option);
          refresh();
        },
      });
      controls.push(el("label", { class: "ask-option" }, input, el("span", {}, option)));
    }
  }

  const node = el("div", { class: "ask-body" },
    el("p", { class: "ask-question" }, ask.question),
    el("div", { class: `ask-controls is-${ask.shape}` }, controls),
    el("div", { class: "ask-foot" }, go, skip, note));

  refresh();
  return { node, settle };
}

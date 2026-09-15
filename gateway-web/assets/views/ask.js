/* The `ask_user` form: turns a tool call into questions answered in place.
 *
 * `call.args` arrives as a parsed object (the transcript already does
 * `JSON.stringify(call.args)` for the ordinary tool card), so parsing here is
 * just validation, not JSON decoding. Answers go back through the same send
 * path as the composer — a plain user message — so the log stays replay-safe:
 * nothing about the form itself needs to be remembered, only the text it sent.
 * Installed through the built-in `ext` as a transcript renderer: the form stands
 * in for the tool card, and its result is not shown, because the form already
 * says everything the result would.
 */

import { el, clear } from "../lib/dom.js";

const OTHER_LABEL = "Something else…";

/** Reads a tool call's arguments into the shape this view draws, or null if unusable. */
export function parseAsk(args) {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  if (!questions.length) return null;
  const built = questions
    .map((q, index) => {
      const question = typeof q?.question === "string" ? q.question.trim() : "";
      if (!question) return null;
      const options = Array.isArray(q?.options)
        ? q.options.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim())
        : [];
      return {
        key: typeof q?.id === "string" && q.id.trim() ? q.id.trim() : String(index + 1),
        question,
        options,
        multiple: q?.allow_multiple === true,
      };
    })
    .filter(Boolean);
  if (!built.length) return null;
  return { intro: typeof args?.intro === "string" ? args.intro.trim() : "", questions: built };
}

/** Fresh per-question answer state: nothing picked, nothing typed, not skipped. */
function blankAnswer() {
  return { picked: [], otherPicked: false, other: "", text: "", skipped: false };
}

/** What one answer contributes to the composed message, or null when left empty and not skipped. */
function renderAnswer(q, answer) {
  if (answer.skipped) return "skipped";
  if (!q.options.length) {
    const text = answer.text.trim();
    return text || null;
  }
  const parts = [...answer.picked];
  if (answer.otherPicked && answer.other.trim()) parts.push(answer.other.trim());
  return parts.length ? parts.join(", ") : null;
}

/** The single message every answer becomes: "1. <question> — <answer|skipped>" lines. */
export function composeAnswers(ask, answers) {
  const lines = ask.questions.map((q, i) => {
    const value = renderAnswer(q, answers[i]);
    return `${i + 1}. ${q.question} — ${value ?? "skipped"}`;
  });
  return lines.join("\n");
}

/** One question's controls: radios or checkboxes, a free-text escape hatch, and a skip button. */
function questionBlock(q, index, answer, onChange) {
  const name = `ask-${Math.random().toString(36).slice(2, 8)}-${index}`;
  const otherInput = el("input", {
    type: "text",
    class: "ask-other-input",
    placeholder: "Your own answer",
    value: answer.other,
    hidden: !answer.otherPicked,
    onInput: (e) => { answer.other = e.target.value; onChange(); },
  });

  function pick(option, checked) {
    if (q.multiple) {
      const set = new Set(answer.picked);
      checked ? set.add(option) : set.delete(option);
      answer.picked = [...set];
    } else {
      answer.picked = checked ? [option] : [];
      answer.otherPicked = false;
      otherInput.hidden = true;
    }
    answer.skipped = false;
    onChange();
  }

  const controls = q.options.length
    ? [
        ...q.options.map((option) =>
          el("label", { class: "ask-option" },
            el("input", {
              type: q.multiple ? "checkbox" : "radio",
              name,
              checked: answer.picked.includes(option),
              onChange: (e) => pick(option, e.target.checked),
            }),
            el("span", {}, option))),
        el("label", { class: "ask-option is-other" },
          el("input", {
            type: q.multiple ? "checkbox" : "radio",
            name,
            checked: answer.otherPicked,
            onChange: (e) => {
              answer.otherPicked = e.target.checked;
              if (!q.multiple) answer.picked = [];
              if (e.target.checked) answer.skipped = false;
              otherInput.hidden = !e.target.checked;
              if (e.target.checked) otherInput.focus();
              onChange();
            },
          }),
          el("span", {}, OTHER_LABEL)),
        otherInput,
      ]
    : [
        el("textarea", {
          class: "ask-text",
          rows: "2",
          placeholder: "Your answer",
          onInput: (e) => { answer.text = e.target.value; if (e.target.value.trim()) answer.skipped = false; onChange(); },
        }, answer.text),
      ];

  const skip = el("button", {
    type: "button",
    class: `ask-skip${answer.skipped ? " is-on" : ""}`,
    title: "Leave this question unanswered",
    onClick: () => {
      answer.skipped = !answer.skipped;
      if (answer.skipped) {
        answer.picked = [];
        answer.otherPicked = false;
        answer.other = "";
        answer.text = "";
        otherInput.hidden = true;
        block.querySelectorAll("input[type=radio],input[type=checkbox]").forEach((n) => { n.checked = false; });
        const area = block.querySelector(".ask-text");
        if (area) area.value = "";
      }
      skip.classList.toggle("is-on", answer.skipped);
      block.classList.toggle("is-skipped", answer.skipped);
      onChange();
    },
  }, "Skip");

  const block = el("div", { class: `ask-q${answer.skipped ? " is-skipped" : ""}` },
    el("div", { class: "ask-q-head" },
      el("span", { class: "ask-q-num" }, String(index + 1)),
      el("span", { class: "ask-q-text" }, q.question),
      skip),
    el("div", { class: "ask-controls" }, ...controls));
  return block;
}

/**
 * Builds the card. `onAnswer(text)` sends the composed message the same way the
 * composer does; the card locks the moment Submit is pressed, whether or not the
 * send is still in flight — a slow socket should not invite a second click.
 */
export function askCard(ask, { onAnswer, answered = false } = {}) {
  const answers = ask.questions.map(blankAnswer);

  function lock(message) {
    card.classList.add("is-answered");
    card.querySelectorAll("input, textarea, button").forEach((n) => { n.disabled = true; });
    clear(foot).append(el("div", { class: "ask-note" }, message));
  }

  const submit = el("button", { type: "button", class: "ghost-btn is-primary", onClick: () => {
    onAnswer?.(composeAnswers(ask, answers));
    lock("Answered.");
  } }, "Submit");

  const foot = el("div", { class: "ask-foot" }, submit, el("div", { class: "ask-note" }, "Answer what you can — anything left is sent as skipped."));

  const card = el("div", { class: "ask" },
    el("div", { class: "ask-head" },
      el("span", { class: "ask-mark" }, "?"),
      el("div", {},
        el("div", { class: "ask-title" }, "Thetis is asking"),
        ask.intro ? el("div", { class: "ask-intro" }, ask.intro) : null)),
    el("div", { class: "ask-body" }, ...ask.questions.map((q, i) => questionBlock(q, i, answers[i], () => {}))),
    foot);

  if (answered) lock("Answered.");
  return card;
}

const ASK_TOOL = "ask_user";

/** Locks a card: it becomes a record of what was asked, not a control. */
function lockCard(card) {
  if (card.classList.contains("is-answered")) return;
  card.classList.add("is-answered");
  card.querySelectorAll("input, textarea, button").forEach((n) => { n.disabled = true; });
  const foot = card.querySelector(".ask-foot");
  if (foot) clear(foot).append(el("div", { class: "ask-note" }, "Answered."));
}

/**
 * Registers the ask form as a transcript renderer. An `ask_user` call whose arguments read as questions
 * is drawn as the form; a malformed call declines, so the ordinary tool card shows it rather than
 * dropping it. The form's result event is swallowed when the form was drawn. A later user message in
 * the same conversation, live or on replay, locks the form (`ctx.whenAnswered`).
 */
export function installAsk(ext) {
  const drawn = new Set(); // call ids drawn as a form, per page
  ext.transcript((event, ctx) => {
    if (event.type === "tool.call" && event.call?.name === ASK_TOOL) {
      const ask = parseAsk(event.call.args);
      if (!ask) return null;
      const card = askCard(ask, { onAnswer: (text) => void ext.conversation.send(text) });
      drawn.add(`${ctx.session}:${event.call.id}`);
      ctx.whenAnswered(() => lockCard(card));
      return card;
    }
    if (event.type === "tool.result" && event.name === ASK_TOOL) return drawn.has(`${ctx.session}:${event.id}`) ? true : null;
    return null;
  });
}

/* The `ask_user` form: turns a tool call into questions answered in place. `call.args` arrives as a parsed
 * object, so parsing here is validation, not JSON decoding. Answers go back through the composer's own
 * send path, as one plain user message, so the record stays replay-safe: nothing about the form itself is
 * remembered, only the text it sent, and a form followed by a user message is drawn locked. The DOM
 * helpers come from the shell through `ext.dom`, passed in as `dom`, because an extension imports nothing
 * of the gateway. */

const OTHER_LABEL = "Something else…";

/** Reads a tool call's arguments into the shape the form draws, or null if unusable. */
export function parseAsk(args) {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  if (!questions.length) return null;
  const built = questions
    .map((q, index) => {
      const question = typeof q?.question === "string" ? q.question.trim() : "";
      if (!question) return null;
      const options = Array.isArray(q?.options) ? q.options.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim()) : [];
      return { key: typeof q?.id === "string" && q.id.trim() ? q.id.trim() : String(index + 1), question, options, multiple: q?.allow_multiple === true };
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
  if (!q.options.length) return answer.text.trim() || null;
  const parts = [...answer.picked];
  if (answer.otherPicked && answer.other.trim()) parts.push(answer.other.trim());
  return parts.length ? parts.join(", ") : null;
}

/** The single message every answer becomes: "1. <question> — <answer|skipped>" lines. */
export function composeAnswers(ask, answers) {
  return ask.questions.map((q, i) => `${i + 1}. ${q.question} — ${renderAnswer(q, answers[i]) ?? "skipped"}`).join("\n");
}

/** One question's controls: radios or checkboxes, a free-text escape hatch, and a skip button. */
function questionBlock({ el }, q, index, answer) {
  const name = `tp-ask-${Math.random().toString(36).slice(2, 8)}-${index}`;
  const otherInput = el("input", {
    type: "text",
    class: "tp-ask-other-input",
    placeholder: "Your own answer",
    value: answer.other,
    hidden: !answer.otherPicked,
    onInput: (e) => { answer.other = e.target.value; },
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
  }

  const controls = q.options.length
    ? [
        ...q.options.map((option) =>
          el("label", { class: "tp-ask-option" },
            el("input", { type: q.multiple ? "checkbox" : "radio", name, checked: answer.picked.includes(option), onChange: (e) => pick(option, e.target.checked) }),
            el("span", {}, option))),
        el("label", { class: "tp-ask-option is-other" },
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
            },
          }),
          el("span", {}, OTHER_LABEL)),
        otherInput,
      ]
    : [
        el("textarea", {
          class: "tp-ask-text",
          rows: "2",
          placeholder: "Your answer",
          onInput: (e) => { answer.text = e.target.value; if (e.target.value.trim()) answer.skipped = false; },
        }, answer.text),
      ];

  const skip = el("button", {
    type: "button",
    class: `tp-ask-skip${answer.skipped ? " is-on" : ""}`,
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
        const area = block.querySelector(".tp-ask-text");
        if (area) area.value = "";
      }
      skip.classList.toggle("is-on", answer.skipped);
      block.classList.toggle("is-skipped", answer.skipped);
    },
  }, "Skip");

  const block = el("div", { class: `tp-ask-q${answer.skipped ? " is-skipped" : ""}` },
    el("div", { class: "tp-ask-q-head" }, el("span", { class: "tp-ask-q-num" }, String(index + 1)), el("span", { class: "tp-ask-q-text" }, q.question), skip),
    el("div", { class: "tp-ask-controls" }, ...controls));
  return block;
}

/** Locks a card: it becomes a record of what was asked, not a control. */
export function lockCard({ el, clear }, card) {
  if (card.classList.contains("is-answered")) return;
  card.classList.add("is-answered");
  card.querySelectorAll("input, textarea, button").forEach((n) => { n.disabled = true; });
  const foot = card.querySelector(".tp-ask-foot");
  if (foot) clear(foot).append(el("div", { class: "tp-ask-note" }, "Answered."));
}

/**
 * Builds the card. `onAnswer(text)` sends the composed message the way the composer does; the card locks
 * the moment Submit is pressed, whether or not the send is still in flight, because a slow socket should
 * not invite a second click.
 */
export function askCard(dom, ask, { onAnswer } = {}) {
  const { el } = dom;
  const answers = ask.questions.map(blankAnswer);
  const submit = el("button", { type: "button", class: "ghost-btn is-primary", onClick: () => { onAnswer?.(composeAnswers(ask, answers)); lockCard(dom, card); } }, "Submit");
  const foot = el("div", { class: "tp-ask-foot" }, submit, el("div", { class: "tp-ask-note" }, "Answer what you can — anything left is sent as skipped."));
  const card = el("div", { class: "tp-ask" },
    el("div", { class: "tp-ask-head" },
      el("span", { class: "tp-ask-mark" }, "?"),
      el("div", {}, el("div", { class: "tp-ask-title" }, "Thetis is asking"), ask.intro ? el("div", { class: "tp-ask-intro" }, ask.intro) : null)),
    el("div", { class: "tp-ask-body" }, ...ask.questions.map((q, i) => questionBlock(dom, q, i, answers[i]))),
    foot);
  return card;
}

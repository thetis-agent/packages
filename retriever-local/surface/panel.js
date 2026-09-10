/* The Skills panel: what reached this conversation's prompt, and why.
 *
 * It folds the `retrieve` event the surface already receives; it opens no socket and asks for
 * nothing. What it can show is exactly what this retriever chose to report, which is the point of
 * `score` and `how` being optional on a skills entry: a retriever that does not rank says so, and
 * the panel draws no bar rather than an invented one.
 */

import { registerPanel, registerRenderer, onEvent, conversation, el, section } from "/lib/surface.js";

/** Each ranking's plain reading, and the longer explanation on hover. */
const HOW = {
  fusion: ["semantic match", "The message and this skill's card were embedded, and their meanings landed close together."],
  lexical: ["word overlap", "No embedding was available, so skills were scored on shared words instead."],
  dense: ["semantic match", "Scored by embedding distance alone."],
  "parent-of-match": ["parent of a match", "A skill nested inside this one matched, so the parent came along to explain it."],
  "whole-corpus": ["everything included", "The corpus is no larger than the retrieval limit, so ranking was skipped."],
  universal: ["always included", "Marked universal in its frontmatter, so it is in every prompt."],
  activated: ["asked for", "Named explicitly for this turn."],
};

/** The newest answer per conversation, so switching tabs shows that tab's own skills. */
const answers = new Map();

function link(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

function card(entry, best) {
  const [label, hint] = HOW[entry.how] ?? [entry.how ?? "", ""];
  const dropped = entry.body === undefined && entry.description !== undefined;
  const node = el("div", { class: `sk-card${dropped ? " is-dropped" : ""}` },
    el("div", { class: "sk-head" },
      el("div", {},
        el("h4", { class: "sk-id" }, entry.id),
        el("p", { class: "sk-pack" }, `${entry.pack}@${entry.version}`)),
      el("span", { class: `sk-pill${entry.universal ? " is-on" : ""}` }, dropped ? "card only" : "in prompt")));

  if (typeof entry.score === "number") {
    const fill = el("span", { class: "sk-fill" });
    // CSSOM rather than a style attribute: the surface's CSP allows no inline styles.
    fill.style.width = `${String(Math.max(4, Math.round((entry.score / best) * 100)))}%`;
    node.append(el("div", { class: "sk-score" },
      el("span", { class: "sk-bar" }, fill),
      el("span", { class: "sk-num" }, entry.score.toFixed(2)),
      el("span", { class: "sk-how", title: hint }, label)));
  } else if (label) {
    node.append(el("div", { class: "sk-score" }, el("span", { class: "sk-how", title: hint }, label)));
  }
  return node;
}

function draw(current) {
  const answer = answers.get(current);
  if (!answer) return { title: "Skills", items: [], empty: "No skills retrieved yet — send a message to see what reaches the prompt." };
  const entries = answer.entries ?? [];
  const dropped = answer.dropped ?? [];
  const best = Math.max(...entries.map(entry => entry.score ?? 0), 0) || 1;
  const blocks = [];
  if (entries.length) {
    blocks.push(section({ title: "In the prompt", count: entries.length, note: "Rendered into the stored prefix for this conversation." }));
    blocks.push(...entries.map(entry => card(entry, best)));
  }
  if (dropped.length) {
    blocks.push(section({ title: "Dropped for budget", count: dropped.length, note: "Matched, but would not fit the retrieval budget." }));
    blocks.push(...dropped.map(id => el("div", { class: "sk-card is-dropped" }, el("h4", { class: "sk-id" }, id))));
  }
  return { title: "Skills", subtitle: `${String(entries.length)} of ${String(entries.length + dropped.length)} matched skills`, blocks };
}

const SPARK = ["M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6L10 3Z"];

link("/surface/retriever-local/panel.css");

const panel = registerPanel({
  id: "skills",
  label: "Skills",
  hint: "Skills — what reached this conversation's prompt, and why",
  icon: () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("width", "17"); svg.setAttribute("height", "17");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", SPARK[0]); path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6"); path.setAttribute("stroke-linejoin", "round");
    svg.append(path); return svg;
  },
  draw: () => draw(conversation.current),
});

// A tab switch shows that conversation's own retrieval, not whichever arrived last.
conversation.watch(() => { panel.redraw(); });

onEvent("retrieve", (frame) => {
  answers.set(frame.session, frame);
  if (frame.session === conversation.current) panel.redraw();
});

/** The same answer, as one transcript row, so the retrieval is visible in the reading order too. */
registerRenderer("retrieve", (frame) => {
  const count = (frame.entries ?? []).length;
  if (!count) return null;
  return el("div", { class: "msg is-note" }, `Retrieved ${String(count)} skill${count === 1 ? "" : "s"}.`);
});

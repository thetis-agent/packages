/* The Skills panel for a retriever that does not retrieve.
 *
 * `retriever-local` draws ranked cards: a bar, a number, and a `how` explaining what the number
 * measures. None of that exists here. This stage attaches the whole installed corpus in one fixed
 * order, so the only questions a reader can actually ask are how much of it arrived, in what order,
 * and what the budget cut — and a flat list with a running total answers them. Drawing a score bar
 * for entries that carry no score would invent a ranking the answer explicitly refuses to claim.
 *
 * It folds the `retrieve` event the surface already receives; it opens no socket and asks for
 * nothing. `/lib/surface.js` is the only module it may import.
 */

import { registerPanel, registerRenderer, onEvent, conversation, el, section } from "/lib/surface.js";

/** The same divisor the stage budgets with, so the panel's total and the stage's agree. */
const BYTES_PER_TOKEN = 4;
const encoder = new TextEncoder();

/** The newest answer per conversation, so switching tabs shows that tab's own corpus. */
const answers = new Map();

const tokens = (text) => Math.ceil(encoder.encode(text ?? "").length / BYTES_PER_TOKEN);

function link(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

/** One line per skill: identity, where it came from, and whether its body actually arrived. */
function row(entry) {
  const carried = typeof entry.body === "string";
  const node = el("div", { class: `sa-row${carried ? "" : " is-thin"}` },
    el("span", { class: "sa-mark", title: entry.universal ? "Universal: declared for every prompt, so it is ordered first." : null },
      entry.universal ? "●" : "○"),
    el("div", { class: "sa-what" },
      el("span", { class: "sa-id" }, entry.id),
      el("span", { class: "sa-pack" }, `${entry.pack}@${entry.version}`)),
    el("span", { class: "sa-tokens" }, carried ? `${String(tokens(entry.body))}t` : "card only"));
  return node;
}

/** The reading the whole package exists to give: how much of the corpus reached the prompt. */
function total(entries, dropped) {
  const attached = entries.filter(entry => typeof entry.body === "string");
  const universal = entries.filter(entry => entry.universal).length;
  const sum = attached.reduce((count, entry) => count + tokens(entry.body), 0);
  const note = `${String(universal)} universal, ${String(attached.length)} attached whole, ~${sum.toLocaleString()} tokens. Nothing was ranked.`;
  return section({ title: "Whole corpus", count: entries.length + dropped.length, note });
}

function draw(current) {
  const answer = answers.get(current);
  if (!answer) return { title: "Skills", items: [], empty: "No corpus attached yet — send a message to see everything that reaches the prompt." };
  const entries = answer.entries ?? [];
  const dropped = answer.dropped ?? [];
  const blocks = [total(entries, dropped)];
  if (entries.length) blocks.push(el("div", { class: "sa-list" }, entries.map(row)));
  if (dropped.length) {
    blocks.push(section({ title: "Dropped for budget", count: dropped.length, note: "Installed, and cut whole from the end of the order because the budget ran out." }));
    blocks.push(el("div", { class: "sa-list" }, dropped.map(id => el("div", { class: "sa-row is-cut" },
      el("span", { class: "sa-mark" }, "—"), el("div", { class: "sa-what" }, el("span", { class: "sa-id" }, id))))));
  }
  return { title: "Skills", subtitle: `${String(entries.length)} of ${String(entries.length + dropped.length)} installed skills`, blocks };
}

const STACK = ["M3 6.5 10 3l7 3.5-7 3.5-7-3.5Z", "M3 10.5 10 14l7-3.5", "M3 14 10 17.5 17 14"];

link("/surface/skills-all/panel.css");

const panel = registerPanel({
  id: "skills",
  label: "Skills",
  hint: "Skills — the whole installed corpus, and what the budget cut",
  icon: () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("width", "17"); svg.setAttribute("height", "17");
    svg.setAttribute("aria-hidden", "true");
    for (const d of STACK) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d); path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.5"); path.setAttribute("stroke-linejoin", "round"); path.setAttribute("stroke-linecap", "round");
      svg.append(path);
    }
    return svg;
  },
  draw: () => draw(conversation.current),
});

// A tab switch shows that conversation's own corpus, not whichever arrived last.
conversation.watch(() => { panel.redraw(); });

onEvent("retrieve", (frame) => {
  answers.set(frame.session, frame);
  if (frame.session === conversation.current) panel.redraw();
});

/** The same answer as one transcript row. The dropped count leads when there is one, because a cut
 *  corpus is the only thing about this stage a person may need to act on. */
registerRenderer("retrieve", (frame) => {
  const count = (frame.entries ?? []).length;
  const cut = (frame.dropped ?? []).length;
  if (!count && !cut) return null;
  const text = `Attached ${String(count)} skill${count === 1 ? "" : "s"}${cut ? `, ${String(cut)} dropped for budget` : ""}.`;
  return el("div", { class: "msg is-note" }, text);
});

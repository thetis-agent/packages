/* Drawing for the Context inspector. surface/fold.js decides what is true; this decides how it reads.
 *
 * The DOM helpers arrive as an argument rather than an import so that panel.js stays the one module
 * that touches `/lib/surface.js` — the seam contract/surface names — and so every branch below can be
 * exercised against a recording stand-in in view.test.ts. Nothing here sets a `style` attribute:
 * the surface is served under `default-src 'self'` with no `unsafe-inline`, so the one per-element
 * value this panel needs goes through CSSOM (lib/assets' csp).
 */

export const SEGMENTS = [
  { id: "request", label: "Request" },
  { id: "prompt", label: "Prompt" },
  { id: "usage", label: "Usage" },
];

function note(dom, text) {
  return dom.el("div", { class: "panel-note" }, text);
}

/** Thousands grouped by hand rather than by `toLocaleString`, so the same number reads the same way
 *  for every person and in every test, whatever locale the browser or the runner happens to carry. */
function count(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function bytes(chars) {
  return chars < 1000 ? `${count(chars)} chars` : `${(chars / 1000).toFixed(1)}k chars`;
}

/** The three readings of one request, as a button group. `pick` is told which was pressed. */
export function segmented(active, pick, dom) {
  return dom.el("div", { class: "ci-segmented" }, SEGMENTS.map(segment => dom.el("button", {
    type: "button",
    class: `ci-segment${segment.id === active ? " is-active" : ""}`,
    "aria-pressed": String(segment.id === active),
    onClick: () => { pick(segment.id); },
  }, segment.label)));
}

function line(dom, key, value) {
  return dom.el("div", { class: "ci-line" }, dom.el("span", { class: "ci-key" }, key), dom.el("span", { class: "ci-value" }, value));
}

function messageRow(dom, message) {
  const head = dom.el("summary", { class: "ci-msg-head" },
    dom.el("span", { class: "ci-idx" }, String(message.index)),
    dom.el("span", { class: `ci-role is-${message.role}` }, message.role),
    dom.el("span", { class: "ci-gist" }, message.text.replace(/\s+/gu, " ").trim().slice(0, 120)),
    dom.el("span", { class: "ci-size" }, bytes(message.chars)),
    message.cached ? dom.el("span", { class: "ci-pill is-on", title: "Inside the prefix this request asked the provider to cache." }, "cached") : null);
  return dom.el("details", { class: "ci-msg" }, head,
    dom.el("pre", { class: "ci-pre" }, message.text),
    message.cut ? note(dom, "Cut for display; the request carried the whole message.") : null);
}

function toolRow(dom, tool) {
  return dom.el("details", { class: "ci-msg" },
    dom.el("summary", { class: "ci-msg-head" },
      dom.el("span", { class: "ci-role is-tool" }, "tool"),
      dom.el("span", { class: "ci-name" }, tool.name),
      dom.el("span", { class: "ci-gist" }, tool.description.replace(/\s+/gu, " ").trim().slice(0, 120))),
    dom.el("pre", { class: "ci-pre" }, json(tool.schema)));
}

function json(value) {
  try { return JSON.stringify(value, null, 2) ?? "undefined"; }
  catch { return "[unserialisable]"; }
}

function scalars(dom, request) {
  const rows = [line(dom, "model", request.model), line(dom, "provider", request.provider)];
  for (const [key, value] of Object.entries(request.options)) rows.push(line(dom, key, json(value)));
  return dom.el("div", { class: "ci-scalars" }, rows);
}

/** What went out: the provider, the model, and every message and tool definition in sent order. */
export function requestBlocks(request, dom) {
  if (!request) return [note(dom, "No model call yet — send a message to see the request that goes out.")];
  const cached = request.cachedThrough >= 0
    ? `The first ${count(request.cachedThrough + 1)} are the stored prefix, sent for the provider to cache.`
    : "This request asked for no cache breakpoint.";
  const blocks = [
    dom.el("div", { class: "ci-meta" }, dom.el("span", { class: "ci-name" }, `${request.provider} · ${request.model}`),
      dom.el("span", { class: "ci-dim" }, "the exact request this turn sent, in order")),
    scalars(dom, request),
    dom.section({ title: "messages", count: request.counts.messages, note: cached }),
    ...request.messages.map(message => messageRow(dom, message)),
    dom.section({ title: "tool definitions", count: request.counts.tools, note: "Serialised into the same request; the Tools inspector says which were withheld." }),
    ...request.tools.map(tool => toolRow(dom, tool)),
  ];
  if (request.hidden > 0) blocks.push(note(dom, `${count(request.hidden)} further rows are not listed.`));
  if (request.truncated) blocks.push(note(dom, "The wire shortened this request to fit its event budget, so what is drawn here is not the whole body."));
  return blocks;
}

/** A meter for the turn's own budget. The one per-element value goes through CSSOM, never a style attribute. */
function meter(dom, budget) {
  const fill = dom.el("span", { class: "ci-fill" });
  fill.style.setProperty("width", `${String(Math.max(2, Math.round(budget.share * 100)))}%`);
  return dom.el("div", { class: "ci-budget" },
    dom.el("div", { class: "ci-bar" }, fill),
    dom.el("div", { class: "ci-budget-legend" },
      dom.el("span", {}, `${count(budget.used)} used of ${count(budget.available)} available`),
      dom.el("span", { class: "ci-dim" }, `window ${count(budget.total)} · reserve ${count(budget.reserve)}`)));
}

/** Each section's plain reading, so the grouping explains itself rather than being an unlabelled gap. */
const SECTION_NOTE = {
  system: "The instructions this deployment renders into every prompt.",
  skills: "Skill cards retrieval put in front of the model this turn.",
  harness: "Rows a stage appended for this turn only; never persisted.",
  history: "The conversation so far, after compaction.",
};

/** What the prompt is made of, section by section, and how much of the window it leaves. */
export function promptBlocks(prompt, dom) {
  if (!prompt) return [note(dom, "No context assembled yet — send a message to see what the prompt is made of.")];
  const blocks = [meter(dom, prompt.budget)];
  if (prompt.truncated) blocks.push(note(dom, "The wire shortened this context to fit its event budget, so the sections below are not the whole of it."));
  for (const group of prompt.groups) {
    blocks.push(dom.section({ title: group.name, count: group.count, note: SECTION_NOTE[group.name] ?? "" }));
    if (!group.count) blocks.push(note(dom, "Empty this turn."));
    else if (group.text) blocks.push(dom.el("pre", { class: "ci-pre is-prompt" }, group.text));
    else blocks.push(note(dom, `${bytes(group.chars)} across ${count(group.count)} messages, none of it text.`));
  }
  return blocks;
}

function tile(dom, name, value) {
  return dom.el("div", { class: "ci-stat" },
    dom.el("div", { class: "ci-stat-value" }, value),
    dom.el("div", { class: "ci-stat-label" }, name));
}

function amount(name, value) {
  return name === "cost" ? `$${value.toFixed(4)}` : count(Math.round(value));
}

function callRow(dom, call) {
  const counters = Object.entries(call.usage).sort(([left], [right]) => left.localeCompare(right));
  return dom.el("div", { class: "ci-call" },
    dom.el("span", { class: "ci-call-n" }, `#${String(call.n)}`),
    ...counters.map(([name, value]) => dom.el("span", { class: "ci-call-counter" }, `${name} ${amount(name, value)}`)),
    call.stop && call.stop !== "end" ? dom.el("span", { class: "ci-stop" }, call.stop) : null);
}

/** What the turns cost, from the counters `model.end` reported — no estimate, no side channel. */
export function usageBlocks(usage, dom) {
  if (!usage.count) return [note(dom, "Nothing spent in this conversation yet.")];
  const blocks = [
    dom.el("div", { class: "ci-stats" }, ...usage.counters.map(counter => tile(dom, counter.name, amount(counter.name, counter.total))), tile(dom, "model calls", count(usage.count))),
    dom.section({ title: "per call, newest first", count: usage.calls.length, note: "Exactly the counters the provider reported for each call." }),
    ...usage.calls.map(call => callRow(dom, call)),
  ];
  if (usage.forgotten > 0) blocks.push(note(dom, `${count(usage.forgotten)} earlier calls are counted in the totals but no longer listed.`));
  return blocks;
}

export function blocks(segment, described, dom) {
  if (segment === "prompt") return promptBlocks(described.prompt, dom);
  if (segment === "usage") return usageBlocks(described.usage, dom);
  return requestBlocks(described.request, dom);
}

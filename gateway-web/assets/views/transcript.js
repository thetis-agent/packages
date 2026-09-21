/* One conversation's transcript. Draws saved messages and applies live turn events on top:
 * `text` grows a live bubble under a caret, `tool.call` opens a card that `tool.result` fills and settles,
 * `message` settles the bubble into rendered markdown with a usage footnote, `error` becomes a note.
 * Consecutive tool cards sit in one run with a count, so a long stretch of calls reads as one thing.
 * One instance per pane: `mountTranscript(root, { session })` knows which conversation it draws, so a
 * background tab keeps drawing its own events. Tool rows are offered to the registered transcript
 * renderers first (a package draws its own tools' rows there, as @thetis/tools-plan does for todo_* and
 * ask_user); the tool card is the fall-through, and `ctx.whenAnswered` lets a renderer's row lock itself
 * when the next user message arrives, live or on replay.
 *
 * A `spawn_subagent` call draws no tool card: it draws an agent block, a `details.agent` at message level
 * with the child's label, its state and, once ended, what it took. The child's own rows are drawn inside
 * it by a nested instance (`{ nested: true }`: no jump button, no scroll following of its own, no
 * renderers, no user rows, since the block's brief is that). A child's events reach the block through
 * `applyChild(message)`; a grandchild's message is handed down to the nested instance of its parent, at
 * any depth. A finished child's rows, on replay, are built on the first open of its block, because a
 * conversation with many finished children would otherwise cost the reader every child's history at once. */

import { applyActivityPhase, fmtCost, fmtDuration, fmtTokens } from "../lib/activity.js";
import { api } from "../lib/api.js";
import { avatarFor } from "../lib/avatar.js";
import { clear, el, icon } from "../lib/dom.js";
import { gist, usageLine } from "../lib/transcript-format.js";
import { renderMarkdown } from "../lib/markdown.js";
import { renderTranscript } from "../lib/registry.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";

const RESULT_PREVIEW = 4000;
const RUN_FOLD = 4; // a restored run of more tool calls than this starts folded
const DOWN = ["M5 8l5 5 5-5"];
const OPEN_TAB = ["M4 4h6M4 4v6M4 4l7 7", "M9 16h7v-7"];
const FLASH_MS = 1200;
const OWN_CARD = ":scope > .tool-run > .tool-run-body > details.tool"; // this instance's cards, not a nested block's

/** The tool that spawns a subagent, and the first line of its result: `[subagent <id>]` or `[subagent <id> <label>]`. */
export const SPAWN_TOOL = "spawn_subagent";
export const SPAWN_RESULT = /^\[subagent (s_[a-f0-9]+)(?: ([^\]]*))?\]/;

/** The brand mark, for empty states. */
export function mark() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const [k, v] of Object.entries({ cx: 16, cy: 16, r: 9, fill: "none", stroke: "currentColor", "stroke-width": 2.5 })) ring.setAttribute(k, v);
  const core = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const [k, v] of Object.entries({ cx: 16, cy: 16, r: 3, fill: "currentColor" })) core.setAttribute(k, v);
  svg.append(ring, core);
  return svg;
}

/** The empty state: "none" when no conversation is open (with a way to start one), "empty" for a conversation with no messages, "agent" for a subagent that has said nothing. */
export function emptyState(kind, onNew) {
  return el(
    "div",
    { class: "transcript-empty" },
    el("span", { class: "empty-mark", "aria-hidden": "true" }, mark()),
    kind === "none"
      ? [el("span", {}, "No conversation open."), el("button", { type: "button", class: "ghost-btn is-primary", onClick: () => onNew?.() }, "Start a conversation")]
      : el("span", {}, kind === "agent" ? "This subagent has said nothing yet." : "No messages yet — say something to start.")
  );
}

/** A label for a child that was given none: the first words of its task. */
export function labelFromTask(task) {
  const words = String(task || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 3).join(" ");
  if (!words) return "subagent";
  return words.length > 24 ? words.slice(0, 23) + "…" : words;
}

function clip(text, max) {
  const one = String(text || "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** What a child's record says it spent: the summed cost and completion tokens of its replies, and its tool calls. */
function tallyRecord(record) {
  let cost = 0;
  let tokens = 0;
  for (const u of Object.values(record?.usage ?? {})) {
    if (typeof u?.cost === "number") cost += u.cost;
    if (typeof u?.completion_tokens === "number") tokens += u.completion_tokens;
  }
  const steps = (record?.conversation ?? []).filter((m) => m.role === "tool").length;
  return { cost, tokens, steps };
}

/** What a record's `children` say, for the store: parent, label, task, when, and the recorded spend. */
function agentsOfRecord(record) {
  return (record.children ?? []).map((c) => [c.id, { parent: c.parent || record.id, label: c.label ?? undefined, task: c.task ?? undefined, createdAt: c.createdAt, outcome: c.turn ? null : store.agent(c.id)?.outcome ?? "done", cost: typeof c.cost === "number" ? c.cost : tallyRecord(c).cost }]);
}

/**
 * Options: `session` is the conversation drawn. `nested` makes an instance for a subagent's block: it has
 * no jump button and no scroll following of its own (`catchUp` is the outer instance's), offers nothing
 * to the renderers, and draws no user rows. `brief` draws user rows as a subagent's brief (a child's own
 * tab). `onOpenAgent(id)` opens a child in a tab; it is handed down to nested instances.
 */
export function mountTranscript(root, { session, nested = false, brief = false, catchUp: outerCatchUp, onOpenAgent } = {}) {
  let live = null;        // { node, textEl, text }
  let settled = null;     // the last settled bubble: { node, text }, so the message event can add its usage
  let pendingRow = null;  // the reader's own message awaiting the server's echo
  let run = null;         // the open run of tool cards, or null
  let answered = [];      // renderer hooks waiting for the next user message (an ask form locks itself)
  let follow = true;
  let frame = 0;          // the animation frame booked for the next catch-up, 0 when none
  let restoring = false;  // while a record is replayed nothing scrolls: one catch-up at the end
  let childRecords = new Map(); // child id -> ChildRecord, from the last restored record
  const blocks = [];            // agent blocks, in the order they were placed
  const byAgent = new Map();    // child id -> block
  const byCall = new Map();     // spawn call id -> block
  let jump = null;

  if (!nested) {
    jump = el("button", { type: "button", class: "jump-latest", title: "Jump to the latest message", onClick: () => { follow = true; settle(); } }, icon(DOWN, { size: 14, width: 2 }), "Latest");
    jump.hidden = true;
    root.parentElement.append(jump);
    // Only a scroll upward is the reader leaving. Content growing, the pane changing height under them
    // (the composer growing as they type) and the smooth scroll to the bottom all fire scroll events too,
    // and each can catch the pane away from the bottom for a frame; none of them is a wish to stop following.
    let top = root.scrollTop;
    let height = root.clientHeight;
    root.addEventListener("scroll", () => {
      const up = root.scrollTop < top && root.clientHeight === height;
      top = root.scrollTop;
      height = root.clientHeight;
      if (root.scrollHeight - root.scrollTop - root.clientHeight < 64) follow = true;
      else if (up) follow = false;
      else if (follow) catchUp();
      draw();
    }, { passive: true });
  }

  function draw() {
    if (jump) jump.hidden = follow || root.scrollHeight <= root.clientHeight + 8;
  }

  /**
   * The one scroll a frame: to the bottom when the reader is following, else only the jump button. Reading
   * `scrollHeight` forces a layout, so this runs once per frame however many rows arrived (`catchUp` books
   * it), never while a record is being replayed, and not in a pane that is not shown (`checkVisibility`
   * sees through `content-visibility: hidden`): `shown()` catches it up when it is.
   */
  function settle() {
    frame = 0;
    if (restoring || (root.checkVisibility && !root.checkVisibility({ visibilityProperty: true }))) return;
    if (follow) root.scrollTop = root.scrollHeight;
    draw();
  }

  /** Keeps the newest row in view when the reader is at the bottom. Nested: the outer pane is what scrolls. */
  function catchUp() {
    if (nested) return outerCatchUp?.();
    if (!frame && !restoring) frame = requestAnimationFrame(settle);
  }

  function place(node, into = root) {
    root.querySelector(":scope > .transcript-empty")?.remove();
    into.append(node);
    catchUp();
    return node;
  }

  function reset() {
    clear(root);
    live = null;
    settled = null;
    pendingRow = null;
    run = null;
    answered = [];
    follow = true;
    childRecords = new Map();
    blocks.length = 0;
    byAgent.clear();
    byCall.clear();
    draw();
  }

  function showEmpty() {
    reset();
    if (!nested) root.append(emptyState(brief ? "agent" : "empty"));
  }

  function face(kind) {
    if (kind === "assistant") return avatarFor("agent", "Thetis");
    return kind === "user" && !brief ? avatarFor("person", store.get("user")?.user || "You") : null;
  }

  function row(kind, ...children) {
    run = null;
    return place(el("div", { class: `msg is-${kind}` }, face(kind), children));
  }

  function userRow(text) {
    // Whatever was asked has now been replied to, one way or another — live or on replay.
    const hooks = answered;
    answered = [];
    for (const fn of hooks) fn();
    if (nested) return null; // the block's brief is the child's user row
    const node = row("user", el("div", { class: "msg-text" }, text));
    if (brief) node.classList.add("is-brief");
    return node;
  }

  function note(text, tone) {
    const node = row("note", el("span", { class: "note-dot" }), el("span", {}, text));
    if (tone) node.classList.add(`is-${tone}`);
    return node;
  }

  // ---- registered renderers: a tool row a package draws instead of the card ----

  /** Offers a tool event to the renderers. True when one took it (and drew, or chose not to). Nothing is offered from a nested instance. */
  function rendered(event, restored) {
    if (nested) return false;
    const ctx = { session, el, icon, markdown: renderMarkdown, restored, whenAnswered: (fn) => answered.push(fn) };
    const out = renderTranscript(event, ctx);
    if (!out) return false;
    run = null; // a renderer's row is message-level, like a bubble, not part of a tool run
    if (out instanceof Node) place(out);
    return true;
  }

  function openLive() {
    if (live) return live;
    const textNode = document.createTextNode("");
    const textEl = el("div", { class: "msg-text is-live" }, textNode);
    live = { node: row("assistant", textEl), textEl, textNode, text: "" };
    return live;
  }

  /** Settles the live bubble: markdown replaces the raw stream. Drops it when nothing was said. */
  function settleLive(finalText, usage) {
    if (!live) return;
    const bubble = live;
    live = null;
    const text = finalText ?? bubble.text;
    bubble.textEl.classList.remove("is-live");
    if (!text.trim()) return bubble.node.remove();
    clear(bubble.textEl).append(...renderMarkdown(text));
    settled = { node: bubble.node, text };
    const foot = usageLine(usage, liveModel());
    if (foot) bubble.node.append(foot);
    catchUp();
  }

  function assistantRow(text, usage, model) {
    if (!text.trim()) return;
    const textEl = el("div", { class: "msg-text" }, ...renderMarkdown(text));
    row("assistant", textEl, usageLine(usage, model));
  }

  /** The model this conversation answers with, for the footnote of a live reply. */
  function liveModel() {
    return store.modelFor(session);
  }

  /**
   * The `message` event of a reply that asked for tools arrives after its text was settled by the first
   * `tool.call`. Its usage goes onto that bubble; drawing the text again would show it twice.
   */
  function assistantMessage(content, usage) {
    if (live) return settleLive(content || live.text, usage);
    if (settled && settled.text.trim() === (content || "").trim()) {
      const foot = usageLine(usage, liveModel());
      if (foot && !settled.node.querySelector(".msg-usage")) settled.node.append(foot);
      return;
    }
    assistantRow(content || "", usage, liveModel());
  }

  // ---- tool cards, in runs ----

  function openRun(restoring) {
    if (run) return run;
    const count = el("span", { class: "tool-run-count" });
    const tally = el("span", { class: "tool-run-tally" });
    const node = el("details", { class: "tool-run", open: "" }, el("summary", { class: "tool-run-head" }, count, tally), el("div", { class: "tool-run-body" }));
    run = { node, count, tally, names: new Map(), n: 0, restoring };
    place(node);
    return run;
  }

  function tallyRun() {
    if (!run) return;
    run.count.textContent = `${run.n} ${run.n === 1 ? "tool call" : "tool calls"}`;
    const parts = [...run.names].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name));
    run.tally.textContent = parts.slice(0, 4).join(" · ") + (parts.length > 4 ? " · …" : "");
    if (run.restoring && run.n > RUN_FOLD) run.node.open = false;
  }

  /** A turn that ends while a tool runs leaves its card without a result; say so rather than leave it pulsing. */
  function settleTools(status = "stopped") {
    for (const card of root.querySelectorAll(`${OWN_CARD}.is-running, ${OWN_CARD}[data-await]`)) {
      card.classList.remove("is-running");
      card.removeAttribute("data-await");
      card.querySelector(".tool-status").textContent = status;
      card.open = false;
    }
    for (const block of blocks) if (block.state === "starting" || block.state === "working") endBlock(block, status === "stopped" ? "stopped" : "failed");
  }

  function toolCard(call, running, restoring = false) {
    let args = "";
    try {
      args = JSON.stringify(call.args ?? {}, null, 2);
    } catch {
      args = "";
    }
    const r = openRun(restoring);
    r.n += 1;
    r.names.set(call.name || "tool", (r.names.get(call.name || "tool") ?? 0) + 1);
    const node = el(
      "details",
      { class: `tool${running ? " is-running" : ""}`, "data-tool": call.id || "", "data-since": running ? String(Date.now()) : null, "data-await": restoring ? "" : null },
      el(
        "summary",
        { class: "tool-head" },
        el("span", { class: "tool-name" }, call.name || "tool"),
        el("span", { class: "tool-gist", title: gist(call.args, 400) }, gist(call.args, 90)),
        el("span", { class: "tool-took" }),
        el("span", { class: "tool-status" }, running ? "running" : "…")
      ),
      args && args !== "{}" ? [el("div", { class: "tool-label" }, "arguments"), el("pre", { class: "tool-pre" }, args)] : null
    );
    r.node.querySelector(".tool-run-body").append(node);
    tallyRun();
    catchUp();
    return node;
  }

  function toolResult(id, name, result) {
    const failed = /^error:/i.test(result || "");
    const card = id ? root.querySelector(`${OWN_CARD}[data-tool="${cssEscape(id)}"]`) : null;
    if (!card) {
      const node = toolCard({ id, name, args: {} }, false, !live && !pendingRow);
      node.append(...resultSection(result || "", failed));
      node.classList.toggle("is-bad", failed);
      node.querySelector(".tool-status").textContent = failed ? "failed" : "done";
      return;
    }
    card.classList.remove("is-running");
    card.removeAttribute("data-await");
    card.classList.toggle("is-bad", failed);
    card.querySelector(".tool-status").textContent = failed ? "failed" : "done";
    const since = Number(card.dataset.since);
    if (since) card.querySelector(".tool-took").textContent = fmtDuration(Date.now() - since);
    card.append(...resultSection(result || "", failed));
    card.open = false;
    catchUp();
  }

  function resultSection(text, failed, label = failed ? "error" : "result") {
    const head = el("div", { class: "tool-label" }, label);
    if (text.length <= RESULT_PREVIEW) return [head, el("pre", { class: `tool-pre${failed ? " is-error" : ""}` }, text)];
    const pre = el("pre", { class: `tool-pre${failed ? " is-error" : ""}` }, `${text.slice(0, RESULT_PREVIEW)}\n…`);
    const more = el("button", { type: "button", class: "tool-more", onClick: () => { pre.textContent = text; more.remove(); } }, `show all ${Math.max(1, Math.round(text.length / 1024))} KB`);
    return [head, pre, more];
  }

  // ---- agent blocks: a subagent's work, folded into the call that spawned it ----

  /** A button in a summary must not toggle the details it sits in. */
  function summaryButton(props, ...children) {
    return el("button", { type: "button", ...props, onClick: (event) => { event.preventDefault(); event.stopPropagation(); props.onClick?.(event); } }, ...children);
  }

  /**
   * Places a block. `callId` is the spawn call's id (null for a block minted from the child's own events);
   * `id` binds it to a child at once; `restoring` places it folded, to be filled from the record.
   */
  function agentBlock({ callId = null, id = null, task = "", label = null, restoring = false }) {
    const body = el("div", { class: "agent-body" });
    const block = { node: null, body, callId, id: null, task: String(task || ""), label: label || labelFromTask(task), state: "starting", since: Date.now(), steps: 0, cost: 0, tokens: 0, record: null, built: false, nested: null, drawn: { turn: null, seq: 0 }, parts: {} };
    const parts = block.parts;
    parts.dot = el("span", { class: "agent-dot", "aria-hidden": "true" });
    parts.label = el("span", { class: "agent-label" }, block.label);
    parts.gist = el("span", { class: "agent-gist", title: clip(block.task, 400) }, clip(block.task, 90));
    parts.meta = el("span", { class: "agent-meta" });
    parts.took = el("span", { class: "agent-took" });
    parts.state = el("span", { class: "agent-state" }, restoring ? "…" : "starting");
    parts.open = summaryButton({ class: "agent-open", title: "Open in a tab", "aria-label": "Open this subagent in a tab", onClick: () => { if (block.id) onOpenAgent?.(block.id); } }, icon(OPEN_TAB, { size: 13, width: 1.7 }));
    parts.stop = summaryButton({ class: "agent-stop", title: "Stop this subagent", "aria-label": "Stop this subagent", hidden: true, onClick: () => stopAgent(block) }, "Stop");
    block.node = el(
      "details",
      { class: `agent${restoring ? "" : " is-running"}`, open: restoring ? null : "", "data-call": callId || null, onToggle: () => { if (block.node.open) build(block); } },
      el("summary", { class: "agent-head" }, parts.dot, parts.label, parts.gist, parts.meta, parts.took, parts.state, el("span", { class: "agent-actions" }, parts.open, parts.stop)),
      el("div", { class: "agent-brief" }, el("div", { class: "agent-brief-text" }, block.task)),
      body
    );
    blocks.push(block);
    if (callId) byCall.set(callId, block);
    if (id) bind(block, id);
    if (!restoring) {
      applyActivityPhase(block.node, { state: "working" });
      build(block); // live: the reader is watching, and the rows arrive a few at a time
    }
    run = null; // message-level, like a renderer's row: never inside a tool run
    place(block.node);
    return block;
  }

  function bind(block, id) {
    if (block.id === id) return;
    block.id = id;
    block.node.dataset.agent = id;
    byAgent.set(id, block);
    store.setAgent(id, { label: block.label });
    if (block.nested) block.nested.session = id;
  }

  function setState(block, state) {
    block.state = state;
    block.parts.state.textContent = state;
    const running = state === "starting" || state === "working";
    block.node.classList.toggle("is-running", running);
    block.node.classList.toggle("is-bad", state === "failed" || state === "stopped");
    block.parts.stop.hidden = !(running && block.id);
  }

  function drawMeta(block) {
    const bits = [];
    if (block.steps > 0) bits.push(`${block.steps} ${block.steps === 1 ? "tool call" : "tool calls"}`);
    if (block.cost > 0) bits.push(fmtCost(block.cost));
    if (block.tokens > 0) bits.push(`${fmtTokens(block.tokens)} tok`);
    block.parts.meta.textContent = bits.join(" · ");
  }

  /** The child ended: the state word, the meta line, the duration, and the block folds itself. */
  function endBlock(block, state, took = Date.now() - block.since) {
    if (block.state === "done" || block.state === "failed" || block.state === "stopped") return;
    setState(block, state);
    drawMeta(block);
    if (took > 0) block.parts.took.textContent = fmtDuration(took);
    block.node.open = false;
    catchUp();
  }

  async function stopAgent(block) {
    if (!block.id) return;
    try {
      await api(`/api/sessions/${block.id}/cancel`, { method: "POST" });
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  /**
   * Builds the nested transcript of a block once. A block placed live is built at once; one restored for a
   * finished child waits for the first open. A child whose record did not travel with the conversation's
   * (a grandchild's does not) is fetched then.
   */
  function build(block) {
    if (block.built) return;
    block.built = true;
    block.nested = mountTranscript(block.body, { session: block.id, nested: true, catchUp, onOpenAgent });
    if (block.record) return fill(block, block.record);
    if (!block.id || block.state === "starting" || block.state === "working") return;
    api(`/api/sessions/${block.id}`)
      .then((record) => { if (block.nested && !block.body.childElementCount) fill(block, record); })
      .catch((err) => toast(`The subagent's transcript could not be loaded: ${err.message}`, { tone: "error" }));
  }

  function fill(block, record) {
    block.nested.restore(record);
    block.drawn = record.turn ? { turn: record.turn.turn || "pending", seq: record.turn.events?.at(-1)?.seq ?? 0 } : { turn: null, seq: 0 };
  }

  /**
   * A spawn result: the `[subagent …]` line names the child; the body is the reply, or `stopped: …` with what the
   * child had said, or `error: …`. A result that is an error as a whole (the spawn itself failed) names no child.
   */
  function parseSpawnResult(result) {
    const text = String(result || "");
    const match = SPAWN_RESULT.exec(text);
    const body = match ? text.slice(match[0].length).replace(/^\n/, "") : text;
    const kind = /^error:/i.test(text) ? (/cancel/i.test(text) ? "stopped" : "failed") : /^error:/i.test(body) ? "failed" : /^stopped:/i.test(body) ? "stopped" : "done";
    return { id: match?.[1] ?? null, label: match?.[2]?.trim() || null, body, kind };
  }

  /** Quotes the result under the block, unless it is the reply the child's own last row already shows. */
  function quoteResult(block, body, kind) {
    if (kind === "done" && body.trim() === String(block.lastReply || "").trim()) return;
    block.node.append(...resultSection(body, kind === "failed", kind === "failed" ? "error" : kind === "stopped" ? "stopped" : "reply"));
  }

  /** The `tool.result` of a spawn call: binds the block by id when it is still unbound, settles it, and quotes the reply. */
  function agentResult(event) {
    const { id, label, body, kind } = parseSpawnResult(event.result);
    let block = byCall.get(event.id) ?? (id ? byAgent.get(id) : null);
    if (!block && !id) return false; // a spawn that made no child and has no block: the plain tool card says what happened
    if (!block) block = agentBlock({ id, task: store.agent(id)?.task || "", label: store.agent(id)?.label || label });
    if (id && !block.id) bind(block, id);
    endBlock(block, kind);
    if (kind !== "done" && block.state !== kind) setState(block, kind); // the child ended, then the spawn itself reported otherwise
    if (block.id) store.setAgent(block.id, { outcome: block.state });
    quoteResult(block, body, kind);
    block.node.open = false;
    catchUp();
    return true;
  }

  /** Delivers a child's message to its block, at any depth. Duplicate delivery (a reconnect replays the running turn) is refused per block by (turn, seq). */
  function applyChild(message) {
    const { event, parent } = message;
    let block = byAgent.get(message.session);
    if (!block) {
      if (parent !== session) {
        // A grandchild: hand it to the nested instance of the nearest ancestor drawn here.
        let cur = parent;
        while (cur && !byAgent.has(cur)) cur = store.agent(cur)?.parent;
        const ancestor = cur ? byAgent.get(cur) : null;
        if (!ancestor) return;
        build(ancestor);
        ancestor.nested?.applyChild(message);
        return;
      }
      if (event.type !== "turn.start") return;
      const input = String(message.input ?? "");
      block = blocks.find((b) => !b.id && b.task.trim() === input.trim()) ?? blocks.find((b) => !b.id) ?? null;
      if (block) bind(block, message.session);
      else block = agentBlock({ id: message.session, task: input, label: store.agent(message.session)?.label || null });
    }
    const turn = message.turn || "pending";
    if (turn === block.drawn.turn && message.seq <= block.drawn.seq) return;
    if (turn !== block.drawn.turn) block.drawn = { turn, seq: 0 };
    block.drawn.seq = message.seq;
    switch (event.type) {
      case "turn.start":
        block.since = Date.parse(message.startedAt || "") || block.since;
        setState(block, "working");
        applyActivityPhase(block.node, { state: "working" });
        break;
      case "tool.call":
        block.steps += 1;
        break;
      case "usage": {
        const u = event.usage ?? {};
        if (typeof u.cost === "number") block.cost += u.cost;
        if (typeof u.completion_tokens === "number") block.tokens += u.completion_tokens;
        break;
      }
      case "message":
        if (event.message?.role === "assistant" && event.message.content?.trim()) block.lastReply = event.message.content;
        break;
      case "error":
        endBlock(block, event.code === "cancelled" ? "stopped" : "failed");
        break;
      case "turn.end":
        endBlock(block, "done");
        break;
      default:
        break;
    }
    build(block);
    block.nested.applyEvent(event, message.input);
  }

  /** Opens a child's block (building its rows first when they waited), scrolls it to the centre, and flashes it. The block, or null. */
  function revealAgent(id) {
    const block = byAgent.get(id);
    if (block) {
      build(block);
      block.node.open = true;
      block.node.scrollIntoView({ block: "center", behavior: "smooth" });
      block.node.classList.add("is-flashed");
      setTimeout(() => block.node.classList.remove("is-flashed"), FLASH_MS);
      return block.node;
    }
    let cur = store.agent(id)?.parent;
    while (cur && !byAgent.has(cur)) cur = store.agent(cur)?.parent;
    const ancestor = cur ? byAgent.get(cur) : null;
    if (!ancestor) return null;
    build(ancestor);
    ancestor.node.open = true;
    return ancestor.nested?.revealAgent(id) ?? null;
  }

  /** A restored spawn result: the block for that child, its state from the record, folded; rows on first open. */
  function restoredAgent(message) {
    const parsed = parseSpawnResult(message.content);
    const { label, body, kind } = parsed;
    let id = parsed.id;
    let block = byCall.get(message.toolCallId) ?? (id ? byAgent.get(id) : null);
    if (!block && !id) return false;
    // A spawn that ended in an error names no child; the child it made, when it made one, is the unreferenced record with its task.
    if (block && !id && !block.id) id = [...childRecords.values()].find((c) => !byAgent.has(c.id) && String(c.task || "").trim() === block.task.trim())?.id ?? null;
    const child = id ? childRecords.get(id) : null;
    if (!block) block = agentBlock({ id, task: child?.task || "", label: child?.label || label, restoring: true });
    if (id && !block.id) bind(block, id);
    const outcome = kind;
    if (child) block.lastReply = [...(child.conversation ?? [])].reverse().find((m) => m.role === "assistant" && m.content?.trim())?.content ?? "";
    if (child) {
      const tally = tallyRecord(child);
      block.steps = tally.steps;
      block.cost = tally.cost;
      block.tokens = tally.tokens;
      const took = Date.parse(child.updatedAt) - Date.parse(child.createdAt);
      block.record = child;
      if (child.turn) {
        block.since = Date.parse(child.turn.startedAt || "") || Date.now();
        setState(block, "working");
        applyActivityPhase(block.node, { state: "working" });
        block.node.open = true;
        build(block);
      } else {
        endBlock(block, outcome, Number.isFinite(took) ? took : 0);
        store.setAgent(id, { outcome, cost: tally.cost });
      }
    } else {
      endBlock(block, outcome, 0);
      if (id) store.setAgent(id, { outcome });
    }
    quoteResult(block, body, kind);
    if (!child?.turn) block.node.open = false;
    return true;
  }

  /** After the record is replayed: a running child without a block gets one, by task or standalone. */
  function bindRunningChildren() {
    for (const child of childRecords.values()) {
      if (!child.turn || byAgent.has(child.id)) continue;
      const task = String(child.task || child.turn.input || "");
      let block = blocks.find((b) => !b.id && b.task.trim() === task.trim()) ?? blocks.find((b) => !b.id) ?? null;
      if (block) bind(block, child.id);
      else block = agentBlock({ id: child.id, task, label: child.label || null });
      block.record = child;
      block.since = Date.parse(child.turn.startedAt || "") || Date.now();
      setState(block, "working");
      if (block.built) fill(block, child);
      else {
        block.node.open = true;
        build(block);
      }
    }
  }

  // ---- the reader's own message ----

  function addLocal(text) {
    live = null;
    pendingRow = userRow(text);
    pendingRow.classList.add("is-pending");
    pendingRow.append(el("span", { class: "pending-note" }, "Sending…"));
  }
  function settleLocal() {
    if (!pendingRow) return;
    pendingRow.classList.remove("is-pending");
    pendingRow.querySelector(".pending-note")?.remove();
    pendingRow = null;
  }
  function failLocal() {
    if (!pendingRow) return;
    pendingRow.classList.replace("is-pending", "is-failed");
    const n = pendingRow.querySelector(".pending-note");
    if (n) n.textContent = "Not sent";
    pendingRow = null;
  }

  /** A saved message from the session record. `usage` is what the gateway recorded for it, if anything. */
  function drawMessage(message, usage) {
    if (message.role === "user") return userRow(message.content);
    if (message.role === "assistant") {
      assistantRow(message.content || "", usage);
      for (const call of message.toolCalls ?? []) {
        if (call.name === SPAWN_TOOL) {
          agentBlock({ callId: call.id, task: call.args?.task, label: call.args?.label, restoring: true });
          continue;
        }
        if (rendered({ type: "tool.call", call }, true)) continue;
        toolCard(call, false, true);
      }
      return;
    }
    if (message.role === "tool") {
      if (message.name === SPAWN_TOOL && restoredAgent(message)) return;
      if (rendered({ type: "tool.result", id: message.toolCallId, name: message.name, result: message.content }, true)) return;
      return toolResult(message.toolCallId, message.name, message.content);
    }
    if (message.content) note(message.content);
  }

  /** One live turn event. `input` accompanies `turn.start`. */
  function applyEvent(event, input) {
    switch (event.type) {
      case "turn.start":
        if (pendingRow) settleLocal();
        else if (input) userRow(input);
        break;
      case "text": {
        const bubble = openLive();
        const delta = event.delta || "";
        bubble.text += delta;
        bubble.textNode.appendData(delta); // one text node grown in place, not the whole reply set again per token
        catchUp();
        break;
      }
      case "tool.call":
        settleLive();
        if (event.call?.name === SPAWN_TOOL) {
          agentBlock({ callId: event.call.id, task: event.call.args?.task, label: event.call.args?.label });
          break;
        }
        if (rendered(event, false)) break;
        toolCard(event.call, true);
        break;
      case "tool.result":
        if ((event.name === SPAWN_TOOL || byCall.has(event.id)) && agentResult(event)) break;
        if (rendered(event, false)) break;
        toolResult(event.id, event.name, event.result);
        break;
      case "message":
        if (event.message?.role !== "assistant") break;
        assistantMessage(event.message.content, event.usage);
        break;
      case "error":
        settleLive();
        settleTools(event.code === "cancelled" ? "stopped" : "no result");
        if (event.code === "cancelled") note("Stopped.", "quiet");
        else note(`The turn failed: ${event.message || "no reason given"}`, "error");
        break;
      case "turn.end":
        settleLive();
        settleTools();
        failLocal();
        run = null;
        break;
      default:
        break;
    }
  }

  /** Rebuilds from a session record, including the turn in progress if there is one. */
  function restore(record) {
    reset();
    restoring = true;
    childRecords = new Map((record.children ?? []).map((c) => [c.id, c]));
    if (childRecords.size) store.setAgents(agentsOfRecord(record));
    (record.conversation ?? []).forEach((message, index) => drawMessage(message, record.usage?.[index]));
    settleTools("no result");
    run = null;
    if (record.turn) {
      userRow(record.turn.input);
      for (const { event } of record.turn.events ?? []) applyEvent(event);
    }
    bindRunningChildren();
    if (!root.childElementCount) showEmpty();
    restoring = false;
    follow = true;
    settle();
  }

  /** After the pane comes back into view: keep following the newest message if we were. */
  function shown() {
    settle();
  }

  showEmpty();
  return { reset, showEmpty, restore, applyEvent, applyChild, revealAgent, addLocal, settleLocal, failLocal, shown, get session() { return session; }, set session(id) { session = id; } };
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

import { contentText, hasMedia, renderContent } from "../lib/content.js";
/* One conversation's transcript. Draws saved messages and applies live turn events on top:
 * `text` grows a live bubble under a caret, `tool.call` opens a card that `tool.result` fills and settles,
 * `message` settles the bubble into rendered markdown with a usage footnote, `error` becomes a note.
 * A settled bubble, live or restored, is then offered to the registered renderers once more as
 * `message.rendered`, so a package may decorate its text; the answer is ignored, the bubble stays the shell's.
 * `stall` and `nudge` are the waiting made visible: a stall turns the running card amber with a line saying
 * what has gone quiet and for how long, and the nudge that follows says what was decided and by whom, in
 * two plainly different looks, because a stall read as a hang is the thing all of this exists to prevent.
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
 * conversation with many finished children would otherwise cost the reader every child's history at once.
 *
 * A turn that did not finish leaves one row that stays, live and on restore: a plain sentence for why
 * (lib/failure.js), the raw message under a Details fold, and one button. [Retry] after a failure and
 * [Continue] after a Stop both ask `POST /api/sessions/<id>/resume`, a turn with no input that carries on
 * over the saved conversation, so nothing the person said is sent twice. While @thetis/harness-core retries a
 * round by itself (its `harness-core.retry` extension events), one row counts down to the next attempt with
 * [Retry now] and [Stop]; the half-drawn round is taken off the page, because it is being thrown away, and
 * the row settles into "Reconnected after N retries" or becomes the failure row. A turn that resumed an
 * interrupted one draws a thin divider ("Resumed after an update"), kept by the gateway so a reopened
 * transcript draws it too. A reply that was cut off is drawn dimmed with "cut off"; a tool call whose
 * arguments are still streaming shows as "writing <tool>… 31k chars" until the call itself arrives. */

import { applyActivityPhase, fmtCost, fmtDuration, fmtTokens } from "../lib/activity.js";
import { api } from "../lib/api.js";
import { agentAvatar, agentName } from "../lib/agent.js";
import { avatarFor } from "../lib/avatar.js";
import { clear, el, icon } from "../lib/dom.js";
import { failureSentence, failureShort, fmtChars, isPause, reasonOf, resumedSentence, retryLead } from "../lib/failure.js";
import { gist, usageLine } from "../lib/transcript-format.js";
import { renderMarkdown } from "../lib/markdown.js";
import { hasRenderers, renderTranscript } from "../lib/registry.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";

/** The per-turn line @thetis/harness-core appends to the person's message; the same pattern the harness exports. */
const TURN_CONTEXT = /\n\n\[Turn context: [^\n\]]*\]$/;

const RESULT_PREVIEW = 4000;
const RUN_FOLD = 4; // a restored run of more tool calls than this starts folded
const DOWN = ["M5 8l5 5 5-5"];
const OPEN_TAB = ["M4 4h6M4 4v6M4 4l7 7", "M9 16h7v-7"];
const FLASH_MS = 1200;
const OWN_CARD = ":scope > .tool-run > .tool-run-body > details.tool"; // this instance's cards, not a nested block's

/** The opening of the tool result @thetis/harness-core writes when a nudge cancelled a call. That package
 *  owns the wording; a browser file cannot import from it, so the pattern is copied here, as the turn
 *  context line above is. It is what lets a reloaded conversation tell a cancel from a failure at all:
 *  `stall` and `nudge` are transient, and the tool message is the only part of it that is saved. */
const NUDGE_CANCELLED = /^error: `[^`]+` was cancelled after running for /;

/** The package whose marks say a saved message was cut off (`partial`) or answers a call that never ran (`notRun`). */
const HARNESS = "@thetis/harness-core";
/** The harness-core UI command that ends a retry's wait at once. */
const RETRY_NOW = "api/ext/@thetis/harness-core/retry-now";

/** The harness's mark on a saved message; a record written before the marks existed has none. */
export function markOf(message, key) {
  return message?.extensions?.[HARNESS]?.[key] === true;
}

/** Asks the gateway to carry a conversation on from where it stopped: a turn with no input. */
export async function resumeSession(id) {
  return api(`/api/sessions/${id}/resume`, { method: "POST" });
}

/** The tool that spawns a subagent, and the first line of its result: `[subagent <id>]` or `[subagent <id> <label>]`. */
export const SPAWN_TOOL = "spawn_subagent";
/** The tool that carries a stopped or failed subagent on. Its result opens with the same line, and it draws into the child's existing block. */
export const RESUME_TOOL = "resume_subagent";
const AGENT_TOOLS = new Set([SPAWN_TOOL, RESUME_TOOL]);
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

/** What a new chat offers to start with. A click puts the words in the box and sends nothing: the person may change them first. */
export const EXAMPLE_PROMPTS = [
  "What can you do here? List the tools you have and what each is for.",
  "Look through the files in my home directory and tell me what is there.",
  "Plan a small project with me step by step, and keep the plan as a todo list.",
];

/**
 * The empty state: "none" when no conversation is open (with a way to start one), "new" for a new chat
 * not yet said anything in (what Thetis can do, and examples that fill the composer through `onExample`),
 * "empty" for a conversation with no messages, "agent" for a subagent that has said nothing.
 */
export function emptyState(kind, onNew, onExample) {
  if (kind === "new") {
    return el(
      "div",
      { class: "transcript-empty is-new" },
      el("span", { class: "empty-mark", "aria-hidden": "true" }, mark()),
      el("span", { class: "empty-lead" }, `${agentName()} works in your own space: it reads and changes your files, runs commands, and plans and carries out longer tasks.`),
      el("div", { class: "empty-examples", role: "group", "aria-label": "Examples to start with" },
        ...EXAMPLE_PROMPTS.map((text) => el("button", { type: "button", class: "empty-example", title: "Put this in the message box", onClick: () => onExample?.(text) }, text)))
    );
  }
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
 * True when the record's saved conversation already ends with the running turn's own input, which is what
 * the kernel writes there as the turn starts. Only one of the two copies may carry the harness's
 * [Turn context: …] line — the record's is saved before the step that appends it runs — so the comparison
 * is made without it.
 */
function carriesTurnInput(record) {
  const inputs = record.turn?.messages;
  if (inputs?.length) {
    const tail = (record.conversation ?? []).slice(-inputs.length);
    const comparable = (message) => {
      const parts = typeof message.content === "string" ? [{ type: "text", data: { text: message.content } }] : message.content;
      const content = parts.flatMap((part) => {
        if (part.type !== "text" || typeof part.data?.text !== "string") return [part];
        const text = part.data.text.replace(TURN_CONTEXT, "");
        return text ? [{ ...part, data: { ...part.data, text } }] : [];
      });
      return JSON.stringify({ role: message.role, content });
    };
    return tail.length === inputs.length && tail.every((message, i) => comparable(message) === comparable(inputs[i]));
  }
  const last = (record.conversation ?? []).at(-1);
  if (!last || last.role !== "user") return false;
  const bare = (text) => contentText(text).replace(TURN_CONTEXT, "").trim();
  return bare(last.content) === bare(record.turn?.input);
}

/**
 * Options: `session` is the conversation drawn. `nested` makes an instance for a subagent's block: it has
 * no jump button and no scroll following of its own (`catchUp` is the outer instance's), offers nothing
 * to the renderers, and draws no user rows. `brief` draws user rows as a subagent's brief (a child's own
 * tab). `onOpenAgent(id)` opens a child in a tab; it is handed down to nested instances.
 */
export function mountTranscript(root, { session, nested = false, brief = false, catchUp: outerCatchUp, onOpenAgent } = {}) {
  let rich = null;
  let live = null;        // { node, textEl, text }
  let thinking = null;    // { node, textNode } collecting streamed reasoning, or null. Per instance, not per module:
                          // a nested agent block has its own instance, and its child's thinking is not this one's.
  let thought = null;     // the thinking row of the round still streaming, folded or not: a retry takes it off the page
  let settled = null;     // the last settled bubble: { node, text }, so the message event can add its usage
  let pendingRow = null;  // the reader's own message awaiting the server's echo
  let run = null;         // the open run of tool cards, or null
  let answered = [];      // renderer hooks waiting for the next user message (an ask form locks itself)
  let follow = true;
  let frame = 0;          // the animation frame booked for the next catch-up, 0 when none
  let restoring = false;  // while a record is replayed nothing scrolls: one catch-up at the end
  let childRecords = new Map(); // child id -> ChildRecord, from the last restored record
  let retry = null;             // the row of a round being retried: { node, text, details, actions, timer, until, next, of, kind, phase, round }
  let tries = 0;                // how many calls the last retried round made, for the failure row that may follow
  let reconnected = null;       // the "Reconnected" row of this turn's last recovered round: { node, round }, taken over if that round drops again
  const writing = new Map();    // tool_call.progress index -> the card of a call whose arguments are still arriving
  const ended = [];             // end rows whose button still offers to carry on; the next turn takes their buttons
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
    if (!jump) return;
    jump.hidden = follow || root.scrollHeight <= root.clientHeight + 8;
    // While the pill shows, the transcript keeps room under its last row for it, so scrolled to the end
    // the last tool group sits above the pill rather than under it.
    root.classList.toggle("has-jump", !jump.hidden);
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
    clearRetry();
    clear(root);
    rich = null;
    live = null;
    thinking = null;
    thought = null;
    settled = null;
    pendingRow = null;
    run = null;
    answered = [];
    follow = true;
    childRecords = new Map();
    blocks.length = 0;
    byAgent.clear();
    byCall.clear();
    writing.clear();
    ended.length = 0;
    tries = 0;
    reconnected = null;
    draw();
  }

  function showEmpty() {
    reset();
    if (!nested) root.append(emptyState(brief ? "agent" : "empty"));
  }

  function face(kind) {
    if (kind === "assistant") return avatarFor("agent", agentName(), agentAvatar());
    const me = store.get("user");
    return kind === "user" && !brief ? avatarFor("person", me?.user || "You", me?.avatar) : null;
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
    // The harness ends each input with a [Turn context: ...] line for the model; the person did not type it.
    const node = row("user", el("div", { class: "msg-text" }, ...renderContent(text, { markdown: false, strip: TURN_CONTEXT })));
    if (brief) node.classList.add("is-brief");
    decorated(node, "user");
    return node;
  }

  function note(text, tone) {
    const node = row("note", el("span", { class: "note-dot" }), el("span", {}, text));
    if (tone) node.classList.add(`is-${tone}`);
    return node;
  }

  // ---- registered renderers: a tool row a package draws instead of the card ----

  function rendererContext(restored) {
    return { session, el, icon, markdown: renderMarkdown, restored, whenAnswered: (fn) => answered.push(fn) };
  }

  /**
   * Offers an event to the renderers: a tool event, a live `extension` event, or a `marker` on restore.
   * True when one took it (and drew, or chose not to). Nothing is offered from a nested instance. A
   * renderer's row is message-level, so it ends the tool run either way.
   */
  function rendered(event, restored) {
    if (nested) return false;
    const out = renderTranscript(event, rendererContext(restored));
    if (!out) return false;
    run = null; // a renderer's row is message-level, like a bubble, not part of a tool run
    if (out instanceof Node) place(out);
    return true;
  }

  /**
   * Offers a complete bubble to the renderers as `message.rendered`: `node` is its `.msg-text`, `restored`
   * says it was built from the record rather than settled live. Whatever they answer is ignored — a
   * renderer decorates the text in place (links, say) and never replaces the row. A nested instance offers
   * its child's bubbles too, under the child's session id.
   */
  function decorated(row, role) {
    const node = row?.querySelector(".msg-text");
    if (!node) return;
    renderTranscript({ type: "message.rendered", role, session, node, restored: restoring }, rendererContext(restoring));
  }

  /**
   * The open thinking block, made on the first chunk. A reasoning model can spend most of a turn here, so the
   * wait is shown as work rather than as a stall — but quietly and in its own fold, because it is not the
   * answer and must never read as one.
   */
  function openThinking() {
    if (thinking) return thinking;
    const textNode = document.createTextNode("");
    const box = el("details", { class: "reasoning", open: "" }, el("summary", {}, "Thinking\u2026"), el("div", { class: "reasoning-text" }, textNode));
    thinking = { node: row("assistant", box), textNode };
    thought = thinking.node;
    return thinking;
  }

  /** Folds the thinking away and says it is over. Called wherever the turn moves on, so it absorbs nothing later. */
  function settleThinking() {
    if (!thinking) return;
    const box = thinking.node.querySelector("details.reasoning");
    thinking = null;
    if (!box) return;
    box.removeAttribute("open");
    const label = box.querySelector("summary");
    if (label) label.textContent = "Thought for a moment";
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
    decorated(bubble.node, "assistant");
    catchUp();
  }

  function assistantRow(text, usage, model, { partial = false } = {}) {
    if (!contentText(text).trim() && !hasMedia(text)) return;
    const textEl = el("div", { class: "msg-text" }, ...renderContent(text));
    const node = row("assistant", textEl, partial ? cutTag() : null, usageLine(usage, model));
    if (partial) node.classList.add("is-partial");
    decorated(node, "assistant");
  }

  function cutTag() {
    return el("span", { class: "msg-cut", title: "The reply stopped part-way here. What it said is kept as it was." }, "cut off");
  }

  /** A live reply the turn stopped under becomes what a reopened transcript draws for it. */
  function markCut(node) {
    if (node.classList.contains("is-partial")) return;
    node.classList.add("is-partial");
    node.insertBefore(cutTag(), node.querySelector(".msg-usage")); // where a restored one has it: after the text, before the footnote
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
    if (rich) { rich.node.remove(); rich = null; }
    if (hasMedia(content)) {
      if (live) { live.node.remove(); live = null; }
      if (settled) { settled.node.remove(); settled = null; }
      return assistantRow(content, usage, liveModel());
    }
    content = contentText(content);
    if (live) { settleLive(content || live.text, usage); settled = null; return; }
    if (settled && settled.text.trim() === (content || "").trim()) {
      const foot = usageLine(usage, liveModel());
      if (foot && !settled.node.querySelector(".msg-usage")) settled.node.append(foot);
      settled = null;
      return;
    }
    settled = null;
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
    for (const card of root.querySelectorAll(`${OWN_CARD}.is-running, ${OWN_CARD}.is-quiet, ${OWN_CARD}[data-await]`)) {
      card.classList.remove("is-running", "is-quiet");
      card.removeAttribute("data-await");
      card.querySelector(".tool-status").textContent = status;
      card.open = false;
    }
    for (const block of blocks) if (block.state === "starting" || block.state === "working") endBlock(block, status === "stopped" ? "stopped" : "failed");
  }

  // ---- stalls and nudges ----
  //
  // A stall is not a failure and not a hang: the work is still running, and the only thing that has happened
  // is that the turn stopped waiting in silence and started asking about it. So it is drawn as work with a
  // reason -- amber, never red, and never a spinner that has stopped -- and the decision that follows is
  // drawn plainly differently depending on which way it went. A reader who cannot tell a continue from a
  // cancel at a glance has been told nothing useful.

  /** The card of a running tool call, or null when nothing here drew one (a renderer took the row, or it is a nested block's). */
  function cardOf(id) {
    return id ? root.querySelector(`${OWN_CARD}[data-tool="${cssEscape(id)}"]`) : null;
  }

  /** The line inside a card that says what is being asked, or what was decided. One per card, replaced in place. */
  function nudgeLine(card, text, tone) {
    let line = card.querySelector(":scope > .tool-nudge");
    if (!line) card.append((line = el("div", { class: "tool-nudge" })));
    line.className = `tool-nudge${tone ? ` is-${tone}` : ""}`;
    line.textContent = text;
    return line;
  }

  function stalled(event) {
    const what = event.what ?? {};
    const quiet = fmtDuration(event.ms || 0);
    if (what.kind === "tool") {
      const card = cardOf(what.id);
      if (card) {
        card.classList.add("is-quiet");
        card.querySelector(".tool-status").textContent = `quiet ${quiet}`;
        nudgeLine(card, `No output for ${quiet}. It is still running; asking the model whether to keep waiting.`);
        return;
      }
    }
    // A quiet model is only waited on: the provider's own watchdog decides when a stream is dead, and nothing
    // asks or cancels here any more. A tool that goes quiet is still asked about.
    note(what.kind === "model" ? `Waiting on the model: nothing for ${quiet} yet. The request is still open.` : `${what.name || "A tool"} has been quiet for ${quiet}. It is still running; asking whether to keep waiting.`, "quiet");
  }

  function decided(event) {
    const what = event.what ?? {};
    const quiet = fmtDuration(event.ms || 0);
    const who = event.by === "model" ? "The model decided" : "Nobody could be asked, so the rule decided";
    const why = event.why || "no reason given";
    if (what.kind === "tool") {
      const card = cardOf(what.id);
      if (card) {
        if (event.decision === "continue") {
          card.classList.remove("is-quiet");
          card.querySelector(".tool-status").textContent = "running";
          nudgeLine(card, `Left running after ${quiet} of silence. ${who}: ${why}`, "continue");
        } else {
          // The `tool.result` that follows carries this same reason to the model. The card only has to make
          // sure the person does not read it as the tool having broken.
          card.dataset.nudged = "cancel";
          card.classList.remove("is-quiet");
          card.querySelector(".tool-status").textContent = "cancelled";
          nudgeLine(card, `Cancelled after ${quiet} of silence. ${who}: ${why}`, "cancel");
        }
        return;
      }
    }
    // A cancelled model call is always followed by the turn's `error`, which carries the same reason. Two
    // red lines saying one thing is worse than one, so this draws nothing and lets that be the row.
    if (what.kind === "model" && event.decision === "cancel") return;
    const subject = what.kind === "model" ? "the model call" : what.name || "the tool";
    if (event.decision === "continue") note(`Still waiting on ${subject} after ${quiet}. ${who}: ${why}`, "quiet");
    else note(`Cancelled ${subject} after ${quiet} of silence. ${who}: ${why}`, "error");
  }

  // ---- a turn that did not finish: the row that stays, and the one button ----

  /**
   * The end row: a sentence, the raw words under Details, and one button that carries the conversation on.
   * `action` is "retry" or "continue", or null for no button (a subagent's nested rows: its block has its
   * own). The row keeps its button until the next turn starts here, whichever way that turn was started.
   */
  function endRow(text, { raw = "", tone = "error", action = null } = {}) {
    const actions = el("span", { class: "end-actions" });
    const node = row("end", el("div", { class: "end-body" }, el("span", { class: "end-text" }, text), raw ? el("details", { class: "end-details" }, el("summary", {}, "Details"), el("pre", { class: "end-raw" }, raw)) : null), actions);
    node.classList.add(`is-${tone}`);
    if (action && !nested) {
      const label = action === "continue" ? "Continue" : "Retry";
      const button = el("button", { type: "button", class: `ghost-btn sm end-action${action === "retry" ? " is-primary" : ""}`, title: action === "continue" ? "Carry on from where it stopped. Nothing is sent again." : "Try again from where it stopped. Everything before is kept, and nothing is sent twice.", onClick: () => { void carryOn(button, label); } }, label);
      actions.append(button);
    }
    // A nested row has no button (its block has its own), but a resume of that subagent takes it away the same.
    if (action) ended.push(node);
    return node;
  }

  async function carryOn(button, label) {
    button.disabled = true;
    button.textContent = label === "Continue" ? "Continuing…" : "Retrying…";
    try {
      await resumeSession(session);
    } catch (err) {
      button.disabled = false;
      button.textContent = label;
      toast(err.status === 409 ? `${label} is not possible: ${err.message}.` : err.message, { tone: "error" });
    }
  }

  /**
   * A new turn has started. A turn with no input carries the stopped one on, so its rows go: the divider it
   * draws says what happened, as a reopened transcript does, where no row is drawn for an `interrupted` the
   * resume cleared. After a turn with input, the rows above it keep their words and lose their buttons.
   */
  function settleEnded(resuming) {
    for (const node of ended.splice(0)) {
      if (resuming) node.remove();
      else node.querySelector(".end-actions")?.replaceChildren();
    }
  }

  /** The row for a turn that failed, from its `error` event or the record's `interrupted`. */
  function failureRow(source, counted = 0) {
    const { message } = reasonOf(source);
    // A planned pause is quiet: it resumes by itself, and Continue is there only if it never does.
    if (isPause(source)) return endRow(failureSentence(source), { raw: message, tone: "quiet", action: "continue" });
    return endRow(failureSentence(source, { tries: counted }), { raw: message, action: "retry" });
  }

  function stoppedRow() {
    return endRow("Stopped.", { tone: "quiet", action: "continue" });
  }

  /** The thin line where a turn carried on from an interrupted one. */
  function divider(why) {
    const node = row("divider", el("span", { class: "divider-text" }, resumedSentence(why)));
    return node;
  }

  /**
   * On a turn with no input, the trailing reply that was cut off goes: the resume drops it before asking
   * the model again, and the saved record keeps it only until the turn's closing save.
   */
  function dropCut() {
    const rows = [...root.children].filter((n) => n.classList?.contains("msg") && !n.classList.contains("is-end") && !n.classList.contains("is-divider") && !n.classList.contains("is-note"));
    const last = rows.at(-1);
    if (last?.classList.contains("is-partial")) last.remove();
  }

  // ---- a round being retried by the harness ----

  function clearRetry() {
    if (retry?.timer) clearInterval(retry.timer);
    retry = null;
  }

  /** Takes the round being thrown away off the page: its live bubble, its thinking, and its half-written tool calls. */
  function withdrawRound() {
    if (live) { live.node.remove(); live = null; }
    if (thinking) { thinking.node.remove(); thinking = null; }
    if (thought) { thought.remove(); thought = null; }
    if (rich) { rich.node.remove(); rich = null; }
    clearWriting();
  }

  function drawRetry() {
    if (!retry) return;
    const left = retry.until ? Math.max(0, Math.ceil((retry.until - Date.now()) / 1000)) : 0;
    // `next` counts calls, the first one included; `of` counts retries, so the calls are one more.
    const count = retry.of ? `(${retry.next} of ${retry.of + 1})` : `(${retry.next})`;
    retry.text.textContent = retry.phase === "waiting" && left > 0 ? `${retryLead(retry.kind)} Retrying in ${left} s ${count}.` : `${retryLead(retry.kind)} Retrying now ${count}…`;
  }

  function retryEvent(data) {
    const phase = data?.phase;
    if (phase === "waiting" || phase === "sending") {
      if (phase === "waiting") withdrawRound();
      // The round that reconnected dropped again: its quiet row gives way to the one counting down, so a
      // round that keeps dropping is one row, not one per attempt.
      if (!retry && reconnected && reconnected.round === data.round) reconnected.node.remove();
      reconnected = null;
      if (!retry) {
        const text = el("span", { class: "end-text" });
        const details = el("pre", { class: "end-raw" });
        const actions = el("span", { class: "end-actions" });
        const node = row("end", el("div", { class: "end-body" }, text, el("details", { class: "end-details" }, el("summary", {}, "Details"), details)), actions);
        node.classList.add("is-retry");
        retry = { node, text, details, actions, timer: 0, until: 0, next: 2, of: 0, kind: undefined, phase };
        actions.append(
          el("button", { type: "button", class: "ghost-btn sm end-action", title: "Stop waiting and try now", onClick: (event) => { void retryNow(event.currentTarget); } }, "Retry now"),
          el("button", { type: "button", class: "ghost-btn sm end-action is-stop", title: "Stop this reply. Everything before is kept.", onClick: () => { void stopTurn(); } }, "Stop"),
        );
      }
      retry.phase = phase;
      retry.round = data.round;
      if (typeof data.kind === "string") retry.kind = data.kind;
      if (typeof data.of === "number") retry.of = data.of;
      // `attempt` is the retry's own number on every phase (harness-core counts retries), so the call it
      // makes is one more: the first retry is the second call.
      retry.next = (Number(data.attempt) || retry.next - 1 || 1) + 1;
      tries = retry.next;
      if (typeof data.reason === "string") retry.details.textContent = data.reason;
      const until = Date.parse(data.until || "");
      retry.until = phase === "waiting" ? (Number.isFinite(until) ? until : Date.now() + (Number(data.inMs) || 0)) : 0;
      if (!retry.timer && phase === "waiting") retry.timer = setInterval(() => { drawRetry(); if (!retry?.until || Date.now() >= retry.until) { clearInterval(retry.timer); if (retry) retry.timer = 0; } }, 1000);
      drawRetry();
      catchUp();
      return;
    }
    // `attempt` on these two is the retry's own number, so the calls made are one more.
    if (phase === "recovered") return recovered((Number(data.attempt) || 1) + 1);
    if (phase === "exhausted") {
      tries = (Number(data.attempt) || Number(data.of) || Math.max(0, tries - 1)) + 1;
      if (reconnected) { reconnected.node.remove(); reconnected = null; }
      if (retry) {
        retry.text.textContent = `${retryLead(retry.kind)} Tried ${tries} times.`;
        retry.actions.replaceChildren();
      }
    }
  }

  /**
   * The round came back: the row settles into one quiet line, and stays as the record of what happened.
   * `attempt` is the call that came back, counting the first, so the retries were one fewer.
   */
  function recovered(attempt = retry?.next ?? 2) {
    if (!retry) return;
    const n = Math.max(1, attempt - 1);
    retry.node.classList.replace("is-retry", "is-quiet");
    retry.text.textContent = `Reconnected after ${n} ${n === 1 ? "retry" : "retries"}.`;
    retry.actions.replaceChildren();
    const node = retry.node;
    const round = retry.round;
    clearRetry();
    tries = 0;
    reconnected = { node, round };
    return node;
  }

  async function retryNow(button) {
    if (button) button.disabled = true;
    try {
      await api(`/${RETRY_NOW}`, { method: "POST", body: { session, args: { session } } });
    } catch (err) {
      toast(err.status === 404 ? "Retry now needs a newer @thetis/harness-core. The retry still happens by itself." : err.message, { tone: "error" });
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function stopTurn() {
    try {
      await api(`/api/sessions/${session}/cancel`, { method: "POST" });
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  // ---- a tool call whose arguments are still arriving ----

  /** `tool_call.progress` from the provider: `{ index, name, chars }`. One provisional card per call, replaced by the real one. */
  function writingProgress(data) {
    const index = String(data?.index ?? 0);
    const name = String(data?.name || "tool");
    let card = writing.get(index);
    if (!card) {
      const r = openRun(false);
      card = el("div", { class: "tool is-running is-writing", "data-writing": index }, el("div", { class: "tool-head" }, el("span", { class: "tool-name" }, name), el("span", { class: "tool-gist" }), el("span", { class: "tool-status" }, "writing")));
      r.node.querySelector(".tool-run-body").append(card);
      writing.set(index, card);
    }
    card.querySelector(".tool-gist").textContent = `writing ${name}… ${fmtChars(Number(data?.chars) || 0)}`;
    catchUp();
  }

  function clearWriting() {
    if (!writing.size) return;
    for (const card of writing.values()) {
      const body = card.parentElement;
      card.remove();
      // A run that held only these cards is empty now: it goes too, and nothing points at it any more.
      if (body && !body.childElementCount) {
        const node = body.parentElement;
        node?.remove();
        if (run?.node === node) run = null;
      }
    }
    writing.clear();
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

  /**
   * Settles one card from its result. A nudge cancel is neither a failure nor a success, and it is told
   * apart from both: amber, badge `cancelled`, and the body not drawn in the error colour. It is recognised
   * from the `data-nudged` this instance set when the `nudge` arrived, and, when there is no such event to
   * have seen, from the result text itself, so a reload of a finished conversation reads the same. A turn's
   * `stall` and `nudge` are transient and nothing saves them; the tool message is what is kept.
   */
  function toolResult(id, name, content, { notRun = false } = {}) {
    const result = contentText(content);
    const failed = /^error:/i.test(result || "") && !notRun;
    const card = id ? root.querySelector(`${OWN_CARD}[data-tool="${cssEscape(id)}"]`) : null;
    if (!card) {
      const cancelled = NUDGE_CANCELLED.test(result || "");
      const node = toolCard({ id, name, args: {} }, false, !live && !pendingRow);
      node.append(...resultSection(result || "", failed && !cancelled));
      mediaAfter(node, content);
      node.classList.toggle("is-bad", failed && !cancelled);
      node.classList.toggle("is-cancelled", cancelled);
      node.classList.toggle("is-not-run", notRun);
      node.querySelector(".tool-status").textContent = notRun ? "not run" : cancelled ? "cancelled" : failed ? "failed" : "done";
      return;
    }
    const cancelled = card.dataset.nudged === "cancel" || NUDGE_CANCELLED.test(result || "");
    card.classList.remove("is-running", "is-quiet");
    card.removeAttribute("data-await");
    card.classList.toggle("is-bad", failed && !cancelled);
    card.classList.toggle("is-cancelled", cancelled);
    card.classList.toggle("is-not-run", notRun);
    card.querySelector(".tool-status").textContent = notRun ? "not run" : cancelled ? "cancelled" : failed ? "failed" : "done";
    const since = Number(card.dataset.since);
    if (since) card.querySelector(".tool-took").textContent = fmtDuration(Date.now() - since);
    card.append(...resultSection(result || "", failed && !cancelled, cancelled ? "why it was cancelled" : undefined));
    mediaAfter(card, content);
    card.open = false;
    catchUp();
  }

  /**
   * What a tool handed back besides text -- a screenshot, most often -- is drawn under its card rather than
   * inside it: the card folds when it settles, and a picture the model just looked at should stay in view.
   * Its run stays open for the same reason, even a restored one long enough to have started folded.
   */
  function mediaAfter(card, content) {
    if (!hasMedia(content)) return;
    card.after(el("div", { class: "tool-media" }, ...renderContent(content.filter((p) => p.type !== "text"))));
    const runNode = card.parentElement?.parentElement;
    if (runNode?.classList.contains("tool-run")) runNode.open = true;
  }

  function resultSection(text, failed, label) {
    label = label ?? (failed ? "error" : "result");
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
    parts.reason = el("span", { class: "agent-reason", hidden: true });
    parts.resume = summaryButton({ class: "agent-resume", title: "Carry this subagent on from where it stopped. Its reply does not go back to a turn that has ended.", "aria-label": "Resume this subagent", hidden: true, onClick: () => { void resumeAgent(block); } }, "Resume");
    parts.open = summaryButton({ class: "agent-open", title: "Open in a tab", "aria-label": "Open this subagent in a tab", onClick: () => { if (block.id) onOpenAgent?.(block.id); } }, icon(OPEN_TAB, { size: 13, width: 1.7 }));
    parts.stop = summaryButton({ class: "agent-stop", title: "Stop this subagent", "aria-label": "Stop this subagent", hidden: true, onClick: () => stopAgent(block) }, "Stop");
    block.node = el(
      "details",
      { class: `agent${restoring ? "" : " is-running"}`, open: restoring ? null : "", "data-call": callId || null, onToggle: () => { if (block.node.open) build(block); } },
      el("summary", { class: "agent-head" }, parts.dot, parts.label, parts.gist, parts.meta, parts.took, parts.state, parts.reason, el("span", { class: "agent-actions" }, parts.resume, parts.open, parts.stop)),
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

  /** `reason` is the one line a failed or stopped child shows beside its badge; any other state clears it. */
  function setState(block, state, reason) {
    block.state = state;
    block.parts.state.textContent = state;
    const running = state === "starting" || state === "working";
    const bad = state === "failed" || state === "stopped";
    block.node.classList.toggle("is-running", running);
    block.node.classList.toggle("is-bad", bad);
    block.parts.stop.hidden = !(running && block.id);
    block.parts.resume.hidden = !(bad && block.id);
    if (!bad) block.reason = "";
    else if (reason) block.reason = reason;
    block.parts.reason.textContent = bad ? block.reason || "" : "";
    block.parts.reason.hidden = !(bad && block.reason);
    block.parts.state.title = bad && block.reason ? `${state}: ${block.reason}` : "";
  }

  function drawMeta(block) {
    const bits = [];
    if (block.steps > 0) bits.push(`${block.steps} ${block.steps === 1 ? "tool call" : "tool calls"}`);
    if (block.cost > 0) bits.push(fmtCost(block.cost));
    if (block.tokens > 0) bits.push(`${fmtTokens(block.tokens)} tok`);
    block.parts.meta.textContent = bits.join(" · ");
  }

  /** The child ended: the state word (and why, when it failed), the meta line, the duration, and the block folds itself. */
  function endBlock(block, state, took = Date.now() - block.since, reason) {
    if (block.state === "done" || block.state === "failed" || block.state === "stopped") return;
    setState(block, state, reason);
    drawMeta(block);
    if (took > 0) block.parts.took.textContent = fmtDuration(took);
    block.node.open = false;
    catchUp();
  }

  async function resumeAgent(block) {
    if (!block.id) return;
    block.parts.resume.disabled = true;
    try {
      await resumeSession(block.id);
    } catch (err) {
      toast(err.status === 409 ? `The subagent was not resumed: ${err.message}.` : err.message, { tone: "error" });
    } finally {
      block.parts.resume.disabled = false;
    }
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

  /** Quotes the result under the block, unless it is the reply the child's own last row already shows. A resume's result replaces the one before it. */
  function quoteResult(block, body, kind) {
    for (const node of block.quoted ?? []) node.remove();
    block.quoted = [];
    if (kind === "done" && body.trim() === String(block.lastReply || "").trim()) return;
    block.quoted = resultSection(body, kind === "failed", kind === "failed" ? "error" : kind === "stopped" ? "stopped" : "reply");
    block.node.append(...block.quoted);
  }

  /**
   * A `resume_subagent` call: the child it names already has a block (the spawn drew it, live or on
   * restore), and the resume is that block carrying on — the call's id is bound to it, and it opens again
   * as working. A child with no block here yet (its spawn is in a part of the conversation not drawn) gets one.
   */
  function resumedAgent(call, restoring) {
    const id = typeof call.args?.id === "string" ? call.args.id : null;
    let block = id ? byAgent.get(id) : null;
    if (!block) return agentBlock({ callId: call.id, id, task: (id && store.agent(id)?.task) || "", label: call.args?.label || (id && store.agent(id)?.label) || null, restoring });
    byCall.set(call.id, block);
    if (!restoring) {
      setState(block, "working");
      applyActivityPhase(block.node, { state: "working" });
      block.since = Date.now();
      block.node.open = true;
      build(block);
    }
    return block;
  }

  /** The `tool.result` of a spawn call: binds the block by id when it is still unbound, settles it, and quotes the reply. */
  function agentResult(event) {
    const { id, label, body, kind } = parseSpawnResult(event.result);
    let block = byCall.get(event.id) ?? (id ? byAgent.get(id) : null);
    if (!block && !id) return false; // a spawn that made no child and has no block: the plain tool card says what happened
    // A resume that could not start (the child was busy, say) leaves the block as it was, said under it.
    if (block && event.name === RESUME_TOOL && block.state !== "starting" && block.state !== "working") block.state = "resuming";
    if (!block) block = agentBlock({ id, task: store.agent(id)?.task || "", label: store.agent(id)?.label || label });
    if (id && !block.id) bind(block, id);
    const reason = kind === "failed" ? failureShort({ message: body }) : undefined;
    endBlock(block, kind, undefined, reason);
    if (kind !== "done" && block.state !== kind) setState(block, kind, reason); // the child ended, then the spawn itself reported otherwise
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
        if (event.message?.role === "assistant" && contentText(event.message.content).trim()) block.lastReply = contentText(event.message.content);
        break;
      case "error": {
        const stopped = event.code === "cancelled" && !reasonOf(event).why;
        endBlock(block, stopped ? "stopped" : "failed", undefined, stopped ? "stopped by a person" : failureShort(event));
        break;
      }
      case "turn.end":
        endBlock(block, "done");
        break;
      default:
        break;
    }
    build(block);
    block.nested.applyEvent(event, message.input, message.messages);
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
    const parsed = parseSpawnResult(contentText(message.content));
    const { label, body, kind } = parsed;
    let id = parsed.id;
    let block = byCall.get(message.toolCallId) ?? (id ? byAgent.get(id) : null);
    if (!block && !id) return false;
    // A resume's result settles the block its spawn already settled: its outcome is the one that stands now.
    if (block && message.name === RESUME_TOOL) block.state = "resuming";
    // A spawn that ended in an error names no child; the child it made, when it made one, is the unreferenced record with its task.
    if (block && !id && !block.id) id = [...childRecords.values()].find((c) => !byAgent.has(c.id) && String(c.task || "").trim() === block.task.trim())?.id ?? null;
    const child = id ? childRecords.get(id) : null;
    if (!block) block = agentBlock({ id, task: child?.task || "", label: child?.label || label, restoring: true });
    if (id && !block.id) bind(block, id);
    const outcome = kind;
    if (child) block.lastReply = contentText([...(child.conversation ?? [])].reverse().find((m) => m.role === "assistant" && contentText(m.content).trim())?.content);
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
        endBlock(block, outcome, Number.isFinite(took) ? took : 0, outcome === "failed" ? failureShort(child.interrupted ?? { message: body }) : undefined);
        store.setAgent(id, { outcome, cost: tally.cost });
      }
    } else {
      endBlock(block, outcome, 0, outcome === "failed" ? failureShort({ message: body }) : undefined);
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
      assistantRow(message.content || "", usage, undefined, { partial: markOf(message, "partial") });
      for (const call of message.toolCalls ?? []) {
        if (call.name === SPAWN_TOOL) {
          agentBlock({ callId: call.id, task: call.args?.task, label: call.args?.label, restoring: true });
          continue;
        }
        if (call.name === RESUME_TOOL) {
          resumedAgent(call, true);
          continue;
        }
        if (rendered({ type: "tool.call", call }, true)) continue;
        toolCard(call, false, true);
      }
      return;
    }
    if (message.role === "tool") {
      if (AGENT_TOOLS.has(message.name) && restoredAgent(message)) return;
      if (rendered({ type: "tool.result", id: message.toolCallId, name: message.name, result: contentText(message.content), content: message.content }, true)) return;
      return toolResult(message.toolCallId, message.name, message.content, { notRun: markOf(message, "notRun") });
    }
    if (contentText(message.content)) note(contentText(message.content));
  }

  /** One live turn event. `input` accompanies `turn.start`. */
  function applyEvent(event, input, messages) {
    switch (event.type) {
      case "turn.start": {
        const noInput = !pendingRow && !String(input ?? "").trim() && !messages?.length;
        settleEnded(noInput && !restoring);
        clearRetry();
        tries = 0;
        reconnected = null;
        if (noInput && !restoring) dropCut();
        if (pendingRow) settleLocal();
        else if (messages?.length) { for (const message of messages) drawMessage(message); }
        else if (input) userRow(input);
        if (event.resumed) divider(event.resumed.why === "yield" && event.resumed.for ? event.resumed.for : event.resumed.why);
        break;
      }
      case "text": {
        const delta = event.delta || "";
        if (!delta) break;
        // The answer has begun, so the thinking is done: fold it rather than leave a wall of it above the reply.
        settleThinking();
        if (retry?.phase === "sending") recovered();
        const bubble = openLive();
        bubble.text += delta;
        bubble.textNode.appendData(delta); // one text node grown in place, not the whole reply set again per token
        catchUp();
        break;
      }
      case "content.start":
      case "content.delta":
      case "content.end": {
        settleThinking();
        if (!rich) rich = { node: row("assistant", el("div", { class: "msg-text" })), parts: new Map() };
        if (event.part) rich.parts.set(event.part.id, structuredClone(event.part));
        else {
          const part = rich.parts.get(event.partId);
          if (part?.type === "text" && typeof event.delta === "string") part.data.text += event.delta;
        }
        clear(rich.node.querySelector(".msg-text")).append(...renderContent([...rich.parts.values()]));
        catchUp();
        break;
      }
      case "reasoning": {
        const delta = event.delta || "";
        if (!delta) break;
        const box = openThinking();
        box.textNode.appendData(delta); // grown in place, like the live bubble: a long think is many chunks
        catchUp();
        break;
      }
      case "tool.call":
        settleThinking();
        settleLive();
        clearWriting();
        thought = null; // the round's stream is over: nothing of it can be thrown away now
        if (retry?.phase === "sending") recovered();
        if (event.call?.name === RESUME_TOOL) {
          resumedAgent(event.call, false);
          break;
        }
        if (event.call?.name === SPAWN_TOOL) {
          agentBlock({ callId: event.call.id, task: event.call.args?.task, label: event.call.args?.label });
          break;
        }
        if (rendered(event, false)) break;
        toolCard(event.call, true);
        break;
      case "tool.result":
        if ((AGENT_TOOLS.has(event.name) || byCall.has(event.id)) && agentResult(event)) break;
        if (rendered(event, false)) break;
        toolResult(event.id, event.name, event.content ?? event.result);
        break;
      case "stall":
        settleThinking();
        stalled(event);
        break;
      case "nudge":
        settleThinking();
        decided(event);
        break;
      case "message":
        settleThinking();
        clearWriting();
        thought = null;
        if (retry?.phase === "sending") recovered();
        if (event.message?.role !== "assistant") break;
        assistantMessage(event.message.content, event.usage);
        break;
      case "error": {
        settleThinking();
        // What was streaming when the turn stopped is kept in the record marked `partial`: draw it the way a
        // reopened transcript does, so a resume takes it off the page here too.
        const cut = live;
        settleLive();
        if (cut?.node.parentElement) markCut(cut.node);
        clearWriting();
        const stopped = event.code === "cancelled" && !reasonOf(event).why;
        settleTools(stopped ? "stopped" : "no result");
        // The retry row, when there is one, is what this row replaces: one row for one stop.
        const counted = tries;
        if (retry) { retry.node.remove(); clearRetry(); }
        if (stopped) stoppedRow();
        else failureRow(event, counted);
        tries = 0;
        break;
      }
      case "turn.end":
        settleThinking();
        settleLive();
        settleTools();
        clearWriting();
        failLocal();
        if (retry) recovered();
        run = null;
        break;
      case "extension":
        // The shell's own two: a round being retried, and a tool call whose arguments are still arriving.
        if (event.name === "harness-core.retry") { retryEvent(event.data); break; }
        if (event.name === "tool_call.progress" && !rendered(event, false)) { writingProgress(event.data); break; }
        // A package's own event, live: offered to the renderers (a compaction draws its card from these) and
        // otherwise nothing, since the shell has no row for an event it does not understand.
        rendered(event, false);
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
    // A marker is offered before each saved message and once after the last, so a package can draw
    // something that belongs between messages rather than to one (a compaction's card at its cut). The
    // check is on the registry, not per offer: with nothing registered, a long conversation pays nothing.
    const conversation = record.conversation ?? [];
    const offer = !nested && hasRenderers() ? (index) => rendered({ type: "marker", index, session, record }, true) : () => false;
    // The gateway's own markers: where a turn resumed an interrupted one. The running turn's divider is
    // drawn by its replayed `turn.start`, so its mark is left out here.
    const dividers = new Map();
    for (const mark of record.resumed ?? []) {
      if (record.turn?.turn && mark.turn === record.turn.turn) continue;
      const at = Math.min(Number(mark.index) || 0, conversation.length);
      dividers.set(at, [...(dividers.get(at) ?? []), mark]);
    }
    const marker = (index) => {
      for (const mark of dividers.get(index) ?? []) divider(mark.why);
      offer(index);
    };
    // While a turn with no input runs, the reply it carries on from is cut off and about to be dropped.
    const resuming = record.turn && !String(record.turn.input ?? "").trim() && !record.turn.messages?.length;
    conversation.forEach((message, index) => {
      marker(index);
      if (resuming && index === conversation.length - 1 && message.role === "assistant" && markOf(message, "partial")) return;
      drawMessage(message, record.usage?.[index]);
    });
    marker(conversation.length);
    settleTools("no result");
    run = null;
    if (!record.turn) {
      // The last turn did not finish: its row stays until the next one starts. Interrupted wins, because it
      // says why; a Stop leaves no `interrupted`, so it is read off the gateway's own mark or the cut reply.
      const last = conversation.at(-1);
      const cut = last && ((last.role === "assistant" && markOf(last, "partial")) || (last.role === "tool" && markOf(last, "notRun")));
      if (record.interrupted) failureRow(record.interrupted);
      else if (record.stopped || cut) stoppedRow();
    }
    if (record.turn) {
      // The kernel writes the turn's input into the record the moment the turn starts, so `conversation`
      // normally already ends with the very message `turn.input` holds, and the loop above has just drawn
      // it. Drawing it again put the person's own message on the page twice on every refresh made while a
      // turn was running, and the copy stayed there until the next reload. The input is drawn here only
      // when the record does not carry it — a turn whose opening save has not landed, or a record written
      // by an older kernel — so nothing the person said is ever lost either.
      if (!carriesTurnInput(record)) {
        if (record.turn.messages) for (const message of record.turn.messages) drawMessage(message);
        else userRow(record.turn.input);
      }
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

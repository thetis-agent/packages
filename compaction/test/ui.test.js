// The browser module over a fake seam: the chip's text and classes follow the state view and the live
// stream, the transcript renderer draws one card per compaction and updates it in place, a marker draws
// the finished card at the cut and nowhere else, and the dock's actions send the declared verbs. The
// DOM is gateway-web's fixture, so `instanceof Node` and `classList` behave as the shell expects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../../gateway-web/test/dom-fixture.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "ui", "index.js");
const { default: install, tokens } = await import(entry);

const NAME = "@thetis/compaction";
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The shell's `el`, as dom.js writes it: props become attributes, `on*` become listeners, children flatten. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
const setHidden = (node, hide) => (hide ? node.setAttribute("hidden", "") : node.removeAttribute("hidden"));
const text = (node) => node.textContent;
const find = (node, cls) => node.querySelectorAll(`.${cls}`);
const buttonNamed = (node, label) => node.querySelectorAll("button").find((b) => text(b) === label);

const freshState = () => ({ version: 1, cut: 0, summary: null, compactions: 0, failures: 0, ledger: [] });
const LAST = { at: "2026-09-25T12:03:00.000Z", turn: "t_9", round: 1, cut: 84, from: 0, tokensBefore: 730_000, tokensAfter: 21_000, cost: 0.41, model: "anthropic/claude", ms: 40_000, messages: 84, trigger: "auto" };
const compacted = () => ({ ...freshState(), cut: 84, summary: "# Summary\n\nThe person asked for **a page**.", compactions: 1, last: LAST, ledger: [{ at: LAST.at, kind: "compact", trigger: "auto", cut: 84, from: 0, tokensBefore: 730_000, tokensAfter: 21_000, cost: 0.41, model: "anthropic/claude" }] });

/** A state view as `compaction-state` answers it: a 1M window, the trigger at 75%, 14% used unless told otherwise. */
function view(overrides = {}) {
  return {
    enabled: true, model: "anthropic/claude", window: 1_000_000, threshold: 0.75, trigger: 750_000,
    used: 142_000, estimated: false, state: freshState(), pending: null, status: "idle", turns: 3,
    sentence: "Auto compaction is on; the conversation is at 14% of the window and compacts at 75%.",
    ...overrides,
  };
}

/**
 * An ext that records registrations and answers requests only when the test says so, in order. `draw` stands
 * for the dock showing the entry and holds the body as connected, as the real dock does; `chip` draws the
 * chip for a pane and answers the button.
 */
function fakeExt(current = null) {
  const log = { chips: {}, docks: {}, renderers: [], requests: [], pending: [], redraws: 0, watchers: [], turnWatchers: [], opened: [], toasts: [], confirms: [] };
  let confirmAnswer = true;
  const ext = {
    package: NAME,
    chip: (id, impl) => (log.chips[id] = impl),
    dock: (id, impl) => (log.docks[id] = impl),
    transcript: (render) => log.renderers.push(render),
    request: (verb, opts) => {
      log.requests.push({ verb, ...opts });
      return new Promise((resolve, reject) => log.pending.push({ resolve, reject }));
    },
    redraw: () => log.redraws++,
    can: () => true,
    conversation: { get current() { return current; }, watch: (fn) => log.watchers.push(fn) },
    events: { watch: (fn) => log.turnWatchers.push(fn) },
    open: { dock: (id) => log.opened.push(id) },
    dom: { el, setHidden, clear: (n) => n.replaceChildren() },
    ui: {
      kv: (pairs) => el("dl", { class: "kv" }, ...pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v ?? "—")])),
      section: (label, note) => el("div", { class: "section-head" }, el("span", { class: "section-label" }, label), note && el("span", { class: "section-note" }, note)),
      button: (label, { tone = "quiet", onClick, title, type = "button", disabled } = {}) => el("button", { type, class: `btn is-${tone}`, title, disabled, onClick }, label),
      confirm: (anchor, opts) => {
        log.confirms.push({ anchor, ...opts });
        return Promise.resolve(confirmAnswer);
      },
    },
    toast: (message, opts) => log.toasts.push({ message, ...opts }),
    markdown: (md) => el("div", { class: "md" }, md),
  };
  const answer = (data) => log.pending.shift().resolve({ data });
  const refuse = (message) => log.pending.shift().reject(new Error(message));
  const go = (id) => {
    current = id;
    for (const fn of log.watchers) fn(id);
  };
  const event = (session, ev) => {
    for (const fn of log.turnWatchers) fn({ session, turn: "t_1", seq: 1, event: ev });
  };
  const chip = (session = current) => {
    const button = el("button", { type: "button", class: "chip-quiet chip" });
    log.chips.context.draw(button, { session });
    return button;
  };
  let shown = null;
  const close = () => {
    if (shown) shown.isConnected = false;
    shown = null;
  };
  const draw = () => {
    close();
    const out = log.docks.compaction.draw();
    shown = out.body;
    shown.isConnected = true;
    return out;
  };
  const render = (ev, session = current) => log.renderers[0](ev, { session, el, markdown: ext.markdown, restored: false });
  return { ext, log, answer, refuse, go, event, chip, draw, close, render, setConfirm: (value) => (confirmAnswer = value) };
}

/** Opens `session` and answers its first state request with `data`. */
async function opened(f, session, data) {
  f.go(session);
  f.answer(data);
  await tick();
}

const compaction = (phase, extra = {}) => ({ type: "extension", name: NAME, data: { phase, trigger: "auto", used: 730_000, window: 1_000_000, threshold: 0.75, cut: 84, from: 0, messages: 84, detail: "", ...extra } });

// ---- the module and the manifest ----

test("the module parses, registers the declared chip, dock and verbs, and builds DOM without innerHTML or styles", async () => {
  execFileSync(process.execPath, ["--check", entry], { stdio: "pipe" });
  assert.equal(typeof install, "function");
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const ui = manifest.thetis.ui;
  for (const file of [ui.entry, ui.style]) await readFile(resolve(root, ui.dir, file));
  const f = fakeExt();
  install(f.ext);
  assert.deepEqual(Object.keys(f.log.chips), ui.chips.map((c) => c.id));
  assert.deepEqual(Object.keys(f.log.docks), ui.dock.map((d) => d.id));
  assert.equal(f.log.renderers.length, 1);
  assert.deepEqual(f.log.requests, [], "nothing is asked at install time");
  const source = await readFile(entry, "utf8");
  for (const { verb } of ui.commands) assert.ok(source.includes(`"${verb}"`), `sends ${verb}`);
  assert.doesNotMatch(source, /innerHTML|\.style\b|style=/, "builds DOM through ext.dom, with no inline styles");
});

test("the token format mirrors the shell's: 730k, 21k, 1.2M, and a round million reads 1M", () => {
  assert.equal(tokens(730_000), "730k");
  assert.equal(tokens(21_000), "21k");
  assert.equal(tokens(1_234), "1.2k");
  assert.equal(tokens(999), "999");
  assert.equal(tokens(1_200_000), "1.2M");
  assert.equal(tokens(1_000_000), "1M");
  assert.equal(tokens(1_050_000), "1.05M");
});

// ---- the chip ----

test("the chip is hidden without a figure, and shows ctx 14% with the exact title once the state is known", async () => {
  const f = fakeExt();
  install(f.ext);
  assert.equal(f.chip("s_1").getAttribute("hidden"), "", "no conversation, no figure");
  f.go("s_1");
  assert.deepEqual(f.log.requests, [{ verb: "compaction-state", session: "s_1" }], "opening a conversation asks once");
  assert.equal(f.chip().getAttribute("hidden"), "", "still hidden while the answer is on its way");
  f.answer(view());
  await tick();
  const button = f.chip();
  assert.equal(button.getAttribute("hidden"), null);
  assert.equal(text(button), "ctx 14%");
  assert.equal(button.title, "142k of 1M tokens · auto-compacts at 75%");
  assert.ok(button.classList.contains("mono"));
  assert.ok(!button.classList.contains("is-warn") && !button.classList.contains("is-err"));
  f.log.chips.context.open();
  assert.deepEqual(f.log.opened, ["compaction"], "a click opens the dock");
});

test("the chip turns amber from 60% of the window and red from the trigger", async () => {
  const f = fakeExt();
  install(f.ext);
  await opened(f, "s_1", view({ used: 650_000 }));
  let button = f.chip();
  assert.equal(text(button), "ctx 65%");
  assert.ok(button.classList.contains("is-warn"));
  assert.ok(!button.classList.contains("is-err"));
  await opened(f, "s_2", view({ used: 800_000 }));
  button = f.chip();
  assert.equal(text(button), "ctx 80%");
  assert.ok(button.classList.contains("is-err"));
  assert.ok(!button.classList.contains("is-warn"), "over the trigger is red, not amber as well");
});

test("a usage event for the conversation moves the figure and redraws; one for another conversation leaves it", async () => {
  const f = fakeExt();
  install(f.ext);
  await opened(f, "s_1", view());
  const redraws = f.log.redraws;
  f.event("s_other", { type: "usage", usage: { prompt_tokens: 900_000, completion_tokens: 10 } });
  assert.equal(text(f.chip()), "ctx 14%");
  f.event("s_1", { type: "usage", usage: { prompt_tokens: 600_000, completion_tokens: 50_000 } });
  assert.ok(f.log.redraws > redraws, "the event redraws");
  const button = f.chip();
  assert.equal(text(button), "ctx 65%", "used = prompt_tokens + completion_tokens");
  assert.ok(button.classList.contains("is-warn"));
  assert.equal(f.log.requests.length, 1, "a usage event asks nothing");
});

test("planning sets compacting… and is-busy; finished shows the reduced figure; turn.end asks for the state again", async () => {
  const f = fakeExt();
  install(f.ext);
  await opened(f, "s_1", view({ used: 730_000 }));
  f.event("s_1", compaction("planning"));
  let button = f.chip();
  assert.equal(text(button), "compacting…");
  assert.ok(button.classList.contains("is-busy"));
  assert.ok(!button.classList.contains("is-err"), "the busy chip carries no tone");
  f.event("s_1", compaction("summarizing", { model: "anthropic/claude" }));
  assert.equal(text(f.chip()), "compacting…");
  f.event("s_1", compaction("finished", { tokensAfter: 21_000, cost: 0.41, ms: 40_000 }));
  button = f.chip();
  assert.equal(text(button), "ctx 2%", "the finished event carries the new size");
  assert.ok(!button.classList.contains("is-busy"));
  assert.equal(f.log.requests.length, 1, "with the dock closed, a finished compaction asks nothing yet");
  f.event("s_1", { type: "turn.end" });
  assert.equal(f.log.requests.length, 2, "the end of a turn refreshes the state");
  f.answer(view({ used: 25_000, state: compacted() }));
  await tick();
  assert.equal(text(f.chip()), "ctx 3%", "the answer replaces the live figure");
});

// ---- the transcript renderer ----

test("a planning event draws a busy card; later phases update it in place and answer true", () => {
  const f = fakeExt("s_1");
  install(f.ext);
  const card = f.render(compaction("planning"));
  assert.ok(card instanceof Node, "the first event answers the node to place");
  assert.ok(card.classList.contains("compaction-card") && card.classList.contains("is-busy"));
  assert.equal(text(find(card, "cmp-card-text")[0]), "Compacting… summarizing 84 messages (≈730k tokens)");
  card.isConnected = true;
  assert.equal(f.render(compaction("summarizing")), true);
  assert.ok(card.classList.contains("is-busy"));
  assert.equal(f.render(compaction("finished", { tokensAfter: 21_000, cost: 0.41 })), true);
  assert.ok(card.classList.contains("is-done") && !card.classList.contains("is-busy"));
  assert.equal(text(find(card, "cmp-card-text")[0]), "Context compacted: 84 earlier messages summarized (730k → 21k tokens, $0.41)");
  const fold = find(card, "cmp-card-fold")[0];
  assert.ok(fold, "the finished card has a summary fold");
  assert.equal(text(fold.querySelector("summary")), "Show summary");
  assert.equal(f.log.requests.length, 0, "the summary is not fetched until the fold opens");

  const next = f.render(compaction("planning"));
  assert.ok(next instanceof Node && next !== card, "a new compaction starts a new card");
  next.isConnected = true;
  assert.equal(f.render(compaction("failed", { detail: "the summary was not smaller than what it replaces" })), true);
  assert.ok(next.classList.contains("is-failed"));
  assert.equal(text(find(next, "cmp-card-text")[0]), "Compaction failed: the summary was not smaller than what it replaces");
  assert.ok(card.classList.contains("is-done"), "the earlier card is untouched");
});

test("opening the finished card's fold fetches the summary through compaction-state and renders it as markdown", async () => {
  const f = fakeExt("s_1");
  install(f.ext);
  const card = f.render(compaction("planning"));
  card.isConnected = true;
  f.render(compaction("finished", { tokensAfter: 21_000 }));
  const fold = find(card, "cmp-card-fold")[0];
  fold.open = true;
  fold.dispatchEvent({ type: "toggle", target: fold, currentTarget: fold });
  assert.deepEqual(f.log.requests, [{ verb: "compaction-state", session: "s_1" }]);
  assert.match(text(fold), /Reading the summary/);
  f.answer(view({ state: compacted() }));
  await tick();
  assert.equal(text(find(fold, "md")[0]), compacted().summary);
  fold.dispatchEvent({ type: "toggle", target: fold, currentTarget: fold });
  assert.equal(f.log.requests.length, 1, "fetched once");
});

test("other events, and extension events of other packages, fall through", () => {
  const f = fakeExt("s_1");
  install(f.ext);
  assert.equal(f.render({ type: "tool.call", call: { name: "exec" } }), null);
  assert.equal(f.render({ type: "extension", name: "@thetis/other", data: { phase: "planning" } }), null);
  assert.equal(f.render({ type: "message.rendered", role: "assistant" }), null);
});

test("a marker at the cut draws the finished card from the record; any other index draws nothing", () => {
  const f = fakeExt("s_1");
  install(f.ext);
  const record = { id: "s_1", conversation: Array.from({ length: 90 }, () => ({ role: "user", content: "x" })), harness: { [NAME]: compacted() } };
  const marker = (index, rec = record) => f.render({ type: "marker", index, session: "s_1", record: rec });
  assert.equal(marker(0), null);
  assert.equal(marker(83), null);
  assert.equal(marker(90), null);
  const card = marker(84);
  assert.ok(card instanceof Node);
  assert.ok(card.classList.contains("compaction-card") && card.classList.contains("is-done"));
  assert.equal(text(find(card, "cmp-card-text")[0]), "Context compacted: 84 earlier messages summarized (730k → 21k tokens, $0.41)");
  const fold = find(card, "cmp-card-fold")[0];
  fold.open = true;
  fold.dispatchEvent({ type: "toggle", target: fold, currentTarget: fold });
  assert.equal(f.log.requests.length, 0, "a restored card has the summary in the record");
  assert.equal(text(find(fold, "md")[0]), compacted().summary);
  assert.equal(marker(84, { ...record, harness: { [NAME]: freshState() } }), null, "cut 0 is not a cut");
  assert.equal(marker(84, { ...record, harness: {} }), null);
});

// ---- the dock ----

test("the dock shows the meter, the sentence, the actions and the hint; Compact on next message sends the focus text", async () => {
  const f = fakeExt();
  install(f.ext);
  await opened(f, "s_1", view());
  let out = f.draw();
  assert.equal(out.title, "Compaction");
  assert.equal(out.subtitle, "14% · 142k of 1M");
  assert.equal(f.log.requests.length, 1, "the view was read on open; drawing asks nothing more");
  const content = text(out.body);
  assert.ok(content.includes("Auto compaction is on; the conversation is at 14% of the window and compacts at 75%."), "the server's sentence");
  assert.ok(content.includes("142k of 1M tokens · 14%"));
  assert.ok(content.includes("compacts at 750k (75%)"));
  assert.ok(content.includes("Control panel → Packages → compaction"));
  assert.equal(find(out.body, "cmp-cell").length, 40);
  assert.equal(find(out.body, "is-on").length, 6, "14% of forty cells");
  assert.equal(find(out.body, "cmp-cell").findIndex((c) => c.classList.contains("is-tick")), 30, "the tick sits at 75%");
  assert.equal(find(out.body, "cmp-fold").length, 0, "no summary yet, no fold");
  assert.equal(find(out.body, "cmp-ledger").length, 0);
  assert.deepEqual(out.actions.map(text), ["Refresh"]);

  const focus = find(out.body, "cmp-focus")[0];
  focus.value = "keep the file list";
  buttonNamed(out.body, "Compact on next message").click();
  assert.deepEqual(f.log.requests.at(-1), { verb: "compaction-request", session: "s_1", args: { instructions: "keep the file list" } });
  assert.equal(buttonNamed(f.draw().body, "Compact on next message").getAttribute("disabled"), "", "the button waits for the answer");
  f.answer({ pending: { at: "2026-09-25T12:10:00.000Z", instructions: "keep the file list" } });
  await tick();
  assert.equal(f.log.requests.at(-1).verb, "compaction-state", "the sentence is the server's, so it is read again");
  f.answer(view({ pending: { at: "2026-09-25T12:10:00.000Z", instructions: "keep the file list" }, sentence: "A compaction is requested and runs at the start of the next message." }));
  await tick();
  out = f.draw();
  assert.ok(text(out.body).includes("A compaction is requested and runs at the start of the next message."));
  assert.match(text(find(out.body, "cmp-pending")[0]), /a compaction focused on “keep the file list” at the start of the next message/);
  assert.equal(buttonNamed(out.body, "Compact on next message").getAttribute("disabled"), null);
});

test("an empty focus field sends no instructions", async () => {
  const f = fakeExt();
  install(f.ext);
  await opened(f, "s_1", view());
  const out = f.draw();
  buttonNamed(out.body, "Compact on next message").click();
  assert.deepEqual(f.log.requests.at(-1), { verb: "compaction-request", session: "s_1", args: { instructions: undefined } });
});

test("Send the full history again is disabled with nothing compacted, asks through the confirm popover, and sends the reset on yes", async () => {
  const f = fakeExt();
  install(f.ext);
  await opened(f, "s_1", view());
  assert.equal(buttonNamed(f.draw().body, "Send the full history again").getAttribute("disabled"), "");
  await opened(f, "s_2", view({ used: 25_000, state: compacted(), sentence: "84 messages are summarized (compacted 1 time, last 12:03, auto, 730k → 21k tokens, $0.41)." }));
  let out = f.draw();
  const content = text(out.body);
  assert.ok(content.includes("84 messages are summarized"));
  assert.ok(content.includes("Summary of the first 84 messages"), "the summary fold");
  assert.equal(text(find(out.body, "md")[0]), compacted().summary, "rendered through ext.markdown");
  assert.equal(find(out.body, "cmp-ledger-row").length, 1);
  assert.match(text(find(out.body, "cmp-ledger-row")[0]), /^\d\d:\d\d · auto · 84 msgs · 730k → 21k · \$0\.41$/);

  f.setConfirm(false);
  const reset = buttonNamed(out.body, "Send the full history again");
  assert.equal(reset.getAttribute("disabled"), null);
  reset.click();
  await tick();
  assert.equal(f.log.confirms.length, 1);
  assert.equal(f.log.confirms[0].anchor, reset, "the popover is anchored on the button");
  assert.equal(f.log.confirms[0].title, "Send the full history again?");
  assert.equal(f.log.requests.at(-1).verb, "compaction-state", "declined: nothing was sent");
  f.setConfirm(true);
  reset.click();
  await tick();
  assert.deepEqual(f.log.requests.at(-1), { verb: "compaction-reset", session: "s_2", args: {} });
  f.answer({ pending: { at: "2026-09-25T12:11:00.000Z", reset: true } });
  await tick();
  f.answer(view({ used: 25_000, state: compacted(), pending: { at: "2026-09-25T12:11:00.000Z", reset: true } }));
  await tick();
  out = f.draw();
  assert.match(text(find(out.body, "cmp-pending")[0]), /the full history is sent again at the start of the next message/);
  assert.equal(buttonNamed(out.body, "Send the full history again").getAttribute("disabled"), "", "a pending reset is not asked for twice");
});

test("the dock leads with the failure reason after a failed attempt, and the ledger says what failed", async () => {
  const f = fakeExt();
  install(f.ext);
  const state = { ...freshState(), failures: 1, lastFailure: { at: LAST.at, reason: "the model called a tool instead of writing the summary" }, ledger: [{ at: LAST.at, kind: "failed", trigger: "auto", cut: 84, from: 0, reason: "the model called a tool instead of writing the summary" }] };
  await opened(f, "s_1", view({ used: 760_000, state }));
  const out = f.draw();
  assert.match(text(find(out.body, "cmp-failure")[0]), /Last attempt, \d\d:\d\d: the model called a tool instead of writing the summary/);
  assert.match(text(find(out.body, "cmp-ledger-row")[0]), /failed: the model called a tool/);
  assert.ok(find(out.body, "cmp-ledger-row")[0].classList.contains("is-failed"));
  assert.ok(find(out.body, "cmp-meter")[0].classList.contains("is-err"), "over the trigger, the meter is red like the chip");
});

test("the dock follows ui-context's discipline: a background turn marks the view stale and the next draw asks once; refusals show and are not retried by drawing", async () => {
  const f = fakeExt();
  install(f.ext);
  await opened(f, "s_1", view());
  f.close();
  f.event("s_1", { type: "turn.end" });
  assert.equal(f.log.requests.length, 2, "the open conversation's turn end refreshes, dock or no dock: the chip is showing");
  f.event("s_1", { type: "turn.end" });
  f.event("s_1", { type: "turn.end" });
  assert.equal(f.log.requests.length, 2, "one request in flight at a time");
  f.answer(view({ used: 150_000 }));
  await tick();
  assert.equal(f.log.requests.length, 3, "a single follow-up after the request in flight");
  f.answer(view({ used: 160_000 }));
  await tick();
  f.event("s_2", { type: "turn.end" });
  assert.equal(f.log.requests.length, 3, "a background conversation's turn asks nothing");
  f.go("s_2");
  assert.equal(f.log.requests.length, 4, "opening it asks");
  f.refuse("dev may not send compaction-state.");
  await tick();
  const out = f.draw();
  assert.equal(text(find(out.body, "cmp-note")[0]), "dev may not send compaction-state.");
  assert.ok(find(out.body, "cmp-note")[0].classList.contains("is-error"));
  assert.equal(f.chip().getAttribute("hidden"), "", "a refusal is no figure");
  f.draw();
  assert.equal(f.log.requests.length, 4, "a refusal is an answer; redrawing does not ask again");
  const none = fakeExt(null);
  install(none.ext);
  assert.match(text(none.draw().body), /Open a conversation/);
  assert.equal(none.log.requests.length, 0);
});

// The `context` command over a fake kernel, the browser module over a fake seam (when it asks, and when it
// must not), and the manifest's agreement with the files it names: the
// browser module defines `install` and nothing else at import time, the dock id it registers is the one
// declared, and the command's export exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as main from "../index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LAST_CALL = { model: "echo/echo-1", system: "# Hello\n\nBe brief.", systemChars: 19, tools: ["exec", "read_path"], messages: 3, at: "2026-09-15T10:00:00.000Z" };

function fakeEnv(records, session) {
  const seen = [];
  const kernel = {
    sessions: {
      async inspect(id) {
        seen.push(id);
        if (!records[id]) throw new Error(`no session ${id}`);
        return records[id];
      },
    },
  };
  return { env: { kernel, user: "alice", role: "user", session }, seen };
}

test("context answers the turn count and the harness record of the named session", async () => {
  const { env, seen } = fakeEnv({ "s-1": { id: "s-1", turns: 4, harness: { "@thetis/harness-core": { notes: "n", lastCall: LAST_CALL } } } }, "s-1");
  const out = await main.uiContext({}, env);
  assert.deepEqual(out, { data: { turns: 4, lastCall: LAST_CALL } });
  assert.deepEqual(seen, ["s-1"]);
});

test("context answers lastCall null when the harness has not recorded a call", async () => {
  const cases = [{}, { "@thetis/harness-core": {} }, { "@thetis/harness-core": { lastCall: "no" } }, { "@thetis/harness-core": [] }];
  for (const harness of cases) {
    const { env } = fakeEnv({ "s-1": { id: "s-1", turns: 0, harness } }, "s-1");
    assert.deepEqual(await main.uiContext({}, env), { data: { turns: 0, lastCall: null } });
  }
});

test("context refuses without an open conversation, before touching the kernel", async () => {
  const { env, seen } = fakeEnv({}, undefined);
  await assert.rejects(main.uiContext({}, env), { message: "no conversation is open" });
  assert.deepEqual(seen, []);
});

test("the manifest names files that exist, and the command's export is a function", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const ui = manifest.thetis.ui;
  assert.equal(manifest.thetis.type, "ui");
  assert.equal(manifest.main, "index.js");
  for (const file of [ui.entry, ui.style]) await readFile(resolve(root, ui.dir, file));
  for (const command of ui.commands) assert.equal(typeof main[command.export], "function", `${command.verb} -> ${command.export}`);
  assert.deepEqual(ui.dock.map((d) => d.id), ["context"]);
  assert.equal(ui.dock[0].wide, true);
});

test("the browser module parses, and defines install without doing anything at import time", async () => {
  const entry = resolve(root, "ui", "index.js");
  execFileSync(process.execPath, ["--check", entry], { stdio: "pipe" });
  // Node has no DOM; importing must still succeed because the module only defines functions.
  const mod = await import(entry);
  assert.deepEqual(Object.keys(mod), ["default"]);
  assert.equal(typeof mod.default, "function");
  assert.equal(mod.default.name, "install");
  const source = await readFile(entry, "utf8");
  assert.match(source, /ext\.dock\("context"/, "registers the declared dock id");
  assert.match(source, /ext\s*\.request\("context"/, "sends the declared verb");
  assert.doesNotMatch(source, /innerHTML|\.style\b|style=/, "builds DOM through ext.dom, with no inline styles");
});

// ---- the browser module over a fake ext ----

function node(tag, props = {}) {
  const n = { tag, props, children: [], isConnected: false };
  n.append = (...items) => n.children.push(...items.flat().filter((c) => c != null && c !== false));
  n.querySelector = () => null;
  return n;
}
const el = (tag, props = {}, ...children) => {
  const n = node(tag, props);
  n.append(...children);
  return n;
};
const text = (n) => (typeof n === "string" ? n : n.children.map(text).join(""));
const find = (n, cls, out = []) => {
  if (typeof n === "string") return out;
  if (String(n.props.class ?? "").split(" ").includes(cls)) out.push(n);
  for (const c of n.children) find(c, cls, out);
  return out;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * An ext whose `request` answers only when the test says so, in order, so timing is under the test's control.
 * `draw` stands for the dock showing the entry: as the real dock does, it drops the body of the previous draw
 * and holds the new one, so the module sees an open dock through the body's `isConnected`. `close` drops it.
 */
function fakeExt(current = "s_1") {
  const log = { docks: {}, requests: [], redraws: 0, watchers: [], turnWatchers: [], pending: [] };
  const ext = {
    package: "@thetis/ui-context",
    dock: (id, impl) => (log.docks[id] = impl),
    request: (verb, opts) => {
      log.requests.push({ verb, ...opts });
      return new Promise((resolve, reject) => log.pending.push({ resolve, reject }));
    },
    redraw: () => log.redraws++,
    conversation: { get current() { return current; }, watch: (fn) => log.watchers.push(fn) },
    events: { watch: (fn) => log.turnWatchers.push(fn) },
    dom: { el, clear: (n) => n },
    ui: {
      kv: (pairs) => el("dl", { class: "kv" }, ...pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
      section: (label, note) => el("div", { class: "section-head" }, label, note),
      tags: (items, tone) => el("div", { class: "tags" }, ...items.map((t) => el("span", { class: `badge is-${tone}` }, t))),
      button: (label, { title } = {}) => Object.assign(el("button", { class: "btn", title }, label), { addEventListener() {} }),
    },
    markdown: (md) => el("div", { class: "md" }, md),
  };
  const answer = (data) => log.pending.shift().resolve({ data });
  const refuse = (message) => log.pending.shift().reject(new Error(message));
  const go = (id) => {
    current = id;
    for (const fn of log.watchers) fn(id);
  };
  const end = (session) => {
    for (const fn of log.turnWatchers) fn({ session, event: { type: "turn.end" } });
  };
  let shown = null;
  const close = () => {
    if (shown) shown.isConnected = false;
    shown = null;
  };
  const draw = () => {
    close();
    const view = log.docks.context.draw();
    shown = view.body;
    shown.isConnected = true;
    return view;
  };
  return { ext, log, answer, refuse, go, end, draw, close };
}

const install = (await import("../ui/index.js")).default;

test("install registers the context dock and asks nothing; the first draw asks once for the open conversation, later draws never", async () => {
  const { ext, log, answer, draw } = fakeExt();
  install(ext);
  assert.deepEqual(Object.keys(log.docks), ["context"]);
  assert.deepEqual(log.requests, [], "the dock is closed when the page opens, so nothing is asked");
  let view = draw();
  assert.deepEqual(log.requests, [{ verb: "context", session: "s_1" }], "opening the dock asks");
  assert.equal(view.title, "Context");
  assert.match(text(view.body), /Loading/);
  draw();
  assert.equal(log.requests.length, 1, "a draw during the request does not ask again");
  answer({ turns: 0, lastCall: null });
  await tick();
  view = draw();
  draw();
  assert.equal(view.subtitle, "turn 0");
  assert.match(text(view.body), /Nothing has been sent in this conversation yet\./);
  assert.deepEqual(view.actions, []);
  assert.equal(log.requests.length, 1, "drawing what was received sends nothing");
});

test("a call draws the Request tab with the scalars and the tool pills, and the Prompt tab with the markdown and Copy", async () => {
  const { ext, log, answer, draw } = fakeExt();
  install(ext);
  draw();
  answer({ turns: 3, lastCall: LAST_CALL });
  await tick();
  let view = draw();
  assert.equal(view.subtitle, "turn 3 · echo/echo-1 · 19 chars");
  assert.equal(find(view.body, "badge").map(text).join(","), "exec,read_path");
  assert.match(text(view.body), /Tools offered2/);
  assert.match(text(view.body), /Messages in the exchange3/);
  assert.equal(find(view.body, "ui-context-prompt").length, 0);
  const tabs = find(view.body, "ui-context-tab");
  assert.deepEqual(tabs.map((t) => t.props["aria-selected"]), ["true", "false"]);
  tabs[1].props.onClick();
  assert.equal(log.redraws, 2, "the tab switch redraws through ext.redraw");
  view = draw();
  assert.deepEqual(find(view.body, "ui-context-tab").map((t) => t.props["aria-selected"]), ["false", "true"]);
  assert.equal(text(find(view.body, "ui-context-prompt")[0]), LAST_CALL.system);
  assert.equal(view.actions.length, 1);
  assert.equal(text(view.actions[0]), "Copy");
  assert.equal(log.requests.length, 1);
});

test("with the dock open, a turn's end in the open conversation asks again; one in another does not; triggers during a request coalesce", async () => {
  const { ext, log, answer, end, draw } = fakeExt();
  install(ext);
  draw();
  answer({ turns: 1, lastCall: null });
  await tick();
  end("s_other");
  assert.equal(log.requests.length, 1);
  end("s_1");
  assert.equal(log.requests.length, 2);
  end("s_1");
  end("s_1");
  assert.equal(log.requests.length, 2, "one request in flight at a time");
  answer({ turns: 2, lastCall: LAST_CALL });
  await tick();
  assert.equal(log.requests.length, 3, "a single follow-up after the request in flight");
  answer({ turns: 3, lastCall: LAST_CALL });
  await tick();
  assert.equal(log.requests.length, 3);
  assert.equal(draw().subtitle, "turn 3 · echo/echo-1 · 19 chars");
});

test("with the dock open, a conversation change asks for the new one, and an answer for the old one is dropped", async () => {
  const { ext, log, answer, go, draw } = fakeExt();
  install(ext);
  draw();
  go("s_2");
  assert.equal(log.requests.length, 1, "the change waits for the request in flight");
  assert.match(text(draw().body), /Loading/);
  answer({ turns: 9, lastCall: LAST_CALL });
  await tick();
  assert.deepEqual(log.requests.map((r) => r.session), ["s_1", "s_2"]);
  assert.match(text(draw().body), /Loading/, "s_1's answer is not shown for s_2");
  answer({ turns: 1, lastCall: null });
  await tick();
  const view = draw();
  assert.equal(view.subtitle, "turn 1");
  assert.match(text(view.body), /Nothing has been sent/);
});

test("with the dock closed, conversation changes ask nothing; opening it asks once, for the conversation open then", async () => {
  const { ext, log, answer, go, draw, close } = fakeExt();
  install(ext);
  draw();
  answer({ turns: 1, lastCall: LAST_CALL });
  await tick();
  close();
  go("s_2");
  go("s_3");
  go("s_4");
  assert.equal(log.requests.length, 1, "nobody is looking, so the server is not asked to read three records");
  const view = draw();
  assert.deepEqual(log.requests.map((r) => r.session), ["s_1", "s_4"], "opening asks once, for the open conversation");
  assert.match(text(view.body), /Loading/, "s_1's record is not shown for s_4");
  answer({ turns: 2, lastCall: null });
  await tick();
  assert.equal(draw().subtitle, "turn 2");
  assert.equal(log.requests.length, 2);
});

test("with the dock closed, a turn's end marks the record stale: nothing is asked until the dock opens, and then once", async () => {
  const { ext, log, answer, end, draw, close } = fakeExt();
  install(ext);
  draw();
  answer({ turns: 1, lastCall: LAST_CALL });
  await tick();
  close();
  end("s_1");
  end("s_1");
  assert.equal(log.requests.length, 1);
  const view = draw();
  assert.equal(log.requests.length, 2, "the dock opens on a stale record and asks once");
  assert.equal(view.subtitle, "turn 1 · echo/echo-1 · 19 chars", "what was shown stays up while the answer comes: it is the same conversation");
  draw();
  assert.equal(log.requests.length, 2);
  answer({ turns: 2, lastCall: LAST_CALL });
  await tick();
  assert.equal(draw().subtitle, "turn 2 · echo/echo-1 · 19 chars");
  assert.equal(log.requests.length, 2);
});

test("a refused request shows its sentence in the body and is not asked again by drawing; no conversation shows a hint", async () => {
  const { ext, log, refuse, draw } = fakeExt();
  install(ext);
  draw();
  refuse("dev may not send context.");
  await tick();
  const view = draw();
  assert.equal(text(find(view.body, "ui-context-note")[0]), "dev may not send context.");
  assert.equal(find(view.body, "ui-context-note")[0].props.class, "ui-context-note is-error");
  assert.equal(log.requests.length, 1, "a refusal is an answer; redrawing does not ask again");

  const none = fakeExt(null);
  install(none.ext);
  assert.equal(none.log.requests.length, 0);
  assert.match(text(none.draw().body), /Open a conversation/);
  assert.equal(none.draw().subtitle, "");
  assert.equal(none.log.requests.length, 0, "no conversation, nothing to ask for");
});

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
/** What `context` sends of LAST_CALL: everything but the big texts, which come a page at a time. */
const { system: _system, ...SUMMARY } = LAST_CALL;
const EMPTY_USAGE = { usageCount: 0, usageTotals: {} };

function fakeEnv(records, session, files = {}) {
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
  return { env: { kernel, user: "alice", role: "user", session, readFile: async (path) => {
    if (!(path in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return JSON.stringify(files[path]);
  } }, seen };
}

test("context answers the turn count and the harness record of the named session", async () => {
  const { env, seen } = fakeEnv({ "s-1": { id: "s-1", turns: 4, harness: { "@thetis/harness-core": { notes: "n", lastCall: LAST_CALL } } } }, "s-1");
  const out = await main.uiContext({}, env);
  assert.deepEqual(out, { data: { turns: 4, status: "idle", started: true, lastCall: SUMMARY, usage: [], ...EMPTY_USAGE } });
  assert.deepEqual(seen, ["s-1"]);
});

test("context answers lastCall null when the harness has not recorded a call", async () => {
  const cases = [{}, { "@thetis/harness-core": {} }, { "@thetis/harness-core": { lastCall: "no" } }, { "@thetis/harness-core": [] }];
  for (const harness of cases) {
    const { env } = fakeEnv({ "s-1": { id: "s-1", turns: 0, harness } }, "s-1");
    assert.deepEqual(await main.uiContext({}, env), { data: { turns: 0, status: "idle", started: false, lastCall: null, usage: [], ...EMPTY_USAGE } });
  }
});

test("context refuses without an open conversation, before touching the kernel", async () => {
  const { env, seen } = fakeEnv({}, undefined);
  await assert.rejects(main.uiContext({}, env), { message: "no conversation is open" });
  assert.deepEqual(seen, []);
});

test("context reads the current first request while the session's saved harness is still empty", async () => {
  const current = { ...LAST_CALL, turn: "t_1", format: "wire", request: { model: "echo", messages: [{ role: "user", content: "working" }] } };
  const entry = { id: "t_1", firstMessage: 0, status: "running", calls: 1, usage: { prompt_tokens: 100, cost: 0.02 } };
  const { env } = fakeEnv({ s_1: { turns: 0, status: "running", turn: { id: "t_1" }, conversation: [{ role: "user", content: "working" }], harness: {} } }, "s_1", {
    "harness-core/context/s_1.json": { lastCall: current, usage: [entry] },
  });
  const { system: _s, request: _r, ...scalars } = current;
  assert.deepEqual((await main.uiContext({}, env)).data, {
    turns: 0, status: "running", started: true,
    lastCall: { ...scalars, request: { params: { model: "echo" }, messages: [{ index: 0, role: "user", gist: "working", bytes: 35, cache: false }], messageCount: 1, tools: [], bytes: 65 } },
    usage: [entry], usageCount: 1, usageTotals: { prompt_tokens: 100, cost: 0.02 },
  });
});

test("historical gateway usage fills older turns without double-counting captured turns", async () => {
  const usage = { id: "t_2", firstMessage: 4, status: "running", calls: 1, usage: { cost: 0.1 } };
  const conversation = ["user", "assistant", "tool", "assistant", "user", "assistant"].map((role) => ({ role, content: "x" }));
  const { env } = fakeEnv({ s_1: { turns: 2, status: "idle", conversation, harness: {} } }, "s_1", {
    "harness-core/context/s_1.json": { usage: [usage] },
    "gateway-web/sessions/alice/s_1.json": { usage: { 1: { cost: 0.02, prompt_tokens: 100 }, 3: { cost: 0.03, prompt_tokens: 110 }, 5: { cost: 0.1 } } },
  });
  const out = (await main.uiContext({}, env)).data;
  assert.deepEqual(out.usage, [
    { id: "history-0", firstMessage: 0, status: "complete", calls: 2, usage: { cost: 0.05, prompt_tokens: 210 } },
    { ...usage, status: "interrupted" },
  ]);
});

test("a request of megabytes is summarised under the answer limit, and its pages put it back together exactly", async () => {
  const messages = Array.from({ length: 3000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} ${"é\"\n".repeat(700)}` }));
  const request = { model: "echo", temperature: 0.1, messages, tools: [{ type: "function", function: { name: "exec", parameters: {} } }] };
  const call = { ...LAST_CALL, system: "S".repeat(300_000), systemChars: 300_000, format: "wire", request };
  const usage = Array.from({ length: 900 }, (_, i) => ({ id: `t${i}`, firstMessage: 0, status: "complete", calls: 1, usage: { cost: 0.01, prompt_tokens: 10 } }));
  const { env } = fakeEnv({ s_1: { turns: 900, status: "idle", conversation: [], harness: {} } }, "s_1", { "harness-core/context/s_1.json": { lastCall: call, usage } });
  const out = await main.uiContext({}, env);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) < main.ANSWER_BYTES + 1024, "the summary fits the gateway's limit");
  const summary = out.data.lastCall.request;
  assert.equal(summary.messageCount, 3000);
  assert.ok(summary.messages.length < 3000 && summary.messages.at(-1).index === 2999, "the newest rows are kept, numbered as in the request");
  assert.equal(out.data.usageCount, 900);
  assert.ok(out.data.usage.length <= main.USAGE_ROWS);
  assert.equal(Math.round(out.data.usageTotals.cost * 100) / 100, 9, "the totals count every row, listed or not");

  async function whole(part, index) {
    let text = "";
    let offset = 0;
    for (;;) {
      const page = (await main.uiContextPage({ part, index, offset, at: call.at }, env)).data;
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < main.ANSWER_BYTES + 1024, `a ${part} page fits the limit`);
      text += page.text;
      if (page.next === null) return text;
      offset = page.next;
    }
  }
  assert.equal(await whole("system"), call.system);
  assert.deepEqual(JSON.parse(await whole("request")), request);
  assert.deepEqual(JSON.parse(await whole("message", 2999)), messages[2999]);
  assert.deepEqual(JSON.parse(await whole("tool", 0)), request.tools[0]);
  assert.deepEqual((await main.uiContextPage({ part: "system", at: "2020-01-01T00:00:00Z" }, env)).data, { at: call.at, changed: true }, "a replaced capture is said, not stitched");
  await assert.rejects(main.uiContextPage({ part: "message", index: 3000 }, env), /There is no message 3000/);
  await assert.rejects(main.uiContextPage({ part: "secrets" }, env), /There is no part called "secrets"/);
});

test("context-page refuses without a capture and without a conversation", async () => {
  const { env } = fakeEnv({ s_1: { turns: 0, harness: {} } }, "s_1");
  await assert.rejects(main.uiContextPage({ part: "system" }, env), /No request has been captured/);
  const none = fakeEnv({}, undefined);
  await assert.rejects(main.uiContextPage({ part: "system" }, none.env), { message: "no conversation is open" });
});

test("a failed or older conversation without a capture is still reported as started", async () => {
  const { env } = fakeEnv({ s_1: { turns: 1, conversation: [{ role: "user", content: "hello" }], harness: {} } }, "s_1");
  const out = (await main.uiContext({}, env)).data;
  assert.equal(out.started, true);
  assert.equal(out.lastCall, null);
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
  const event = (session, type) => {
    for (const fn of log.turnWatchers) fn({ session, event: { type } });
  };
  const end = (session) => event(session, "turn.end");
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
  return { ext, log, answer, refuse, go, end, event, draw, close };
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
  assert.deepEqual(view.actions.map(text), ["Refresh"]);
  assert.equal(log.requests.length, 1, "drawing what was received sends nothing");
});

test("without developer details there is no Request tab: the dock opens on Usage, and Prompt is there", async () => {
  const { ext, answer, draw } = fakeExt();
  install(ext);
  draw();
  answer({ turns: 3, lastCall: SUMMARY });
  await tick();
  const view = draw();
  assert.deepEqual(find(view.body, "ui-context-tab").map(text), ["Prompt", "Usage"]);
  assert.deepEqual(find(view.body, "ui-context-tab").map((t) => t.props["aria-selected"]), ["false", "true"]);
  assert.match(text(view.body), /Session cost/);
  assert.equal(find(view.body, "ui-context-raw").length, 0);
});

test("a call draws the Request tab with the scalars and the tool pills, and the Prompt tab with the markdown and Copy", async () => {
  const { ext, log, answer, draw } = fakeExt();
  ext.developer = () => true;
  install(ext);
  draw();
  answer({ turns: 3, lastCall: SUMMARY });
  await tick();
  let view = draw();
  assert.equal(view.subtitle, "turn 3 · echo/echo-1 · 19 chars");
  assert.equal(find(view.body, "badge").map(text).join(","), "exec,read_path");
  assert.match(text(view.body), /Tools offered2/);
  assert.match(text(view.body), /Messages in the exchange3/);
  assert.equal(find(view.body, "ui-context-prompt").length, 0);
  const tabs = find(view.body, "ui-context-tab");
  assert.deepEqual(tabs.map((t) => t.props["aria-selected"]), ["true", "false", "false"]);
  tabs[1].props.onClick();
  assert.equal(log.redraws, 2, "the tab switch redraws through ext.redraw");
  view = draw();
  assert.deepEqual(find(view.body, "ui-context-tab").map((t) => t.props["aria-selected"]), ["false", "true", "false"]);
  assert.match(text(view.body), /Loading the prompt/);
  assert.equal(log.requests.length, 2, "the prompt is asked for when the Prompt tab needs it");
  assert.deepEqual(log.requests[1], { verb: "context-page", session: "s_1", args: { part: "system", offset: 0, at: LAST_CALL.at } });
  answer({ at: LAST_CALL.at, text: "# Hello\n\n", offset: 0, next: 9, total: 19 });
  await tick();
  assert.deepEqual(log.requests[2].args, { part: "system", offset: 9, at: LAST_CALL.at }, "the next page follows");
  answer({ at: LAST_CALL.at, text: "Be brief.", offset: 9, next: null, total: 19 });
  await tick();
  view = draw();
  assert.equal(text(find(view.body, "ui-context-prompt")[0]), LAST_CALL.system);
  assert.equal(view.actions.length, 2);
  assert.equal(text(view.actions[0]), "Copy");
  draw();
  assert.equal(log.requests.length, 3, "a prompt held is not asked for again");
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
  assert.match(text(view.body), /No usage has been recorded in this conversation yet\./, "the Usage tab, for everyone: s_1's answer is not shown");
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

test("an open dock refreshes on request capture during the first turn, without waiting for turn.end", async () => {
  const f = fakeExt();
  install(f.ext);
  f.draw();
  f.answer({ turns: 0, status: "running", lastCall: null });
  await tick();
  let view = f.draw();
  assert.match(text(view.body), /The turn is running/);
  assert.doesNotMatch(text(view.body), /Nothing has been sent/);
  f.event("s_other", "context.updated");
  assert.equal(f.log.requests.length, 1);
  f.event("s_1", "context.updated");
  assert.equal(f.log.requests.length, 2);
  f.answer({ turns: 0, status: "running", lastCall: SUMMARY });
  await tick();
  f.ext.developer = () => true;
  view = f.draw();
  assert.match(view.subtitle, /^turn 1 · running/);
  assert.match(text(view.body), /echo\/echo-1/);
});

test("full request messages, tool schemas, cache breakpoints and usage are inspectable", async () => {
  const f = fakeExt();
  install(f.ext);
  f.draw();
  const request = {
    model: "echo/echo-1", stream: true, stream_options: { include_usage: true }, temperature: 0.25,
    messages: [{ role: "system", content: [{ type: "text", text: "Instructions", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: '{"cmd":"ls"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "<script>do not execute</script>" }],
    tools: [{ type: "function", function: { name: "exec", description: "Execute a command", parameters: { type: "object", required: ["cmd"] } } }],
  };
  const call = { ...LAST_CALL, format: "wire", request, usage: { prompt_tokens: 100, completion_tokens: 12, cache_read_tokens: 80 } };
  const usage = [{ id: "t1", firstMessage: 0, calls: 2, status: "running", usage: { cost: 0.032, prompt_tokens: 300, completion_tokens: 40, cache_read_tokens: 80 } }];
  const server = fakeEnv({ s_1: { turns: 0, status: "running", turn: { id: "t1" }, conversation: [{ role: "user", content: "x" }], harness: {} } }, "s_1", { "harness-core/context/s_1.json": { lastCall: call, usage } });
  f.ext.developer = () => true;
  f.answer((await main.uiContext({}, server.env)).data);
  await tick();
  let view = f.draw();
  const content = text(view.body);
  for (const value of ["exact request body", "temperature", "0.25", "cache_control", "for c1", "exec", "Full request JSON"]) assert.ok(content.includes(value), value);
  assert.deepEqual(view.actions.map(text), ["Copy JSON", "Refresh"]);
  // Opening one message asks for that message alone; its JSON arrives and is drawn in the open fold.
  const fold = find(view.body, "ui-context-detail").find((d) => text(d).includes("for c1"));
  const asked = f.log.requests.length;
  fold.props.onToggle({ currentTarget: { open: true } });
  assert.deepEqual(f.log.requests.at(-1), { verb: "context-page", session: "s_1", args: { part: "message", index: 2, offset: 0, at: call.at } });
  f.answer((await main.uiContextPage(f.log.requests.at(-1).args, server.env)).data);
  await tick();
  view = f.draw();
  assert.ok(text(view.body).includes('"tool_call_id": "c1"'), "the message's JSON is shown once it has arrived");
  assert.equal(f.log.requests.length, asked + 1);
  find(view.body, "ui-context-tab")[2].props.onClick();
  view = f.draw();
  assert.match(text(view.body), /Session cost\$0.0320/);
  assert.match(text(view.body), /Prompt tokens300/);
  assert.match(text(view.body), /80% cached/);
  assert.match(text(view.body), /running.*2 calls/);
});

test("closing a dock during a queued refresh defers the follow-up until it is opened", async () => {
  const f = fakeExt();
  install(f.ext);
  f.draw();
  f.event("s_1", "context.updated");
  f.close();
  f.answer({ turns: 0, status: "running", lastCall: LAST_CALL });
  await tick();
  assert.equal(f.log.requests.length, 1);
  f.draw();
  assert.equal(f.log.requests.length, 2);
});

test("synchronous dock redraws do not duplicate a queued refresh", async () => {
  const f = fakeExt();
  f.ext.redraw = () => f.draw();
  install(f.ext);
  f.draw();
  f.event("s_1", "context.updated");
  f.answer({ turns: 0, status: "running", lastCall: LAST_CALL });
  await tick();
  assert.equal(f.log.requests.length, 2);
  f.answer({ turns: 0, status: "running", lastCall: LAST_CALL });
  await tick();
  assert.equal(f.log.requests.length, 2);
});

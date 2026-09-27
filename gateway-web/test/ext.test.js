import { test } from "node:test";
import assert from "node:assert/strict";
import "./dom-fixture.js";
import { createExt, notifySessionCreated } from "../assets/lib/ext.js";
import { store } from "../assets/lib/store.js";

test("local creation hooks are awaited and global session lists never invoke them", async () => {
  const ext = createExt({ package: "@review/projects" });
  const called = [];
  let complete;
  const stop = ext.sessions.onCreate(async (id) => {
    called.push(id);
    await new Promise((resolve) => { complete = resolve; });
  });
  try {
    store.set({ sessions: [{ id: "s_elsewhere" }] });
    assert.deepEqual(called, []);
    let ready = false;
    const created = notifySessionCreated("s_here").then(() => { ready = true; });
    await Promise.resolve();
    assert.deepEqual(called, ["s_here"]);
    assert.equal(ready, false);
    complete();
    await created;
    assert.equal(ready, true);
  } finally { stop(); }
  await notifySessionCreated("s_later");
  assert.deepEqual(called, ["s_here"]);
});

test("a creation setup failure rejects before the conversation can be used", async () => {
  const ext = createExt({ package: "@review/projects" });
  const stop = ext.sessions.onCreate(async () => { throw new Error("assignment failed"); });
  try {
    await assert.rejects(notifySessionCreated("s_a"), /assignment failed/);
  } finally { stop(); }
});

test("ext.open.place reaches another package's place by its id, its own first, or a full key", async () => {
  const registry = await import("../assets/lib/registry.js");
  const { bindShell, entryKey } = await import("../assets/lib/ext.js");
  registry.declare({ package: "@thetis/ui-marketplace", places: [{ id: "marketplace", label: "Extensions" }] });
  registry.declare({ package: "@review/own", places: [{ id: "notes", label: "Notes" }] });
  assert.equal(entryKey("places", "@thetis/compaction", "marketplace"), "@thetis/ui-marketplace#marketplace", "compaction's link to the marketplace");
  assert.equal(entryKey("places", "@review/own", "notes"), "@review/own#notes");
  assert.equal(entryKey("places", "@review/own", "@thetis/ui-marketplace#marketplace"), "@thetis/ui-marketplace#marketplace");
  assert.equal(entryKey("places", "@review/own", "nowhere"), "@review/own#nowhere", "nothing by that id: the package's own key, which opens nothing");
  const opened = [];
  bindShell({ openPlace: (key, params) => opened.push([key, params]) });
  createExt({ package: "@thetis/compaction" }).open.place("marketplace", { name: "@thetis/compaction" });
  assert.deepEqual(opened, [["@thetis/ui-marketplace#marketplace", { name: "@thetis/compaction" }]]);
});

test("ext.tab registers only a declared kind; open.tab and close.tab reach the shell with the kind resolved, from any package", async () => {
  const registry = await import("../assets/lib/registry.js");
  const { bindShell } = await import("../assets/lib/ext.js");
  registry.declare({ package: "@t/canvases", tabs: [{ id: "canvas", label: "Canvas" }] });
  const ext = createExt({ package: "@t/canvases" });
  assert.equal(ext.tab("canvas", { open() {} }), true);
  assert.equal(ext.tab("other", { open() {} }), false, "an undeclared kind is refused");
  const opened = [];
  const closed = [];
  bindShell({ openTab: (...a) => { opened.push(a); return true; }, closeTab: (...a) => closed.push(a) });
  ext.open.tab("canvas", "c1", { id: "c1" });
  createExt({ package: "@t/elsewhere" }).open.tab("canvas", "c2");
  ext.close.tab("canvas", "c1");
  assert.deepEqual(opened, [["@t/canvases#canvas", "c1", { id: "c1" }], ["@t/canvases#canvas", "c2", undefined]], "another package reaches the kind by its id");
  assert.deepEqual(closed, [["@t/canvases#canvas", "c1"]]);
});

test("ext.frame is only there for a package with a frame verb; mount builds a sandboxed iframe and takes only its own frame's messages", async (t) => {
  assert.equal(createExt({ package: "@t/plain" }).frame, undefined);
  const ext = createExt({ package: "@t/canvases", frames: ["frame"] });
  assert.equal(ext.can("frame"), true);
  const token = "a".repeat(64);
  const previous = globalThis.fetch;
  const minted = [];
  globalThis.fetch = async (url, init) => {
    minted.push([String(url), init?.method, init?.body]);
    return new Response(JSON.stringify({ token, base: `f/${token}/` }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const listeners = new Set();
  window.addEventListener = (_name, fn) => listeners.add(fn);
  window.removeEventListener = (_name, fn) => listeners.delete(fn);
  t.after(() => { globalThis.fetch = previous; });

  assert.equal(await ext.frame.url("frame", { canvas: "c1" }), `f/${token}/`);
  assert.equal(minted.length, 1);
  assert.match(minted[0][0], /api\/ext\/@t\/canvases\/frame\/frame$/);
  assert.equal(minted[0][1], "POST");
  assert.deepEqual(JSON.parse(minted[0][2]), { args: { canvas: "c1" } });
  await assert.rejects(ext.frame.url("nope"), /declares no frame "nope"/);

  const got = [];
  const readiness = [];
  const frame = await ext.frame.mount("frame", { canvas: "c1" }, { path: "Main.html", title: "Main", onMessage: (d) => got.push(d), onReady: (ok) => readiness.push(ok) });
  assert.equal(frame.node.tag, "iframe");
  assert.equal(frame.node.getAttribute("sandbox"), "allow-scripts", "scripts, and nothing else: no same-origin, no forms, no popups");
  assert.equal(frame.node.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(frame.node.getAttribute("title"), "Main");
  assert.equal(frame.node.getAttribute("src"), `f/${token}/Main.html?v=1#${frame.nonce}`, "the nonce rides in the fragment, which never reaches the server");
  const inside = {};
  frame.node.contentWindow = inside;
  const send = (source, data) => { for (const fn of [...listeners]) fn({ source, data }); };
  send({}, { type: "ready", nonce: frame.nonce });
  send(inside, { type: "ready", nonce: "other" });
  send(inside, "ready");
  assert.deepEqual(got, [], "another window, another nonce, or no nonce at all: not this frame's");
  assert.deepEqual(readiness, []);
  send(inside, { type: "ready", nonce: frame.nonce });
  send(inside, { type: "size", nonce: frame.nonce, width: 10, height: 20 });
  assert.deepEqual(got, [{ type: "ready" }, { type: "size", width: 10, height: 20 }], "the nonce is stripped on the way in");
  assert.deepEqual(readiness, [true]);
  const posted = [];
  inside.postMessage = (data, origin) => posted.push([data, origin]);
  frame.post({ type: "props", values: { accent: "#123" } });
  assert.deepEqual(posted, [[{ type: "props", values: { accent: "#123" }, nonce: frame.nonce }, "*"]], "the nonce rides out with every message; the target is any origin, since the frame's is opaque");
  frame.reload();
  assert.equal(frame.node.getAttribute("src"), `f/${token}/Main.html?v=2#${frame.nonce}`, "a reload changes the version, so the same name is fetched again");
  frame.destroy();
  assert.equal(listeners.size, 0, "destroyed: nothing listens any more");
});

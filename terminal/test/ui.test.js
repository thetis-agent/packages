// The browser module over a fake seam, and the two small ui commands over a real host. The drawer rules
// are the point: it starts closed over the shells that were already there, it opens when a shell starts
// in the conversation on screen, and it closes when the conversation changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import install from "../ui/index.js";
import { uiSessionsCount, uiSeen } from "../index.js";
import { startHost } from "../lib/host.js";

globalThis.addEventListener ??= () => {};

function fakeExt({ conversation = "s_1", developer } = {}) {
  const calls = { open: 0, close: 0 };
  let open = false;
  let chip = null;
  let stream = null;
  const conversationWatchers = [];
  const el = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat().filter(Boolean) });
  const ext = {
    conversation: {
      current: conversation,
      watch: (fn) => conversationWatchers.push(fn),
    },
    shelf: Object.assign(() => {}, { isOpen: () => open }),
    chip: (_id, spec) => {
      chip = spec;
    },
    open: { shelf: () => ((open = true), calls.open++) },
    close: { shelf: () => ((open = false), calls.close++) },
    subscribe: (_verb, handlers) => {
      stream = handlers;
      return () => {};
    },
    request: async () => ({ data: {} }),
    toast: () => {},
    redraw: () => {},
    sessions: { list: () => [] },
    dom: {
      el,
      clear: (node) => ({ append: (...children) => (node.children = children) }),
      setHidden: () => {},
    },
    ...(developer === undefined ? {} : { developer: () => developer, onDeveloper: () => {} }),
  };
  return {
    ext,
    calls,
    push: (value) => stream.onEvent(value),
    switchTo: (id) => {
      ext.conversation.current = id;
      for (const fn of conversationWatchers) fn(id);
    },
    chipText: () => {
      const button = { classList: { add() {}, toggle() {} }, children: [] };
      chip.draw(button, { session: ext.conversation.current });
      return button.children[1].children[0];
    },
  };
}

const row = (id, conversation, state = "idle") => ({ id, name: id, conversation, state, cwd: "/home/x" });

test("the drawer starts closed over the shells that were already there when the page loaded", () => {
  const page = fakeExt();
  install(page.ext);
  page.push({ ev: "sessions", sessions: [row("a", "s_1"), row("b", "s_1", "busy"), row("c", "s_2")] });
  assert.equal(page.calls.open, 0);
});

test("a shell that starts in the conversation on screen opens the drawer; another conversation's does not", () => {
  const page = fakeExt();
  install(page.ext);
  page.push({ ev: "sessions", sessions: [] });
  page.push({ ev: "state", session: row("x", "s_2") });
  assert.equal(page.calls.open, 0);
  page.push({ ev: "state", session: row("y", "s_1") });
  assert.equal(page.calls.open, 1);
});

test("switching conversations closes the drawer and leaves it closed", () => {
  const page = fakeExt();
  install(page.ext);
  page.push({ ev: "sessions", sessions: [] });
  page.push({ ev: "state", session: row("y", "s_1") });
  assert.equal(page.calls.open, 1);
  page.push({ ev: "state", session: row("z", "s_2") });
  page.switchTo("s_2");
  assert.equal(page.calls.close, 1);
  assert.equal(page.calls.open, 1, "the other conversation's shells do not bring it back up");
});

test("the chip counts this conversation's open shells, not the closed rows", () => {
  const page = fakeExt();
  install(page.ext);
  page.push({ ev: "sessions", sessions: [row("a", "s_1"), row("b", "s_1", "closed"), row("c", "s_2")] });
  assert.equal(page.chipText(), "1 terminal");
  page.switchTo("s_3");
  assert.equal(page.chipText(), "Terminal");
});

test("sessions-count answers how many shells are open, and seen is accepted for an open one", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "thetis-ui-"));
  const host = await startHost({ root, cwd: root, config: {}, log: () => {} });
  t.after(async () => {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(await uiSessionsCount({}, { root }), { data: { open: 0 } });
  const { connect } = await import("../lib/client.js");
  const c = await connect(root);
  const opened = await c.request("open", { conversation: "s_1" });
  c.close();
  assert.deepEqual(await uiSessionsCount({}, { root }), { data: { open: 1 } });
  assert.deepEqual(await uiSeen({ id: opened.id }, { root }), { data: {} });
  await assert.rejects(() => uiSeen({}, { root }), /id is the session/);
});

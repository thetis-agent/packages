// The composer pill over a fake seam: on the draft it names the space and picking enters another; on a
// root conversation the menu is headed "Move to" and picking moves it; on a subagent it only says which.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dotClass, mountPill } from "../ui/pill.js";

function node(tag, props = {}) {
  const n = { tag, props, children: [], attrs: {}, className: props.class ?? "", textContent: "", disabled: false, title: "" };
  n.append = (...items) => n.children.push(...items.flat().filter((c) => c != null && c !== false));
  n.setAttribute = (k, v) => (n.attrs[k] = v);
  n.querySelector = (sel) => (sel === "svg" ? n.children.find((c) => c.tag === "svg") : null);
  n.classList = { add: (c) => (n.className = `${n.className} ${c}`.trim()) };
  n.remove = () => {};
  return n;
}
const el = (tag, props = {}, ...children) => {
  const n = node(tag, props);
  n.append(...children);
  return n;
};

const projects = [{ id: "p_11111111", name: "Torchship" }, { id: "p_22222222", name: "Nova" }];

function setup({ current = null, chosen = null, of = {}, roots = [] } = {}) {
  const menus = [];
  const watchers = new Set();
  const conversationWatchers = new Set();
  const moved = [];
  const entered = [];
  const ext = {
    dom: { el, icon: () => node("svg") },
    ui: { menu: (at, items, opts) => { menus.push({ items, opts }); return () => opts?.onClose?.(); } },
    conversation: { current, watch: (fn) => { conversationWatchers.add(fn); return () => conversationWatchers.delete(fn); } },
    sessions: { list: () => roots.map((id) => ({ id })), watch: () => () => {} },
    open: { place: () => {} },
    toast: () => {},
  };
  const state = {
    projects,
    known: true,
    chosen,
    project: (id) => projects.find((p) => p.id === id) ?? null,
    of: (id) => (id in of ? of[id] : undefined),
    enter: (id) => { entered.push(id); state.chosen = id; },
    assign: async (session, id) => { moved.push([session, id]); },
    refresh: async () => {},
    watch: (fn) => { watchers.add(fn); return () => watchers.delete(fn); },
  };
  const root = node("div");
  const stop = mountPill(ext, state, root);
  const button = root.children[0];
  const label = () => button.children[1].textContent;
  return { ext, state, button, label, menus, moved, entered, stop, watchers, conversationWatchers };
}

test("on the draft the pill names the space, and picking another enters it", () => {
  const t = setup({ chosen: "p_11111111" });
  assert.equal(t.button.className, "pj-pill");
  assert.equal(t.label(), "Torchship");
  assert.match(t.button.children[0].className, /^pj-dot is-c\d$/);
  t.button.props.onClick();
  const { items } = t.menus[0];
  assert.deepEqual(items.filter((i) => i && i !== "-").map((i) => i.label), ["Torchship", "Nova", "No project", "New project…"]);
  assert.ok(items[0].icon, "the current one is checked");
  items[1].run();
  assert.deepEqual(t.entered, ["p_22222222"]);
  assert.deepEqual(t.moved, []);
  for (const fn of t.watchers) fn();
  assert.equal(t.label(), "Nova");
});

test("in no project the pill reads No project with a grey dot", () => {
  const t = setup();
  assert.equal(t.label(), "No project");
  assert.equal(t.button.children[0].className, "pj-dot is-none");
});

test("on a conversation the menu is headed Move to, and picking moves it", () => {
  const t = setup({ current: "s_1", chosen: "p_11111111", of: { s_1: "p_11111111" }, roots: ["s_1"] });
  assert.equal(t.label(), "Torchship");
  t.button.props.onClick();
  const { items } = t.menus[0];
  assert.deepEqual([items[0].label, items[0].disabled], ["Move to", true]);
  items.find((i) => i && i.label === "No project").run();
  assert.deepEqual(t.moved, [["s_1", null]]);
  assert.deepEqual(t.entered, []);
});

test("a subagent's pill says the space and opens nothing", () => {
  const t = setup({ current: "s_child", chosen: "p_22222222", roots: ["s_1"] });
  assert.equal(t.label(), "Nova");
  assert.equal(t.button.disabled, true);
  t.button.props.onClick();
  assert.equal(t.menus.length, 0);
});

test("the dot colour is stable per id", () => {
  assert.equal(dotClass("p_11111111"), dotClass("p_11111111"));
  assert.equal(dotClass(null), "is-none");
});

test("unmounting stops every watch", () => {
  const t = setup();
  t.stop();
  assert.equal(t.watchers.size, 0);
  assert.equal(t.conversationWatchers.size, 0);
});

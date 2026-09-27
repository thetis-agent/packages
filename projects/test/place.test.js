// The Project place over a fake seam: with no project chosen and none asked for, it offers the list and
// New project, and asks the server for nothing until one is picked; with a project chosen in the sidebar,
// or asked for, or "new", it opens the page for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openPlace } from "../ui/place.js";

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

function node(tag, props = {}) {
  const n = { tag, props, children: [], listeners: {} };
  n.append = (...items) => n.children.push(...items.flat().filter((c) => c != null && c !== false));
  n.addEventListener = (type, fn) => (n.listeners[type] = fn);
  n.querySelector = () => null;
  return n;
}
const el = (tag, props = {}, ...children) => {
  const n = node(tag, props);
  n.append(...children);
  return n;
};
const clear = (n) => ((n.children = []), n);
const text = (n) => (typeof n === "string" ? n : n.children.map(text).join(""));
const find = (n, cls, out = []) => {
  if (typeof n === "string") return out;
  if (String(n.props.class ?? "").split(" ").includes(cls)) out.push(n);
  for (const c of n.children) find(c, cls, out);
  return out;
};

function fakeExt() {
  const requests = [];
  const ext = {
    dom: { el, clear },
    ui: {
      button: (label, opts) => el("button", { class: `btn${opts?.tone ? ` is-${opts.tone}` : ""}` }, label),
      field: (label, input) => el("label", {}, label, input),
      section: (label) => el("div", { class: "section-head" }, label),
      confirm: async () => false,
    },
    conversation: { current: null },
    toast: () => {},
    request: (verb, opts) => {
      requests.push({ verb, ...opts });
      return new Promise(() => {}); // the page's own answer is not what these tests are about
    },
  };
  return { ext, requests };
}

function fakeState({ chosen = null } = {}) {
  const watchers = new Set();
  return {
    chosen,
    projects: [{ id: "p_1", name: "Nova", directories: ["/srv/nova"], conversations: 2 }],
    choose(id) {
      this.chosen = id;
    },
    refresh: async () => {},
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    watchers,
  };
}

test("with no project chosen, the place says pick or create, lists the projects, and asks nothing", () => {
  const { ext, requests } = fakeExt();
  const state = fakeState();
  const root = node("div");
  const close = openPlace(ext, state, root, {});
  const shown = text(root);
  assert.match(shown, /Pick a project or create one/);
  assert.match(shown, /Nova2 conversations · 1 directory/);
  assert.match(shown, /New project/);
  assert.equal(find(root, "pj-name").length, 0, "no empty form to type into");
  assert.deepEqual(requests, []);
  assert.equal(state.watchers.size, 1, "the list follows the projects while it is on screen");
  close();
  assert.equal(state.watchers.size, 0);
});

test("picking a project from the list chooses it and opens its page", () => {
  const { ext, requests } = fakeExt();
  const state = fakeState();
  const root = node("div");
  openPlace(ext, state, root, {});
  find(root, "pj-pick-row")[0].props.onClick();
  assert.equal(state.chosen, "p_1");
  assert.deepEqual(requests.map((r) => [r.verb, r.args]), [["get", { id: "p_1" }]]);
  assert.equal(state.watchers.size, 0);
});

test("New project opens the empty form", () => {
  const { ext, requests } = fakeExt();
  const root = node("div");
  openPlace(ext, fakeState(), root, {});
  const newBtn = find(root, "btn").find((b) => text(b) === "New project");
  newBtn.listeners.click();
  assert.deepEqual(requests.map((r) => [r.verb, r.args]), [["get", {}]]);
});

test("the project chosen in the sidebar opens directly; { new: true } opens the form; { id } opens that project", () => {
  for (const [state, params, args] of [
    [fakeState({ chosen: "p_1" }), {}, { id: "p_1" }],
    [fakeState({ chosen: "p_1" }), { new: true }, {}],
    [fakeState(), { id: "p_9" }, { id: "p_9" }],
  ]) {
    const { ext, requests } = fakeExt();
    const root = node("div");
    openPlace(ext, state, root, params);
    assert.deepEqual(requests.map((r) => [r.verb, r.args]), [["get", args]], JSON.stringify(params));
    assert.doesNotMatch(text(root), /Pick a project/);
  }
});

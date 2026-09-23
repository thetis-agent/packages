// What a transcript draws when it is rebuilt from a session record, under a DOM small enough to fit in
// this file. The case that matters here is a record with a turn still in progress, which is what a page
// gets when it is refreshed mid-turn: the kernel writes the turn's input into the saved conversation the
// moment the turn starts, so the record carries that message twice — once in `conversation` and once as
// `turn.input` — and drawing both put the person's own words on the page twice on every such refresh.
// The elements here are plain objects that remember their tag, attributes and children, with just enough
// selector matching for what the restore path asks for; anything it asks for that is not understood
// throws, so a test that stops exercising the real code says so rather than passing quietly.
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- the smallest DOM the transcript can be drawn into ----

class FakeNode {
  constructor(tag) {
    this.tag = String(tag).toLowerCase();
    this.attrs = {};
    this.children = [];
    this.parentElement = null;
    this.text = "";
    this.hidden = false;
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.style = { setProperty: (key, value) => (this.style[key] = value), removeProperty: (key) => delete this.style[key] };
    this.dataset = new Proxy(this.attrs, {
      get: (attrs, key) => attrs[`data-${dashed(String(key))}`],
      set: (attrs, key, value) => ((attrs[`data-${dashed(String(key))}`] = String(value)), true),
      deleteProperty: (attrs, key) => delete attrs[`data-${dashed(String(key))}`],
      has: (attrs, key) => `data-${dashed(String(key))}` in attrs,
    });
    this.classList = {
      add: (...names) => this.#classes(new Set([...this.#classes(), ...names])),
      remove: (...names) => {
        const set = this.#classes();
        for (const name of names) set.delete(name);
        this.#classes(set);
      },
      toggle: (name, on) => (on ? this.classList.add(name) : this.classList.remove(name)),
      contains: (name) => this.#classes().has(name),
    };
  }
  #classes(next) {
    if (next) return void (this.attrs.class = [...next].join(" "));
    return new Set(String(this.attrs.class || "").split(/\s+/).filter(Boolean));
  }
  get className() {
    return this.attrs.class || "";
  }
  set className(value) {
    this.attrs.class = value;
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
  }
  removeAttribute(key) {
    delete this.attrs[key];
  }
  getAttribute(key) {
    return this.attrs[key] ?? null;
  }
  addEventListener() {}
  removeEventListener() {}
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    const at = this.parentElement?.children.indexOf(this) ?? -1;
    if (at >= 0) this.parentElement.children.splice(at, 1);
    this.parentElement = null;
  }
  get childElementCount() {
    return this.children.filter((c) => c.tag !== "#text").length;
  }
  get textContent() {
    return this.tag === "#text" ? this.text : this.children.map((c) => c.textContent).join("");
  }
  set textContent(value) {
    this.replaceChildren(Object.assign(new FakeNode("#text"), { text: String(value) }));
  }
  appendData(value) {
    this.text += value;
  }
  scrollIntoView() {}
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const found = [];
    for (const path of String(selector).split(",")) {
      for (const node of descendants(this)) if (matchesPath(node, path.trim(), this)) found.push(node);
    }
    return [...new Set(found)];
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (matches(node, selector.trim())) return node;
    return null;
  }
}

const dashed = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function* descendants(node) {
  for (const child of node.children) {
    if (child.tag === "#text") continue;
    yield child;
    yield* descendants(child);
  }
}

/** One compound selector: an optional tag, any number of `.class`es and `[attr]`/`[attr="value"]`s. */
function matches(node, compound) {
  const parts = compound.match(/^[a-z*][-\w]*|\.[-\w]+|\[[^\]]+\]/gi) ?? [];
  if (parts.join("") !== compound) throw new Error(`the fake DOM does not understand the selector ${JSON.stringify(compound)}`);
  for (const part of parts) {
    if (part.startsWith(".")) {
      if (!node.classList.contains(part.slice(1))) return false;
    } else if (part.startsWith("[")) {
      const [, key, value] = /^\[([-\w]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(part) ?? [];
      if (!key) throw new Error(`the fake DOM does not understand the selector ${JSON.stringify(compound)}`);
      if (!(key in node.attrs)) return false;
      if (value !== undefined && node.attrs[key] !== value) return false;
    } else if (part !== "*" && part !== node.tag) return false;
  }
  return true;
}

/** A path of compound selectors joined by `>`, optionally rooted at `:scope`. Descendant combinators are not used here. */
function matchesPath(node, path, scope) {
  const steps = path.split(">").map((s) => s.trim());
  if (steps.some((s) => /\s/.test(s))) throw new Error(`the fake DOM only joins selectors with ">", not ${JSON.stringify(path)}`);
  let at = node;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!at) return false;
    if (steps[i] === ":scope") return at === scope;
    if (!matches(at, steps[i])) return false;
    at = at.parentElement;
  }
  return true;
}

globalThis.Node = FakeNode;
globalThis.document = {
  body: new FakeNode("body"),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => Object.assign(new FakeNode("#text"), { text }),
  getElementById: () => null,
};
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 1;
};
globalThis.cancelAnimationFrame = () => {};

const { mountTranscript } = await import("../assets/views/transcript.js");

// ---- the records ----

const TURN_CONTEXT_LINE = "\n\n[Turn context: Tuesday 2026-09-23 02:14 UTC]";
const ASKED = "what is the plan?";
const EARLIER = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

/** A record as `GET /api/sessions/<id>` answers it while a turn is running. `saved` is the copy in the conversation. */
function midTurn(saved, input = ASKED, events = []) {
  return {
    id: "s_1",
    conversation: [...EARLIER, ...(saved === null ? [] : [{ role: "user", content: saved }])],
    usage: {},
    children: [],
    turn: { session: "s_1", turn: "t_1", input, startedAt: new Date().toISOString(), events },
  };
}

function drawn(record) {
  const parent = new FakeNode("section");
  const root = new FakeNode("div");
  parent.append(root);
  const transcript = mountTranscript(root, { session: "s_1" });
  transcript.restore(record);
  return root.querySelectorAll(".msg.is-user > .msg-text").map((node) => node.textContent);
}

// ---- what it draws ----

test("a turn in progress does not put the person's message on the page twice", () => {
  assert.deepEqual(drawn(midTurn(ASKED)), ["hello", ASKED]);
});

test("the harness's turn context line on one copy is not a different message", () => {
  // The record is saved as the turn starts, before the step that appends the line runs, so the two copies
  // of the same message can differ by exactly that line. The row drawn never shows it either way.
  assert.deepEqual(drawn(midTurn(ASKED + TURN_CONTEXT_LINE)), ["hello", ASKED]);
  assert.deepEqual(drawn(midTurn(ASKED, ASKED + TURN_CONTEXT_LINE)), ["hello", ASKED]);
});

test("a turn whose input the record does not carry is still drawn", () => {
  // A record whose opening save has not landed, or one written by an older kernel: the input is the only
  // copy there is, so dropping it would lose what the person said.
  assert.deepEqual(drawn(midTurn(null)), ["hello", ASKED]);
  assert.deepEqual(drawn(midTurn("something else")), ["hello", "something else", ASKED]);
});

test("a conversation with no turn in progress draws its saved messages and nothing more", () => {
  assert.deepEqual(drawn({ id: "s_1", conversation: EARLIER, usage: {}, children: [], turn: null }), ["hello"]);
});

test("the turn's events are replayed on top of the restored history", () => {
  const events = [
    { seq: 1, event: { type: "turn.start", turn: "t_1", session: "s_1" } },
    { seq: 2, event: { type: "text", delta: "wor" } },
    { seq: 3, event: { type: "text", delta: "king" } },
  ];
  const parent = new FakeNode("section");
  const root = new FakeNode("div");
  parent.append(root);
  const transcript = mountTranscript(root, { session: "s_1" });
  transcript.restore(midTurn(ASKED, ASKED, events));
  assert.deepEqual(root.querySelectorAll(".msg.is-user > .msg-text").map((n) => n.textContent), ["hello", ASKED]);
  // `turn.start` carries no input on a replay, so it adds no row of its own; the streamed text does.
  assert.equal(root.querySelectorAll(".msg.is-assistant").at(-1).textContent.includes("working"), true);
});

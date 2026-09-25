// Minimal DOM shared by the transcript and tab regression tests.
export class FakeNode {
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
  addEventListener(name, fn) {
    this.listeners ??= new Map();
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners?.get(name)?.delete(fn); }
  dispatchEvent(event) {
    for (const fn of this.listeners?.get(event.type) ?? []) fn(event);
    return true;
  }
  /** A click as a person makes it: the node's own listeners, then the document's (what `onClickOutside` hears). */
  click() {
    const event = { type: "click", target: this, composedPath: () => ancestors(this), preventDefault() {}, stopPropagation() {} };
    this.dispatchEvent(event);
    document.dispatchEvent(event);
  }
  focus() {
    if (this.attrs.disabled !== undefined) return;
    document.activeElement = this;
  }
  contains(node) {
    return ancestors(node).includes(this);
  }
  /** The box a test gave the node as `rect`, or nothing at the origin. */
  getBoundingClientRect() {
    const r = this.rect ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
  get offsetWidth() { return this.rect?.width ?? 0; }
  get offsetHeight() { return this.rect?.height ?? 0; }
  insertBefore(node, before) {
    const at = this.children.indexOf(before);
    node.parentElement = this;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
  }
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

/** The node and its ancestors, nearest first: what `composedPath` answers. */
function ancestors(node) {
  const out = [];
  for (let at = node; at; at = at.parentElement) out.push(at);
  return out;
}

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
globalThis.Element = FakeNode;
const documentListeners = new Map(); // event name -> Set of listeners; the capture flag is not modelled
globalThis.document = {
  body: new FakeNode("body"),
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => Object.assign(new FakeNode("#text"), { text }),
  getElementById: (id) => [...descendants(document.body)].find((node) => node.attrs.id === id) ?? null,
  addEventListener(name, fn) {
    if (!documentListeners.has(name)) documentListeners.set(name, new Set());
    documentListeners.get(name).add(fn);
  },
  removeEventListener(name, fn) { documentListeners.get(name)?.delete(fn); },
  dispatchEvent(event) {
    for (const fn of [...(documentListeners.get(event.type) ?? [])]) fn(event);
    return true;
  },
};
globalThis.window ??= { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 1;
};
globalThis.cancelAnimationFrame = () => {};


globalThis.CSS = { escape: (value) => value };

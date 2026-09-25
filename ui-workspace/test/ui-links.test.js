/* Pure tests for the transcript links: path finding, the gist locator, the text splitter, and
 * `linkifyText` over a minimal DOM shim. Also `node --check` on the browser modules this side owns. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// ---- a DOM shim small enough to read: text nodes, elements, replaceWith, childNodes ----

class ShimNode {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  append(...nodes) { for (const n of nodes) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); } }
  insertBefore(node, ref) { const at = this.childNodes.indexOf(ref); node.parentNode = this; this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node); }
  removeChild(node) { const at = this.childNodes.indexOf(node); if (at >= 0) this.childNodes.splice(at, 1); node.parentNode = null; }
  replaceWith(...nodes) { const p = this.parentNode; if (!p) return; for (const n of nodes) p.insertBefore(n, this); p.removeChild(this); }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((c) => c.textContent).join(""); }
}
class ShimText extends ShimNode {
  constructor(text) { super(3); this.nodeValue = String(text); }
  get data() { return this.nodeValue; }
}
class ShimElement extends ShimNode {
  constructor(tag) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    const self = this;
    this.classList = { contains: (c) => (self.attrs.class ?? "").split(/\s+/).includes(c), add: (c) => { self.attrs.class = `${self.attrs.class ?? ""} ${c}`.trim(); } };
  }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class ?? ""; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  get dataset() { const d = {}; for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith("data-")) d[k.slice(5)] = v; return d; }
}
globalThis.document = {
  createElement: (tag) => new ShimElement(tag),
  createTextNode: (text) => new ShimText(text),
};

const { findPaths, gistSpan, linkifyText, splitText } = await import("../ui/links.js");

// ---- findPaths ----

test("findPaths: absolute, home and relative paths, with lines", () => {
  const found = findPaths("Read /home/me/notes.md then ~/x.md:12 and src/tide.ts:7, also /etc/hosts.");
  assert.deepEqual(found, [
    { raw: "/home/me/notes.md", path: "/home/me/notes.md", line: null },
    { raw: "~/x.md:12", path: "~/x.md", line: 12 },
    { raw: "src/tide.ts:7", path: "src/tide.ts", line: 7 },
    { raw: "/etc/hosts", path: "/etc/hosts", line: null },
  ]);
});

test("findPaths: ignores URLs and bare words", () => {
  assert.deepEqual(findPaths("See https://example.com/a/b.js and http://x.y/z.md:3 for more"), []);
  assert.deepEqual(findPaths("either/or is fine, and/or too, 50/50 as well"), []);
  assert.deepEqual(findPaths("a plain sentence with no paths"), []);
  assert.deepEqual(findPaths("a slash / on its own and ~ alone"), []);
});

test("findPaths: deduplicates and strips trailing punctuation", () => {
  const found = findPaths("open /tmp/a.txt, then /tmp/a.txt. Also (see ~/b.md:4).");
  assert.deepEqual(found, [
    { raw: "/tmp/a.txt", path: "/tmp/a.txt", line: null },
    { raw: "~/b.md:4", path: "~/b.md", line: 4 },
  ]);
});

test("findPaths: quotes and backticks bound a path", () => {
  assert.deepEqual(findPaths('the file "/srv/app/index.js" and `lib/util.mjs`'), [
    { raw: "/srv/app/index.js", path: "/srv/app/index.js", line: null },
    { raw: "lib/util.mjs", path: "lib/util.mjs", line: null },
  ]);
});

// ---- gistSpan: where the path sits in the shell's gist line ----

const gist = (args, max) => {
  // The shell's formatter, copied so the locator is checked against the real shape.
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) continue;
    const one = text.replace(/\s+/g, " ").trim();
    parts.push(`${key}: ${one.length > 60 ? one.slice(0, 59) + "…" : one}`);
  }
  const line = parts.join("  ·  ");
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

test("gistSpan: finds the path when it is the first argument", () => {
  const args = { path: "src/tide.ts", offset: 3, limit: 40 };
  const text = gist(args, 90);
  const span = gistSpan(text, args);
  assert.ok(span && span.full);
  assert.equal(text.slice(span.start, span.end), "src/tide.ts");
});

test("gistSpan: finds the path after other arguments", () => {
  const args = { pattern: "foo bar", path: "/home/me/proj", glob: "*.js" };
  const text = gist(args, 90);
  const span = gistSpan(text, args);
  assert.ok(span && span.full);
  assert.equal(text.slice(span.start, span.end), "/home/me/proj");
});

test("gistSpan: a value cut at 60 is matched with its ellipsis", () => {
  const long = "/home/me/projects/thetis-agent/runtime/packages/ui-workspace/ui/links.js";
  const args = { path: long, offset: 1 };
  const text = gist(args, 90);
  const span = gistSpan(text, args);
  assert.ok(span && span.full);
  assert.equal(text.slice(span.start, span.end), long.slice(0, 59) + "…");
});

test("gistSpan: a line cut through the path wraps the visible prefix", () => {
  const args = { old_text: "x".repeat(70), path: "/home/me/projects/app/src/index.js" };
  const text = gist(args, 90);
  const span = gistSpan(text, args);
  assert.ok(span && !span.full);
  assert.equal(span.end, text.length);
  assert.ok(text.slice(span.start, span.end).startsWith("/home/me"));
});

test("gistSpan: a path cut off the line entirely is null", () => {
  const args = { pattern: "y".repeat(70), glob: "z".repeat(70), path: "/home/me/a" };
  assert.equal(gistSpan(gist(args, 90), args), null);
  assert.equal(gistSpan("", { path: "/a" }), null);
  assert.equal(gistSpan("path: /a", {}), null);
});

// ---- splitText and linkifyText ----

test("splitText: links only what resolve confirmed", () => {
  const resolved = new Map([["/tmp/a.txt", { absolute: "/tmp/a.txt", kind: "file" }]]);
  const parts = splitText("open /tmp/a.txt and /nope/b.txt", resolved);
  assert.deepEqual(parts, [
    { text: "open " },
    { link: { raw: "/tmp/a.txt", path: "/tmp/a.txt", line: null, absolute: "/tmp/a.txt" } },
    { text: " and /nope/b.txt" },
  ]);
  assert.deepEqual(splitText("nothing here", resolved), [{ text: "nothing here" }]);
});

test("splitText: a plain object works, and every occurrence is linked", () => {
  const parts = splitText("src/a.js then src/a.js:9", { "src/a.js": { absolute: "/home/me/src/a.js" } });
  assert.equal(parts.filter((p) => p.link).length, 2);
  assert.equal(parts[0].link.absolute, "/home/me/src/a.js");
  assert.equal(parts[0].link.line, null);
  assert.equal(parts[2].link.raw, "src/a.js:9");
  assert.equal(parts[2].link.line, 9);
});

test("linkifyText: replaces text nodes, skips anchors and existing links", () => {
  const p = new ShimElement("p");
  p.append(new ShimText("see ~/x.md:12 and "));
  const code = new ShimElement("code");
  code.append(new ShimText("src/tide.ts"));
  p.append(code);
  const a = new ShimElement("a");
  a.append(new ShimText(" ~/x.md:12 "));
  p.append(a);
  const resolved = { "~/x.md": { absolute: "/home/me/x.md" }, "src/tide.ts": { absolute: "/home/me/src/tide.ts" } };
  const made = linkifyText(p, resolved);
  assert.equal(made.length, 2);
  assert.equal(made[0].tagName, "A");
  assert.equal(made[0].getAttribute("data-path"), "/home/me/x.md");
  assert.equal(made[0].getAttribute("data-line"), "12");
  assert.equal(made[0].textContent, "~/x.md:12");
  assert.equal(made[1].getAttribute("data-path"), "/home/me/src/tide.ts");
  assert.equal(made[1].getAttribute("data-line"), null);
  assert.equal(p.textContent, "see ~/x.md:12 and src/tide.ts ~/x.md:12 ");
  assert.equal(a.childNodes.length, 1, "an existing anchor is left alone");
  assert.equal(linkifyText(p, resolved).length, 0, "a second pass makes nothing");
});

// ---- the browser files parse ----

test("ui/dock.js, links.js, dialogs.js pass node --check", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
  const mine = ["dock.js", "links.js", "dialogs.js"].filter((f) => readdirSync(dir).includes(f));
  assert.equal(mine.length, 3);
  for (const file of mine) {
    const out = spawnSync(process.execPath, ["--check", join(dir, file)], { encoding: "utf8" });
    assert.equal(out.status, 0, `${file}: ${out.stderr}`);
  }
});

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

// ---- prose in a bubble: bubbleCandidates and decorateBubble over the shim ----

const { bubbleCandidates, decorateBubble } = await import("../ui/links.js");

// The shim's elements need getAttribute/setAttribute/removeAttribute for the linked mark (they have the first two).
ShimElement.prototype.removeAttribute = function (k) { delete this.attrs[k]; };

function bubble(...children) {
  const node = new ShimElement("div");
  node.className = "msg-text";
  node.append(...children.map((c) => (typeof c === "string" ? new ShimText(c) : c)));
  return node;
}
function tagged(tag, text) {
  const node = new ShimElement(tag);
  node.append(new ShimText(text));
  return node;
}
const links = (node) => {
  const out = [];
  const walk = (n) => { if (n.nodeType === 1 && n.tagName === "A") out.push(n); for (const c of n.childNodes ?? []) walk(c); };
  walk(node);
  return out;
};

test("bubbleCandidates: distinct paths from the text runs, none from links, buttons or fenced blocks", () => {
  const node = bubble("See src/tide.ts:7 and /nope/x.ts, then src/tide.ts again. ", tagged("code", "~/notes.md"), " ", tagged("pre", "/etc/hosts"), tagged("a", "/already/linked.js"));
  assert.deepEqual(bubbleCandidates(node), ["src/tide.ts", "/nope/x.ts", "~/notes.md"]);
  assert.deepEqual(bubbleCandidates(bubble("nothing path-shaped here")), []);
});

test("decorateBubble: asks resolve once for the candidates, links only the confirmed, keeps the rest as text", async () => {
  const asked = [];
  const resolve = async (paths) => { asked.push(paths); return { "src/tide.ts": { absolute: "/srv/games/nova/src/tide.ts", kind: "file", mode: "rw" }, "/nope/x.ts": null }; };
  const node = bubble("Edit src/tide.ts:7; /nope/x.ts does not exist.");
  const made = await decorateBubble(node, { session: "s_1", resolve });
  assert.deepEqual(asked, [["src/tide.ts", "/nope/x.ts"]]);
  assert.equal(made.length, 1);
  assert.equal(links(node).length, 1);
  assert.deepEqual([made[0].getAttribute("data-path"), made[0].getAttribute("data-line"), made[0].textContent], ["/srv/games/nova/src/tide.ts", "7", "src/tide.ts:7"]);
  assert.equal(node.textContent, "Edit src/tide.ts:7; /nope/x.ts does not exist.", "the words are unchanged; only wrapping differs");
  assert.equal(node.getAttribute("data-ws-linked"), "1");
  assert.deepEqual(await decorateBubble(node, { session: "s_1", resolve }), [], "a bubble is decorated once");
  assert.equal(asked.length, 1);
});

test("decorateBubble: the cache answers for a second bubble, a bubble without candidates asks nothing, a failed ask is retried later", async () => {
  const cache = new Map();
  let calls = 0;
  const resolve = async (paths) => { calls += 1; return Object.fromEntries(paths.map((p) => [p, p === "/nope/x.ts" ? null : { absolute: p, kind: "file", mode: "ro" }])); };
  await decorateBubble(bubble("first: /srv/shared/a.md and /nope/x.ts"), { session: "s_1", resolve, cache });
  assert.equal(calls, 1);
  const second = bubble("again /srv/shared/a.md, plus /srv/shared/b.md");
  await decorateBubble(second, { session: "s_1", resolve, cache });
  assert.equal(calls, 2, "only the new path is asked about");
  assert.equal(links(second).length, 2);
  await decorateBubble(bubble("/nope/x.ts once more, and /srv/shared/a.md"), { session: "s_1", resolve, cache });
  assert.equal(calls, 2, "everything was cached: nothing asked");
  await decorateBubble(bubble("no paths at all"), { session: "s_1", resolve, cache });
  assert.equal(calls, 2, "nothing to ask about");
  const failing = bubble("/srv/shared/c.md");
  await decorateBubble(failing, { session: "s_1", resolve: async () => { throw new Error("no answer"); }, cache });
  assert.equal(links(failing).length, 0);
  assert.equal(failing.getAttribute("data-ws-linked"), null, "a failed ask leaves the bubble for a later offer");
  await decorateBubble(failing, { session: "s_1", resolve, cache });
  assert.equal(links(failing).length, 1);
});

// ---- restored cards: reading a drawn card back, and decorating it once ----

const { decorateCard, readCall, touchedStrip } = await import("../ui/links.js");

/** A card the way the shell draws it: `details.tool > summary.tool-head > .tool-name .tool-gist .tool-took .tool-status`, then label + pre pairs. */
function shellCard(id, name, args, { status = "done", result = "ok" } = {}) {
  const card = new ShimElement("details");
  card.className = "tool";
  card.setAttribute("data-tool", id);
  const head = new ShimElement("summary");
  head.className = "tool-head";
  head.append(tagged("span", name), tagged("span", gist(args && typeof args === "object" ? args : {}, 90)), tagged("span", ""), tagged("span", status));
  head.childNodes[0].className = "tool-name";
  head.childNodes[1].className = "tool-gist";
  head.childNodes[2].className = "tool-took";
  head.childNodes[3].className = "tool-status";
  card.append(head);
  if (args !== null) {
    card.append(tagged("div", "arguments"), tagged("pre", typeof args === "string" ? args : JSON.stringify(args, null, 2)));
    card.childNodes[1].className = "tool-label";
    card.childNodes[2].className = "tool-pre";
  }
  if (result !== null) {
    const n = card.childNodes.length;
    card.append(tagged("div", "result"), tagged("pre", result));
    card.childNodes[n].className = "tool-label";
    card.childNodes[n + 1].className = "tool-pre";
  }
  return card;
}
function shellRun(...cards) {
  const run = new ShimElement("details");
  run.className = "tool-run";
  const body = new ShimElement("div");
  body.className = "tool-run-body";
  body.append(...cards);
  run.append(tagged("summary", "2 tool calls"), body);
  run.childNodes[0].className = "tool-run-head";
  return run;
}
const kids = (node, cls) => node.childNodes.filter((n) => n.nodeType === 1 && n.classList.contains(cls));

test("readCall: the id, the name and the parsed arguments of a drawn files-tool card; null otherwise", () => {
  const args = { path: "/home/rae/src/tide.ts", offset: 7, limit: 3 };
  assert.deepEqual(readCall(shellCard("c_read", "read_path", args, { result: '{"path": "/not/the/arguments"}' })), { id: "c_read", name: "read_path", args }, "the arguments pre, never the result pre");
  assert.equal(readCall(shellCard("c_bash", "bash", { command: "ls" })), null, "not a files tool");
  assert.equal(readCall(shellCard("c_broken", "read_path", "{ not json")), null, "arguments that do not parse");
  assert.equal(readCall(shellCard("c_bare", "get_directory", null)), null, "no arguments drawn");
  assert.equal(readCall(shellCard("c_list", "find_files", "[1, 2]")), null, "arguments that are not an object");
  assert.equal(readCall(shellCard("", "read_path", args)), null, "no id");
  assert.equal(readCall(null), null);
});

test("decorateCard and touchedStrip: a restored card is decorated once, the run's strip is one element with distinct paths", () => {
  const tide = "/home/rae/src/tide.ts";
  const read = shellCard("c_read", "read_path", { path: tide, offset: 7, limit: 3 });
  const edit = shellCard("c_edit", "edit_path", { path: tide, old: "a", new: "b" });
  const dir = shellCard("c_dir", "get_directory", { path: "/home/rae/src" });
  const run = shellRun(read, edit, dir);
  const head = (card) => kids(card, "tool-head")[0];
  const gistOf = (card) => kids(head(card), "tool-gist")[0];

  assert.equal(decorateCard(read, readCall(read)), true);
  assert.equal(decorateCard(read, readCall(read)), true, "a second pass answers true and changes nothing");
  assert.equal(read.getAttribute("data-ws-linked"), "1");
  assert.equal(links(gistOf(read)).length, 1, "one link in the gist");
  assert.equal(links(gistOf(read))[0].getAttribute("data-path"), tide);
  assert.equal(links(gistOf(read))[0].getAttribute("data-line"), "7", "a read's offset is the line");
  assert.equal(gistOf(read).textContent, gist({ path: tide, offset: 7, limit: 3 }, 90), "the gist reads as before");
  const pills = kids(head(read), "ws-open");
  assert.equal(pills.length, 1, "one Open pill");
  assert.equal(pills[0].getAttribute("data-path"), tide);
  assert.equal(head(read).childNodes.indexOf(pills[0]), head(read).childNodes.indexOf(kids(head(read), "tool-status")[0]) - 1, "the pill sits before the status");

  assert.equal(touchedStrip(run)?.getAttribute("data-count"), "1", "the run knows the read's path");
  assert.equal(decorateCard(edit, readCall(edit)), true);
  assert.equal(decorateCard(dir, readCall(dir)), true);
  const bash = shellCard("c_bash", "bash", { command: "ls" });
  assert.equal(decorateCard(bash, readCall(bash)), false, "a card that is not a files tool is left alone");
  assert.equal(bash.getAttribute("data-ws-linked"), null);

  touchedStrip(run);
  const strip = touchedStrip(run);
  assert.equal(kids(run, "ws-touched").length, 1, "one strip however often it is refreshed");
  assert.equal(run.childNodes.indexOf(strip), run.childNodes.indexOf(kids(run, "tool-run-body")[0]) + 1, "the strip follows the run body");
  assert.deepEqual(links(strip).map((a) => a.getAttribute("data-path")), [tide, "/home/rae/src"], "distinct paths, first-seen order, never doubled");
  assert.equal(strip.getAttribute("data-count"), "2");
  assert.equal(touchedStrip(shellRun(shellCard("c_x", "bash", { command: "ls" }))), null, "a run that named no path gets no strip");
});

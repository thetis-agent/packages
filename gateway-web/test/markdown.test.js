// The renderer under a DOM small enough to fit here: elements are plain objects that remember their tag,
// attributes and children. Enough to see what `![alt](src)` becomes, which is the part a README depends on.
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...nodes) {
    this.children.push(...nodes);
  }
  set className(v) {
    this.attrs.class = v;
  }
  get textContent() {
    return this.tag === "#text" ? this.text : this.children.map((c) => c.textContent).join("");
  }
}
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => Object.assign(new FakeNode("#text"), { text }),
};
const { renderMarkdown } = await import("../assets/lib/markdown.js");

const images = (blocks) => {
  const out = [];
  const walk = (n) => {
    if (!(n instanceof FakeNode)) return;
    if (n.tag === "img" || n.attrs.class === "md-img-missing") out.push(n);
    n.children.forEach(walk);
  };
  blocks.forEach(walk);
  return out;
};

test("an https image is an <img>; a relative one asks the resolver; anything else is its alt text", () => {
  const remote = images(renderMarkdown("see ![a chart](https://example.org/c.svg) here"));
  assert.equal(remote.length, 1);
  assert.deepEqual([remote[0].tag, remote[0].attrs.class, remote[0].attrs.src, remote[0].attrs.alt], ["img", "md-img", "https://example.org/c.svg", "a chart"]);

  const resolved = images(renderMarkdown("![chart](bench/x/chart.svg)", { image: (src) => (src === "bench/x/chart.svg" ? "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E" : null) }));
  assert.equal(resolved[0].tag, "img");
  assert.match(resolved[0].attrs.src, /^data:image\/svg\+xml/);

  const missing = images(renderMarkdown("![chart](bench/x/chart.svg)", { image: () => null }));
  assert.deepEqual([missing[0].tag, missing[0].attrs.class, missing[0].textContent], ["span", "md-img-missing", "chart"]);
  const unresolved = images(renderMarkdown("![chart](bench/x/chart.svg)"));
  assert.equal(unresolved[0].attrs.class, "md-img-missing", "no resolver, so the alt text");

  for (const src of ["/etc/x.svg", "../up.svg", "a/../b.svg", "http://plain.example/x.svg", "javascript:void0", "data:image/svg+xml,x"]) {
    const asked = [];
    const blocks = renderMarkdown(`![alt text](${src})`, { image: (s) => (asked.push(s), "data:x") });
    assert.equal(images(blocks).length, 0, `${src} is not an image`);
    assert.deepEqual(asked, [], `${src} is never offered to the resolver`);
    assert.equal(blocks[0].textContent, "alt text");
  }
});

test("a link is still a link, and an image inside a table cell or a list item is found", () => {
  const link = renderMarkdown("[docs](https://example.org)")[0].children[0];
  assert.deepEqual([link.tag, link.attrs.href], ["a", "https://example.org"]);
  const table = renderMarkdown("| a |\n|---|\n| ![p](https://e.org/p.png) |");
  assert.equal(images(table).length, 1);
  const list = renderMarkdown("- ![p](x.png)", { image: () => "data:image/png;base64,AAEC" });
  assert.equal(images(list)[0].attrs.src, "data:image/png;base64,AAEC");
});

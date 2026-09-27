// The tree the control panel draws its sections with: a node a package marks `closed` starts closed until the
// reader opens it, and a node marked `look` needs a look whatever its dot's tone (the Extensions place's neutral
// to-dos are counted as the place counts them).
import { test } from "node:test";
import assert from "node:assert/strict";

import "./dom-fixture.js";

const { createTree } = await import("../assets/lib/tree.js");
const { el } = await import("../assets/lib/dom.js");

/** Every tree row drawn, as `[key, expanded]`. */
const rows = (host) => {
  const out = [];
  const walk = (n) => {
    for (const c of n.children ?? []) {
      if (typeof c !== "object") continue;
      if (c.attrs?.role === "treeitem") out.push([c.attrs["data-key"], c.attrs["aria-expanded"] ?? null]);
      walk(c);
    }
  };
  walk(host);
  return out;
};

test("a closed node starts closed, its children not drawn; an open-by-default one shows its children", () => {
  const host = el("div");
  createTree(host, {
    nodes: [
      { key: "ext", label: "Extensions", children: [{ key: "exa", label: "Exa" }, { key: "parts", label: "Part of Thetis", closed: true, children: [{ key: "store", label: "Store" }] }] },
    ],
  });
  assert.deepEqual(rows(host), [["ext", "true"], ["exa", null], ["parts", "false"]], "Part of Thetis is closed; Store is not drawn");
});

test("look: a node needs a look whatever its dot's tone, so focusing on what needs a look keeps it", () => {
  const host = el("div");
  const tree = createTree(host, {
    nodes: [{ key: "ext", label: "Extensions", children: [{ key: "notion", label: "Notion", mark: "dim", look: true }, { key: "files", label: "Files" }, { key: "grey", label: "Grey", mark: "dim" }] }],
  });
  tree.setFocus(true);
  assert.deepEqual(rows(host).map(([k]) => k), ["ext", "notion"], "a neutral to-do stays; a grey dot alone does not");
});

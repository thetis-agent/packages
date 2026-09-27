// The sidebar's two hosts: head entries under the brand, sections above the conversations — the shell's
// chrome (a folding heading remembered per section, a count, an actions strip) around a body the package draws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNode } from "./dom-fixture.js";
import * as registry from "../assets/lib/registry.js";
import { mountSidebarSlot } from "../assets/views/sidebar.js";

const kept = new Map();
globalThis.localStorage = {
  getItem: (key) => kept.get(key) ?? null,
  setItem: (key, value) => kept.set(key, String(value)),
  removeItem: (key) => kept.delete(key),
};

function fixture() {
  document.body.replaceChildren();
  for (const id of ["sidebar-head", "sidebar-sections"]) {
    const node = new FakeNode("div");
    node.setAttribute("id", id);
    document.body.append(node);
  }
  return { head: document.getElementById("sidebar-head"), sections: document.getElementById("sidebar-sections") };
}

test("head entries mount under the brand and sections above the conversations, in declared order, each once, with the shell's chrome around a section", () => {
  const { head, sections } = fixture();
  registry.declare({ package: "@t/projects", sidebar: [{ id: "head" }] });
  registry.declare({ package: "@t/canvases", sidebar: [{ id: "canvases", slot: "section", label: "Canvases", order: 20 }] });
  registry.declare({ package: "@t/flows", sidebar: [{ id: "flows", slot: "section", label: "Flows", order: 10 }] });
  mountSidebarSlot();
  assert.equal(head.childElementCount, 0, "declared, not registered: nothing yet");
  assert.equal(sections.childElementCount, 0);
  let tools;
  let mounts = 0;
  registry.register("sidebar", "@t/canvases", "canvases", { mount: (body, t) => { mounts += 1; tools = t; body.textContent = "rows"; } });
  registry.register("sidebar", "@t/projects", "head", { mount: (root) => { root.textContent = "switcher"; } });
  registry.register("sidebar", "@t/flows", "flows", { mount: (body) => { body.textContent = "flows"; } });
  assert.equal(head.querySelector(".sidebar-slot-item").textContent, "switcher", "a head entry mounts as it always did");
  assert.equal(head.childElementCount, 1);
  assert.deepEqual(sections.children.map((n) => n.getAttribute("data-item")), ["@t/flows#flows", "@t/canvases#canvases"], "by declared order, not by registration order");
  assert.equal(mounts, 1, "mounted once, however many times the registry changes");

  const section = sections.querySelector('[data-item="@t/canvases#canvases"]');
  assert.equal(section.querySelector(".sidebar-section-label").textContent, "Canvases");
  const body = section.querySelector(".sidebar-section-body");
  assert.equal(body.textContent, "rows", "the package drew into the body, not the chrome");
  const toggle = section.querySelector(".sidebar-section-head");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.ok(section.classList.contains("is-collapsed"));
  assert.equal(body.getAttribute("hidden"), "", "the body is hidden while folded");
  assert.equal(kept.get("thetis.sidebar.section:@t/canvases#canvases"), "0", "the fold is remembered");
  tools.expand(true);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(kept.has("thetis.sidebar.section:@t/canvases#canvases"), false, "open is the default, so nothing is kept for it");
  tools.setCount(3);
  assert.equal(section.querySelector(".sidebar-section-count").textContent, "3");
  tools.setCount(null);
  assert.equal(section.querySelector(".sidebar-section-count").textContent, "");
  const plus = new FakeNode("button");
  tools.setActions(plus, null);
  assert.deepEqual(section.querySelector(".sidebar-section-actions").children, [plus]);
});

test("a section folded last time comes back folded; a package that failed to load leaves a named, broken gap", () => {
  const { sections } = fixture();
  kept.set("thetis.sidebar.section:@t/folded#list", "0");
  registry.declare({ package: "@t/folded", sidebar: [{ id: "list", slot: "section", label: "Folded" }] });
  registry.declare({ package: "@t/broken", sidebar: [{ id: "list", slot: "section", label: "Broken" }] });
  mountSidebarSlot();
  registry.register("sidebar", "@t/folded", "list", { mount: () => {} });
  const folded = sections.querySelector('[data-item="@t/folded#list"]');
  assert.equal(folded.querySelector(".sidebar-section-head").getAttribute("aria-expanded"), "false");
  assert.ok(folded.classList.contains("is-collapsed"));
  registry.fail("@t/broken", "could not load");
  const broken = sections.querySelector('[data-item="@t/broken#list"]');
  assert.ok(broken, "the failed package's section is drawn so the gap has a name");
  assert.ok(broken.classList.contains("is-broken"));
  assert.match(broken.title, /@t\/broken extension could not load/);
});

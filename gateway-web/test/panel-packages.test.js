// The built-in Extensions section's list: the columns every extension list uses, the count of what is
// installed for this person, and the chips of the Extensions contract's one state. The Extensions place's
// `lib/state.js` is the reference for the chips; the section restates the few rules it needs (a page imports
// only its own package's files), and this test gives both the same rows and expects the same answers. The
// place's module is imported by relative path here only.
import { test } from "node:test";
import assert from "node:assert/strict";

import "./dom-fixture.js";

const list = await import("../assets/views/panel-packages.js");
const reference = await import("../../ui-marketplace/lib/state.js");

/** A row as `/api/packages` serves it (src/panel.ts), installed for this person. */
const api = (over) => ({ name: "@thetis/x", version: "0.1.0", type: "tool", description: "", scope: "me", steps: [], tools: [], service: false, hasSkills: false, pages: 0, ...over });

const ROWS = {
  shipped: api({ name: "@thetis/terminal", tools: ["run"], scope: "everyone", everyone: true, everyoneBy: "config", source: "system" }),
  marked: api({ name: "@thetis/exa", label: "exa", tools: ["exa_search"], everyone: true, everyoneBy: "marked", source: "system" }),
  promotedAlone: api({ name: "@thetis/notion", label: "Notion", tools: ["notion_search"], everyone: true, everyoneBy: "promoted", source: "system" }),
  own: api({ name: "@bitmuse/moo", label: "moo", tools: ["moo_eval"], source: "local" }),
  copyBehind: api({ name: "@bitmuse/tool-exec", label: "tool exec", version: "0.3.3-fork.1", source: "local", forkedFrom: { name: "@thetis/tool-exec", version: "0.3.3" }, fork: { name: "@thetis/tool-exec", version: "0.3.3", shipped: "0.4.1", identical: false, everyone: true }, tools: ["install"] }),
  copySame: api({ name: "@bitmuse/canvases", version: "0.1.1-fork.1", source: "local", forkedFrom: { name: "@thetis/canvases", version: "0.1.1" }, fork: { name: "@thetis/canvases", version: "0.1.1", shipped: "0.1.1", identical: true }, pages: 1 }),
  loaded: api({ name: "@thetis/skills-hybrid", type: "loader", version: "0.2.2", loaded: "0.2.1", source: "system" }),
  missingMine: api({ name: "@thetis/vikunja", tools: ["task"], source: "system", config: { broken: true, summary: "token is missing", keys: [{ key: "token", state: "missing", secret: true, help: "A Vikunja API token. Make one under Settings." }] } }),
  missingAdmins: api({ name: "@thetis/embeddings", label: "embeddings", type: "service", service: true, source: "system", config: { broken: true, summary: "apiKey is missing", keys: [{ key: "apiKey", state: "missing", missing: ["OPENROUTER_API_KEY"], source: "default", help: "The key. Put it in .env as OPENROUTER_API_KEY.", secret: true }] } }),
  bare: api({ name: "@thetis/grafana", tools: ["q"], source: "system", config: { broken: true, summary: "A setting is missing", keys: [] } }),
  everything: api({ name: "@bitmuse/mix", source: "local", forkedFrom: { name: "@thetis/mix", version: "0.1.0" }, fork: { name: "@thetis/mix", version: "0.1.0", shipped: "0.2.0" }, everyone: true, everyoneBy: "marked", config: { broken: true, summary: "k", keys: [{ key: "k", state: "missing", secret: false }] }, tools: ["a"], pages: 2 }),
  gateway: api({ name: "@thetis/gateway-web", label: "web gateway", type: "gateway", pages: 3, service: true, source: "system" }),
  provider: api({ name: "@bitmuse/provider-x", type: "provider", source: "local" }),
};

/** The same row in the Extensions place's shape (`lib/rows.js`), which is what the reference reads. */
function placeRow(r, user) {
  const label = r.label || r.name.replace(/^@[^/]+\//, "").replace(/^ui-/, "").replace(/[-_.]+/g, " ");
  const own = r.name.startsWith(`@${user}/`);
  return { ...r, label, installed: true, system: r.source === "system", own, local: r.source === "local", registry: null, tools: r.tools.map((name) => ({ name, description: "" })), update: r.loaded ? { apply: "reload", available: r.version, installed: r.loaded } : null, config: r.config ?? null };
}

test("the section's list says what the Extensions place says about the same rows, for an admin and for a person", () => {
  const rows = Object.values(ROWS);
  for (const ctx of [{ admin: true, user: "bitmuse" }, { admin: false, user: "bitmuse" }, { admin: false, user: "sam" }]) {
    const family = rows.map((r) => placeRow(r, ctx.user));
    for (const [key, r] of Object.entries(ROWS)) {
      const ours = list.stateOf(r, ctx);
      const theirs = reference.stateOf(placeRow(r, ctx.user), { admin: ctx.admin, user: ctx.user });
      const what = `${key} for ${ctx.user}${ctx.admin ? " (admin)" : ""}`;
      assert.deepEqual(ours.chips.map((c) => [c.id, c.label, c.tone, c.tooltip]), theirs.chips.map((c) => [c.id, c.label, c.tone, c.tooltip]), what);
      assert.equal(ours.attention, theirs.attention, what);
      assert.equal(ours.reason, theirs.reason, what);
      assert.equal(ours.waiting, theirs.waiting, what);
      assert.equal(list.labelOf(r), reference.labelOf(placeRow(r, ctx.user)), what);
      assert.equal(list.publisherLine(r, { user: ctx.user, rows }), reference.publisherLine(placeRow(r, ctx.user), { user: ctx.user, family }), what);
      assert.equal(list.isRequired(r), reference.isRequired(placeRow(r, ctx.user)), what);
    }
  }
});

test("the words: Required, the waiting line, the chips and a promoted copy whose original is not here", () => {
  assert.deepEqual(list.CHIPS, reference.CHIPS);
  assert.equal(list.REQUIRED.label, reference.WORDS.required);
  assert.deepEqual(list.REQUIRED.types, reference.REQUIRED.types);
  assert.deepEqual(list.REQUIRED.names, reference.REQUIRED.names);
  assert.equal(list.WAITING, reference.WORDS.waiting);
  assert.equal(list.publisherLine(ROWS.shipped, { user: "sam", rows: [] }), "by Thetis · Tools");
  assert.equal(list.publisherLine(ROWS.promotedAlone, { user: "sam", rows: [ROWS.promotedAlone, api({ name: "@bitmuse/notion" })] }), "by bitmuse · Tools");
  assert.equal(list.labelOf(ROWS.copyBehind), "Tool Exec");
  assert.deepEqual(list.stateOf(ROWS.copyBehind).chips.map((c) => c.label), ["Update available", "Customized"]);
  assert.deepEqual(list.stateOf(ROWS.missingAdmins, { admin: false }).chips, []);
  assert.equal(list.stateOf(ROWS.missingAdmins, { admin: false }).waiting, true);
});

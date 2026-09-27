// The built-in Extensions section's list: the columns every extension list uses, the count of what is
// installed for this person, and the chips of the Extensions contract's one state. With the Extensions place
// here the section judges the place's rows with the place's own module, so its answers are the place's; this
// test hands it the place's `lib/state.js` (imported by relative path here only) and expects exactly that. The
// fallback, for when the place is gone, restates only the chips, the label, the publisher line and Required,
// and is held to the place's chips over the same rows.
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

test("without the place, the fallback gives the place's chips, label, publisher line and Required for the same rows", () => {
  const rows = Object.values(ROWS);
  for (const ctx of [{ admin: true, user: "bitmuse" }, { admin: false, user: "bitmuse" }, { admin: false, user: "sam" }]) {
    const family = rows.map((r) => placeRow(r, ctx.user));
    for (const [key, r] of Object.entries(ROWS)) {
      const ours = list.stateOf(r, ctx);
      const theirs = reference.stateOf(placeRow(r, ctx.user), { admin: ctx.admin, user: ctx.user });
      const what = `${key} for ${ctx.user}${ctx.admin ? " (admin)" : ""}`;
      assert.deepEqual(ours.chips.map((c) => [c.id, c.label, c.tone, c.tooltip]), theirs.chips.map((c) => [c.id, c.label, c.tone, c.tooltip]), what);
      assert.equal(ours.attention, theirs.attention, what);
      assert.equal(ours.waiting, theirs.waiting, what);
      assert.equal(list.labelOf(r), reference.labelOf(placeRow(r, ctx.user)), what);
      assert.equal(list.publisherLine(r, { user: ctx.user, rows }), reference.publisherLine(placeRow(r, ctx.user), { user: ctx.user, family }), what);
      assert.equal(list.isRequired(r), reference.isRequired(placeRow(r, ctx.user)), what);
    }
  }
  assert.equal(list.countLine(rows.map((r) => placeRow(r, "bitmuse"))), `${rows.length} installed`);
});

test("with the place here, the section says exactly what the place says: its label, publisher line, state and Installed count", () => {
  const rules = { place: reference };
  for (const ctx of [{ admin: true, user: "bitmuse" }, { admin: false, user: "sam" }]) {
    const rows = [...Object.values(ROWS).map((r) => placeRow(r, ctx.user)), { name: "@bitmuse/notion", label: "Notion", installed: false, local: true, tools: [], config: null }];
    for (const r of rows.filter((x) => x.installed)) {
      const said = list.judged(r, rows, { rules, ...ctx });
      const family = reference.familyOf(r, rows);
      const origin = reference.officialOf(r, family);
      const label = reference.labelOf(r, origin);
      assert.equal(said.label, label, r.name);
      assert.equal(said.publisher, reference.publisherLine(r, { user: ctx.user, family: family.members }), r.name);
      assert.deepEqual(said.state, reference.stateOf(r, { ...ctx, origin, label, giver: reference.giverOf(r, { user: ctx.user, family: family.members }) }), r.name);
    }
    const promoted = list.judged(rows.find((r) => r.name === "@thetis/notion"), rows, { rules, ...ctx });
    assert.match(promoted.publisher, ctx.user === "bitmuse" ? /^by you/ : /^by bitmuse/, "a shared copy finds its person among every row the place knows");
    const { counts } = reference.placeSections(rows, ctx);
    assert.equal(list.countLine(rows, { rules, ...ctx }), `${counts.installed} installed${counts.thetis ? ` · ${counts.thetis} part of Thetis` : ""}`, "the place's own two numbers");
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
  assert.deepEqual(list.stateOf(ROWS.copyBehind).chips.map((c) => c.label), ["Customized"], "a copy behind its official version is not an update");
  assert.deepEqual(list.stateOf(ROWS.missingAdmins, { admin: false }).chips, []);
  assert.equal(list.stateOf(ROWS.missingAdmins, { admin: false }).waiting, true);
});

test("the place's rows add a registry's newer commit to what is installed, and nothing else", () => {
  const mine = [api({ name: "@thetis/orleans", version: "0.1.0" }), api({ name: "@thetis/terminal" }), ROWS.copyBehind];
  const all = [
    { name: "@thetis/orleans", update: { apply: "install", version: "0.1.1", from: "abc1234", to: "def5678" } },
    { name: "@thetis/terminal", update: { apply: "reload", version: "0.2.0" } },
    { name: "@bitmuse/tool-exec", update: { apply: "unfork", version: "0.4.1" } },
    { name: "@bitmuse/notion" },
  ];
  const known = list.withKnown(mine, all);
  assert.deepEqual(known[0].update, { apply: "install", version: "0.1.1" });
  assert.equal(known[1].update, undefined, "applying what is on disk is the row's own `loaded`");
  assert.equal(known[2].update, undefined, "a customised copy behind Thetis's version is not an update");
  assert.equal(known.length, 3, "the count is still what is installed");
  assert.deepEqual(list.stateOf(known[0]).chips.map((c) => c.label), ["Update available"]);
  assert.equal(list.stateOf(known[0]).reason, "Version 0.1.1 is ready; you have 0.1.0.");
});

test("the place's rows learn this person's own settings, so Needs setup is the place's; the plain line is the place's", () => {
  const rows = [{ name: "@thetis/exa", installed: true, description: "Web search. Long." }, { name: "@thetis/terminal", installed: true, description: "A terminal." }, { name: "@thetis/nova", installed: false }];
  const mine = [{ name: "@thetis/exa", config: { broken: true, summary: "apiKey is missing", keys: [{ key: "apiKey", state: "missing", secret: true }] } }, { name: "@thetis/terminal" }];
  const folded = list.withSetup(rows, mine);
  assert.deepEqual(folded[0].config, mine[0].config);
  assert.deepEqual(folded[1].config, { broken: false, summary: "", keys: [] }, "whole settings say so");
  assert.equal(folded[2].config, undefined, "not installed: nothing to fold");
  const rules = { place: reference };
  assert.equal(reference.stateOf(folded[0], { admin: false, user: "sam" }).chips[0].id, "needsSetup");
  assert.equal(list.summaryLine(folded[0], rules), reference.summaryOf(folded[0]));
  assert.equal(list.summaryLine({ description: "Web search. Long." }), "Web search.", "without the place: the first sentence");
});

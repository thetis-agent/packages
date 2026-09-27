// The control panel's one state is the Extensions place's, copied: `ui/state.js` mirrors the rules of
// `@thetis/ui-marketplace`'s `lib/state.js`, the reference. This test gives both the same rows -- one of every
// case the contract names -- and expects the same chips, the same attention, the same sentence, the same
// publisher line and label, and the same Required and admin-only answers, for an admin and for a person. The
// place's module is imported by relative path here only: ui-admin's own code never imports another package.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ours from "../ui/state.js";
import * as reference from "../../ui-marketplace/lib/state.js";
import { EXPECTED_CHIPS, FIXTURES } from "../../ui-marketplace/test/state-fixtures.js";

/** A row in the place's shape, installed unless told otherwise. */
const row = (over) => ({ name: "@thetis/x", label: "x", version: "0.1.0", type: "tool", description: "", audience: null, installed: true, system: true, everyone: false, everyoneBy: null, own: false, local: false, registry: null, source: null, update: null, forkedFrom: null, fork: null, tools: [], skills: 0, pages: 0, service: false, steps: [], config: null, ...over });

const ROWS = {
  shipped: row({ name: "@thetis/terminal", label: "terminal", tools: [{ name: "run" }], everyone: true, everyoneBy: "config" }),
  marked: row({ name: "@thetis/exa", label: "exa", tools: [{ name: "exa_search" }], everyone: true, everyoneBy: "marked" }),
  promoted: row({ name: "@thetis/notion", label: "Notion", tools: [{ name: "notion_search" }], everyone: true, everyoneBy: "promoted" }),
  original: row({ name: "@bitmuse/notion", label: "Notion", installed: false, system: false, local: true, tools: [{ name: "notion_search" }] }),
  own: row({ name: "@bitmuse/moo", label: "moo", system: false, own: true, local: true, tools: [{ name: "moo_eval" }] }),
  sams: row({ name: "@sam/grafana", label: "grafana", system: false, tools: [{ name: "grafana_query" }] }),
  copyBehind: row({ name: "@bitmuse/tool-exec", label: "tool exec", version: "0.3.3-fork.1", system: false, local: true, own: true, forkedFrom: { name: "@thetis/tool-exec", version: "0.3.3" }, fork: { name: "@thetis/tool-exec", version: "0.3.3", shipped: "0.4.1", identical: false, everyone: true }, tools: [{ name: "install" }] }),
  copySame: row({ name: "@bitmuse/canvases", label: "canvases", version: "0.1.1-fork.1", system: false, local: true, forkedFrom: { name: "@thetis/canvases", version: "0.1.1" }, fork: { name: "@thetis/canvases", version: "0.1.1", shipped: "0.1.1", identical: true }, pages: 1 }),
  copyNoFacts: row({ name: "@bitmuse/notion-read", label: "Notion", system: false, local: true, forkedFrom: { name: "@bitmuse/notion", version: "0.1.0" }, tools: [{ name: "notion_search" }] }),
  offer: row({ name: "@tg/nova", label: "nova", installed: false, system: false, registry: "thirteen-games", type: "skill", hasSkills: true }),
  installUpdate: row({ name: "@thetis/compaction", label: "compaction", type: "loader", update: { apply: "install", version: "0.3.0" }, version: "0.2.0" }),
  reloadUpdate: row({ name: "@thetis/skills-hybrid", label: "skills hybrid", type: "loader", update: { apply: "reload", available: "0.2.2", installed: "0.2.1" }, version: "0.2.2" }),
  missingMine: row({ name: "@thetis/vikunja", label: "vikunja", tools: [{ name: "task" }], config: { broken: true, summary: "token is missing", keys: [{ key: "token", state: "missing", secret: true, help: "A Vikunja API token. Make one under Settings." }] } }),
  missingAdmins: row({ name: "@thetis/provider-openrouter", label: "OpenRouter", type: "provider", config: { broken: true, summary: "apiKey is missing", keys: [{ key: "apiKey", state: "missing", missing: ["OPENROUTER_API_KEY"], source: "default" }] } }),
  systemKey: row({ name: "@thetis/embeddings", label: "embeddings", type: "service", service: true, config: { broken: true, summary: "url is missing", keys: [{ key: "url", state: "missing", scope: "system" }] } }),
  brokenBare: row({ name: "@thetis/grafana", label: "grafana", tools: [{ name: "q" }], config: { broken: true, summary: "A setting is missing for sam", keys: [] } }),
  everything: row({ name: "@bitmuse/mix", label: "mix", system: false, local: true, own: true, forkedFrom: { name: "@thetis/mix", version: "0.1.0" }, fork: { name: "@thetis/mix", version: "0.1.0", shipped: "0.2.0" }, everyone: true, everyoneBy: "marked", config: { broken: true, summary: "k", keys: [{ key: "k", state: "missing" }] }, tools: [{ name: "a" }], pages: 2 }),
  gateway: row({ name: "@thetis/gateway-web", label: "web gateway", type: "gateway", pages: 3 }),
  copyOfRequired: row({ name: "@bitmuse/ui-admin", label: "control panel", type: "ui", system: false, local: true, forkedFrom: { name: "@thetis/ui-admin", version: "0.5.2" }, pages: 9 }),
  login: row({ name: "@thetis/gateway-login", label: "sign-in page", type: "service", service: true }),
  operator: row({ name: "@thetis/tool-operator", label: "operator", audience: "admin", tools: [{ name: "restart" }] }),
  storage: row({ name: "@thetis/store-toml", label: "store toml", type: "storage" }),
};

const ALL = Object.values(ROWS);
const FAMILY = [ROWS.promoted, ROWS.original, ROWS.copyNoFacts];

/** Everything a surface shows about a row, from one module. */
function answer(m, r, ctx) {
  const origin = ALL.find((x) => x.name === m.originNameOf(r)) ?? null;
  const label = m.labelOf(r, origin);
  const state = m.stateOf(r, { ...ctx, origin, label });
  return {
    chips: state.chips.map((c) => [c.id, c.label, c.tone, c.tooltip]),
    attention: state.attention,
    reason: state.reason,
    waiting: state.waiting,
    update: state.update?.kind ?? null,
    label,
    publisher: m.publisherLine(r, { user: ctx.user, family: FAMILY }),
    type: m.typeOf(r),
    required: m.isRequired(r),
    adminOnly: m.isAdminOnly(r),
    useOrigin: m.isCopy(r) ? m.useOriginLabel(r, ctx.user) : null,
  };
}

test("the control panel and the Extensions place give the same state for the same rows, for an admin and for a person", () => {
  for (const ctx of [{ admin: true, user: "bitmuse" }, { admin: false, user: "bitmuse" }, { admin: false, user: "sam" }]) {
    for (const [key, r] of Object.entries(ROWS)) assert.deepEqual(answer(ours, r, ctx), answer(reference, r, ctx), `${key} for ${ctx.user}${ctx.admin ? " (admin)" : ""}`);
  }
});

test("the shared words and rules are the same data", () => {
  for (const k of ["CHIPS", "CHIP_ORDER", "MAX_CHIPS", "FOR_EVERYONE_BY", "REQUIRED", "ADMIN_ONLY", "INSIDE", "FILTERS", "PILLS", "SYNONYMS"]) assert.deepEqual(ours[k], reference[k], k);
  assert.deepEqual(ours.KINDS.map((k) => k.id), reference.KINDS.map((k) => k.id));
  const words = (w) => ({ ...w, settingsPath: w.settingsPath("Exa") });
  assert.deepEqual(words(ours.WORDS), words(reference.WORDS));
});

test("the rows say what the contract says they do", () => {
  const say = (r, ctx = { admin: true, user: "bitmuse" }) => answer(ours, r, ctx);
  assert.deepEqual(say(ROWS.shipped).chips, [], "Thetis's own defaults carry no chip");
  assert.equal(say(ROWS.shipped).publisher, "by Thetis · Tools");
  assert.deepEqual(say(ROWS.marked).chips.map((c) => c[1]), ["For everyone"]);
  assert.equal(say(ROWS.promoted, { admin: false, user: "sam" }).publisher, "by bitmuse · Tools", "a shared copy is by the person it came from");
  assert.deepEqual(say(ROWS.copyBehind).chips.map((c) => c[1]), ["Customized"], "a copy behind its official version is not an update");
  assert.equal(say(ROWS.copyBehind).attention, false);
  assert.equal(say(ROWS.copyBehind).label, "Tool Exec");
  assert.equal(say(ROWS.copyBehind).useOrigin, "Use Thetis's version");
  assert.deepEqual(say(ROWS.everything).chips.map((c) => c[1]), ["Needs setup", "Customized"], "at most two, in order");
  assert.equal(say(ROWS.missingAdmins, { admin: false, user: "sam" }).waiting, true, "a person waits for the admin");
  assert.deepEqual(say(ROWS.missingAdmins, { admin: false, user: "sam" }).chips, []);
  assert.match(say(ROWS.missingAdmins).reason, /Set it for everyone in Control panel → Extensions → OpenRouter → Settings\./);
  assert.equal(say(ROWS.offer).publisher, "from thirteen-games · Skills");
  for (const k of ["gateway", "copyOfRequired", "login", "storage"]) assert.equal(say(ROWS[k]).required, true, k);
  for (const k of ["operator", "storage", "login"]) assert.equal(say(ROWS[k]).adminOnly, true, k);
});

test("ui/state.js is the Extensions place's lib/state.js, byte for byte", async () => {
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(new URL("../ui/state.js", import.meta.url), "utf8"), readFileSync(new URL("../../ui-marketplace/lib/state.js", import.meta.url), "utf8"), "packages/ui-admin/ui/state.js has drifted from packages/ui-marketplace/lib/state.js: copy the place's over it");
});

test("the Extensions place's own fixture rows: both give its expected chips, and the same sentence, for bitmuse and for sam", () => {
  for (const [who, { user, admin, rows }] of Object.entries(FIXTURES)) {
    for (const r of rows) {
      const origin = rows.find((x) => x.name === ours.originNameOf(r)) ?? null;
      const mine = ours.stateOf(r, { admin, origin, user });
      const theirs = reference.stateOf(r, { admin, origin, user });
      assert.deepEqual(mine.chips.map((c) => c.label), EXPECTED_CHIPS[who][r.name], `${r.name} for ${who}`);
      assert.deepEqual(mine.chips, theirs.chips, `${r.name} for ${who}`);
      assert.equal(mine.reason, theirs.reason, `${r.name} for ${who}`);
      assert.equal(mine.waiting, theirs.waiting, `${r.name} for ${who}`);
      assert.equal(ours.publisherLine(r, { user, family: rows }), reference.publisherLine(r, { user, family: rows }), `${r.name} for ${who}`);
      assert.equal(ours.labelOf(r, origin), reference.labelOf(r, origin), `${r.name} for ${who}`);
    }
  }
});

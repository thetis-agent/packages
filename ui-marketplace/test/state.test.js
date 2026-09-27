// The one state per extension (lib/state.js) over the fixture rows in state-fixtures.js: the chips and the
// reasons, the publisher line, the families and their headline, the place's sections for an admin and for a
// person who is not one, what nothing removes and what only an admin is offered, the Needs line, and the
// search with its synonyms. Then that ui/state.js is the same file, because the page may import only its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as state from "../lib/state.js";
import { EXPECTED_CHIPS, FIXTURES } from "./state-fixtures.js";

const {
  ADMIN_ONLY, CHIPS, CHIP_ORDER, FILTERS, FOR_EVERYONE_BY, KINDS, REQUIRED, SYNONYMS, WORDS,
  compareVersions, familiesOf, familyOf, headlineOf, isAdminOnly, isRequired, kindsOf, labelOf, matches, needsLine, officialOf,
  originOf, otherVersions, phraseOf, placeSections, publisherLine, publisherOf, setupOf, stateOf, titleCase, typeOf, updateOf, useOriginLabel,
} = state;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const find = (who, name) => FIXTURES[who].rows.find((r) => r.name === name);

/** The state a surface shows for one row: its family's official member as the origin, the reader's role. */
function shown(who, name) {
  const { rows, user, admin } = FIXTURES[who];
  const row = find(who, name);
  const family = familyOf(row, rows);
  const origin = officialOf(row, family);
  return stateOf(row, { admin, user, origin, label: labelOf(row, origin) });
}

test("state: the chips every reader sees on every fixture row, at most two and in the one order", () => {
  for (const who of Object.keys(FIXTURES)) {
    for (const [name, chips] of Object.entries(EXPECTED_CHIPS[who])) {
      const s = shown(who, name);
      assert.deepEqual(s.chips.map((c) => c.label), chips, `${who} on ${name}`);
      assert.ok(s.chips.length <= state.MAX_CHIPS);
      const order = s.chips.map((c) => CHIP_ORDER.indexOf(c.id));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), "Needs setup, Update available, Customized, For everyone");
    }
  }
  // Each chip carries its tooltip and tone, and nothing else is ever a chip.
  assert.deepEqual(Object.values(CHIPS).map((c) => [c.label, c.tone]), [["Needs setup", "err"], ["Update available", "warn"], ["Customized", "dim"], ["For everyone", "accent"]]);
  assert.equal(CHIPS.needsSetup.tooltip, "Something must be set before it works. Open it to set it up.");
  assert.equal(CHIPS.updateAvailable.tooltip, "A newer version is ready. Updating keeps your settings.");
  assert.equal(CHIPS.customized.tooltip, "You are using your own changed copy instead of the official one.");
  assert.equal(CHIPS.forEveryone.tooltip, "An admin gives this to every person.");
  assert.deepEqual(FOR_EVERYONE_BY, ["marked", "promoted", null], "the installation's own list is Thetis's built-ins, and carries no chip");
});

test("state: an unset required key is the person's to set, said with the key's help and never the server's .env", () => {
  for (const who of ["bitmuse", "sam"]) {
    const s = shown(who, "@thetis/exa");
    assert.equal(s.attention, true);
    assert.equal(s.waiting, false);
    assert.equal(s.reason, "Add the Exa API key (apiKey) in Settings to start using it.");
    assert.doesNotMatch(s.reason, /\.env|environment/);
  }
});

test("state: a ${VAR} default missing on the server is Needs setup for an admin, with where to fix it, and a grey line for anyone else", () => {
  const admin = shown("bitmuse", "@thetis/skills-hybrid");
  assert.deepEqual(admin.chips.map((c) => c.id), ["needsSetup"]);
  assert.equal(admin.attention, true);
  assert.equal(admin.reason, "OPENROUTER_API_KEY is not in the server's environment, so embeddings has no value. Set it for everyone in Control panel → Extensions → Skill Loader → Settings.");
  const person = shown("sam", "@thetis/skills-hybrid");
  assert.deepEqual(person.chips, [], "a person cannot fix it, so it is not their chip");
  assert.equal(person.attention, false);
  assert.equal(person.waiting, true);
  assert.equal(person.reason, "Waiting for your admin to finish setting this up.");
  // A key declared for admins only is the admin's too; a ${VAR} the person wrote themselves is theirs.
  const system = { name: "@thetis/x", installed: true, config: { keys: [{ key: "secure", state: "missing", scope: "system", required: true }], broken: true } };
  assert.equal(setupOf(system).waiting, true);
  assert.equal(setupOf(system, { admin: true, label: "X" }).reason, "secure is not set. Set it for everyone in Control panel → Extensions → X → Settings.");
  const mine = { name: "@thetis/x", installed: true, config: { keys: [{ key: "token", state: "missing", missing: ["MY_TOKEN"], source: "user" }], broken: true } };
  assert.equal(setupOf(mine).chip, true);
  // A short report that says broken and names nothing is still the person's, in the kernel's words.
  assert.equal(setupOf({ installed: true, config: { broken: true, summary: "apiKey is required and not set" } }).reason, "apiKey is required and not set. Open Settings to fix it.");
  // Not installed: no report, no setup state -- the Needs line says it instead.
  assert.equal(setupOf({ ...find("sam", "@thetis/exa"), installed: false }).chip, false);
});

test("state: a copy of an older official version is Update available and Customized, with the versions in its reason", () => {
  const s = shown("bitmuse", "@bitmuse/tool-exec");
  assert.deepEqual(s.update, { kind: "origin", to: "0.4.1", from: "0.3.3", reason: "Thetis's version 0.4.1 is newer than the 0.3.3 your copy was made from." });
  assert.equal(s.reason, s.update.reason);
  // A copy without the kernel's fork facts reads the official member's version instead.
  const loose = { name: "@a/x", installed: true, forkedFrom: { name: "@thetis/x", version: "1.0.0" } };
  assert.equal(updateOf(loose, { origin: { name: "@thetis/x", version: "1.1.0" } }).to, "1.1.0");
  assert.equal(updateOf(loose, { origin: { name: "@thetis/x", version: "1.0.0" } }), null, "the same version is nothing newer");
  // A copy of a person's extension goes back to their version, not Thetis's.
  assert.equal(useOriginLabel(find("bitmuse", "@bitmuse/notion-read"), "bitmuse"), "Use your original");
  assert.equal(useOriginLabel(find("bitmuse", "@bitmuse/notion-read"), "sam"), "Use bitmuse's version");
  assert.equal(useOriginLabel(find("bitmuse", "@bitmuse/tool-exec"), "bitmuse"), "Use Thetis's version");
  // The reload kind and the install kind are one state for the person.
  assert.equal(shown("sam", "@thetis/gateway-web").reason, "Version 0.16.1 is ready; you have 0.16.0. Updating keeps your settings.");
});

test("publisher: by Thetis, by you, by <person>, from <registry>, then the first two kinds", () => {
  const line = (who, name) => publisherLine(find(who, name), { user: FIXTURES[who].user, family: familyOf(find(who, name), FIXTURES[who].rows).members });
  assert.equal(line("bitmuse", "@thetis/notion"), "by you · Tools", "a promoted copy of your own original");
  assert.equal(line("sam", "@thetis/notion"), "by bitmuse · Tools", "a promoted copy made from @bitmuse/notion");
  assert.equal(line("sam", "@thetis/exa"), "by Thetis · Tools");
  assert.equal(line("bitmuse", "@bitmuse/tool-exec"), "by you · Tools");
  assert.equal(line("sam", "@tg/lore"), "from thirteen-games · Tools");
  assert.equal(line("sam", "@bitmuse/notion"), "from thetis · Tools", "an offer is from its registry");
  assert.equal(line("bitmuse", "@bitmuse/notion"), "by you · Tools", "unless it is yours");
  assert.equal(line("sam", "@thetis/gateway-web"), "by Thetis · Page · Background");
  assert.equal(publisherOf({ name: "@thetis/lonely", everyoneBy: "promoted" }).text, "by Thetis", "a promoted copy whose original is not here");
  // Kinds: from what the manifest brings, never from a type that brings nothing.
  assert.deepEqual(kindsOf({ type: "tool", tools: [] }), []);
  assert.deepEqual(kindsOf({ type: "skill" }), ["Skills"]);
  assert.deepEqual(kindsOf({ type: "provider" }), ["Models", "Background"].slice(0, 1));
  assert.equal(typeOf({ type: "tool", tools: [{ name: "a" }], pages: 1, service: true }), "Tools · Page");
  assert.deepEqual(KINDS.map((k) => k.id), ["Tools", "Skills", "Page", "Models", "Background"]);
  assert.deepEqual(FILTERS.map((f) => f.label), ["All", "Tools", "Skills", "Pages", "Models"]);
  assert.equal(WORDS.legend, "Tools let your assistant do things. Skills teach it how. Pages add a screen. Models add a model provider.");
});

test("families: a copy joins its origin, a promoted copy joins the original, and the headline is the person's own", () => {
  const { rows } = FIXTURES.bitmuse;
  const byName = new Map(rows.map((r) => [r.name, r]));
  assert.equal(originOf(byName.get("@thetis/notion"), byName), "@bitmuse/notion");
  assert.equal(originOf(byName.get("@bitmuse/notion-read"), byName), "@bitmuse/notion");
  assert.equal(originOf(byName.get("@bitmuse/tool-exec"), byName), "@thetis/tool-exec");
  const families = familiesOf(rows);
  const notion = families.find((f) => f.origin === "@bitmuse/notion");
  assert.equal(notion.key, "notion");
  assert.deepEqual(notion.members.map((m) => m.name).sort(), ["@bitmuse/notion", "@bitmuse/notion-read", "@thetis/notion"]);
  assert.equal(notion.headline.name, "@thetis/notion", "the one they have installed");
  assert.equal(families.find((f) => f.origin === "@thetis/tool-exec").headline.name, "@bitmuse/tool-exec", "a copy displaces what it was made from");
  // Nothing installed: the one everyone gets, then Thetis's, then the registry's, then the folder.
  assert.equal(headlineOf([{ name: "@a/x", folder: {} }, { name: "@a/x2", available: true, registry: "r" }]).name, "@a/x2");
  assert.equal(headlineOf([{ name: "@a/x", available: true }, { name: "@thetis/x", everyone: true }]).name, "@thetis/x");
  // Two packages that share an unscoped name and nothing else stay apart.
  const apart = familiesOf([{ name: "@alice/grafana" }, { name: "@thetis/grafana", system: true }]);
  assert.equal(apart.length, 2);
  // A copy takes its official member's label.
  assert.equal(labelOf(byName.get("@bitmuse/tool-exec"), byName.get("@thetis/tool-exec")), "Extensions and Helper Chats");
  assert.equal(labelOf(byName.get("@bitmuse/notion-read"), byName.get("@bitmuse/notion")), "Notion");
  assert.equal(titleCase("web gateway"), "Web Gateway");
  assert.equal(titleCase("Exa web search"), "Exa Web Search");
  assert.equal(titleCase("extensions and helper chats"), "Extensions and Helper Chats");
});

test("other versions: one line each, saying whose it is and whether it is here, with Install where it can be", () => {
  const { rows, user } = FIXTURES.bitmuse;
  const fam = familyOf(find("bitmuse", "@thetis/notion"), rows);
  const lines = otherVersions(fam, find("bitmuse", "@thetis/notion"), { user, admin: true });
  assert.deepEqual(lines.map((l) => [l.text, l.install]).sort(), [
    ["@bitmuse/notion — your original · published to thetis", true],
    ["notion-read — your copy in your folder · not installed", true],
  ].sort());
  // sam reads the same family from the other side.
  const samFam = familyOf(find("sam", "@thetis/notion"), FIXTURES.sam.rows);
  assert.deepEqual(otherVersions(samFam, find("sam", "@thetis/notion"), { user: "sam" }).map((l) => l.text), ["@bitmuse/notion — from thetis · published to thetis"]);
  // Once the original is installed, it reads as the original.
  const original = { ...find("bitmuse", "@bitmuse/notion"), folder: null, installed: true };
  const again = otherVersions({ members: [find("bitmuse", "@thetis/notion"), original] }, find("bitmuse", "@thetis/notion"), { user });
  assert.equal(again[0].text, "@bitmuse/notion — your original · installed");
});

test("sections: an admin's place and a person's place from the same installation", () => {
  const names = (list) => list.map((e) => e.row.name);
  const b = placeSections(FIXTURES.bitmuse.rows, FIXTURES.bitmuse);
  assert.deepEqual(names(b.attention), ["@bitmuse/tool-exec", "@thetis/exa", "@thetis/skills-hybrid", "@thetis/gateway-web"]);
  assert.deepEqual(names(b.added), ["@bitmuse/tool-exec", "@thetis/exa"]);
  assert.deepEqual(names(b.discover), ["@thetis/tool-operator", "@tg/lore"], "never a version of what they have; the admin's own tool is offered to an admin");
  assert.deepEqual(names(b.builtin), ["@thetis/notion", "@thetis/skills-hybrid"]);
  assert.deepEqual(names(b.folder), ["@bitmuse/notion", "@bitmuse/notion-read"]);
  assert.deepEqual(names(b.thetis), ["@thetis/gateway-web"]);
  assert.equal(b.installed, 5, "installed for this person: the number the Control panel says too");
  assert.equal(b.added[0].label, "Extensions and Helper Chats");
  assert.equal(b.added[0].publisher, "by you · Tools");

  const s = placeSections(FIXTURES.sam.rows, FIXTURES.sam);
  assert.deepEqual(names(s.attention), ["@thetis/exa", "@thetis/gateway-web"], "the server's missing key is not sam's attention");
  assert.deepEqual(names(s.added), ["@thetis/exa"]);
  assert.deepEqual(names(s.discover), ["@tg/lore"], "no restart tool for a person, and no second Notion");
  assert.deepEqual(names(s.builtin), ["@thetis/notion", "@thetis/skills-hybrid", "@thetis/tool-exec"]);
  assert.deepEqual(s.builtin[1].state.waiting, true);
  assert.deepEqual(names(s.folder), []);
  // The search narrows every section, and finds a family by any of its versions.
  assert.deepEqual(names(placeSections(FIXTURES.sam.rows, { ...FIXTURES.sam, q: "google" }).added), ["@thetis/exa"], "google finds web search");
  assert.deepEqual(names(placeSections(FIXTURES.bitmuse.rows, { ...FIXTURES.bitmuse, q: "reading only" }).builtin), ["@thetis/notion"], "found through notion-read, shown as the family's card");
});

test("required and admin-only: the rules as data, and what they decide", () => {
  assert.deepEqual(REQUIRED.types, ["gateway", "provider", "storage", "host"]);
  assert.deepEqual(REQUIRED.names, ["@thetis/harness-core", "@thetis/marketplace", "@thetis/ui-marketplace", "@thetis/ui-admin", "@thetis/gateway-login", "@thetis/gateway-web"]);
  assert.equal(isRequired(find("sam", "@thetis/gateway-web")), true);
  assert.equal(isRequired({ name: "@thetis/ui-admin", type: "ui" }), true);
  assert.equal(isRequired({ name: "@bitmuse/ui-admin", type: "ui", forkedFrom: { name: "@thetis/ui-admin", version: "1" } }), true, "a copy of a required extension is required");
  assert.equal(isRequired(find("sam", "@thetis/exa")), false);
  assert.deepEqual([ADMIN_ONLY.audience, ADMIN_ONLY.types, ADMIN_ONLY.names], ["admin", ["host", "storage"], ["@thetis/gateway-login"]]);
  assert.equal(isAdminOnly(find("sam", "@thetis/tool-operator")), true);
  assert.equal(isAdminOnly({ name: "@thetis/store-toml", type: "storage" }), true);
  assert.equal(isAdminOnly({ name: "@thetis/gateway-login", type: "gateway" }), true);
  assert.equal(isAdminOnly(find("sam", "@thetis/exa")), false);
  assert.equal(WORDS.required, "Required by Thetis");
});

test("needs: the Needs line from the manifest, in the key's own words and never the server's", () => {
  assert.equal(needsLine(find("sam", "@thetis/exa")), "Needs: the Exa API key (apiKey)");
  assert.equal(needsLine(find("sam", "@bitmuse/notion")), "Needs: an internal connection or personal access token from https://www.notion.so/my-integrations (token)");
  assert.equal(needsLine({ needs: [{ key: "url", help: "Base URL of the Grafana instance, e.g. https://x.grafana.net." }, { key: "token", secret: true, help: "" }] }), "Needs: base URL of the Grafana instance (url) and a secret value (token)");
  assert.equal(needsLine({ needs: [{ key: "k", help: "Put it in .env as K." }] }), "Needs: a value (k)", "an .env sentence is the admin's, so it is not said");
  assert.equal(needsLine({ needs: [] }), null);
  assert.equal(phraseOf("The OpenRouter API key, sent as the bearer token of every request; put it in .env."), "the OpenRouter API key, sent as the bearer token of every request");
});

test("search: name, label, description, tool names and synonyms", () => {
  const exa = find("sam", "@thetis/exa");
  for (const q of ["exa", "web", "internet", "google", "search", "EXA_CONTENTS", "deep research"]) assert.equal(matches(exa, q), true, q);
  assert.equal(matches(exa, "notion"), false);
  assert.equal(matches(exa, "web", "Skills"), false, "the kind filter narrows too");
  assert.deepEqual(SYNONYMS, [["web", "internet", "google", "search"]]);
  assert.equal(matches({ name: "@a/x", skillList: [{ name: "orleans/grains", description: "Grains." }] }, "grains"), true, "a skill's name");
});

test("versions compare as numbers, a pre-release before its release", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.3.3-fork.1", "0.3.3"), -1);
  assert.equal(compareVersions("0.4.1", "0.4.1"), 0);
});

test("the browser's state.js is the same file as lib/state.js, because a page may import only its own", () => {
  assert.equal(readFileSync(join(ROOT, "ui", "state.js"), "utf8"), readFileSync(join(ROOT, "lib", "state.js"), "utf8"), "packages/ui-marketplace/ui/state.js has drifted from lib/state.js: copy lib/state.js over it");
});

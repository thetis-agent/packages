// The one state per extension (lib/state.js) over the fixture rows in state-fixtures.js: the chips, the reasons
// and the to-do rows, the publisher line and the one label, the families and their other versions, the admin's
// table for everyone, the place's sections for an admin and for a person who is not one, what nothing removes
// and what only an admin is offered, the Needs line and the setup sentence, and the search with its synonyms.
// Then that ui/state.js is the same file, because the page may import only its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as state from "../lib/state.js";
import { EXPECTED_CHIPS, FIXTURES } from "./state-fixtures.js";

const {
  ADMIN_ONLY, CHIPS, CHIP_ORDER, FILTERS, FOR_EVERYONE_BY, KINDS, PILLS, REQUIRED, SYNONYMS, WORDS,
  behindOf, compareVersions, dateWords, everyoneActions, familiesOf, familyOf, giverOf, headlineOf, humanKey, isAdminOnly, isRequired, isVariant, kindsOf, labelOf, linkOf,
  matches, needsLine, nounOf, officialOf, originOf, otherVersions, placeSections, publisherLine, publisherOf, publisherShort, runsInsideThetis, setupOf, setupSentence, stateOf,
  summaryOf, titleCase, typeOf, updateOf, useOriginLabel, bringsOf, titleOf, switchTitle, matchRank,
} = state;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const find = (who, name) => FIXTURES[who].rows.find((r) => r.name === name);

/** The state a surface shows for one row: its family's official member as the origin, the reader's role. */
function shown(who, name) {
  const { rows, user, admin } = FIXTURES[who];
  const row = find(who, name);
  const family = familyOf(row, rows);
  const origin = officialOf(row, family);
  return stateOf(row, { admin, user, origin, label: labelOf(row, origin), giver: giverOf(row, { user, family: family.members }) });
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
  // For everyone on something the person does not have is said to an admin only.
  const marked = { name: "@thetis/w", everyone: true, everyoneBy: "marked", installed: false };
  assert.deepEqual(stateOf(marked, { user: "sam" }).chips, []);
  assert.deepEqual(stateOf(marked, { admin: true, user: "bitmuse" }).chips.map((c) => c.label), ["For everyone"]);
});

test("state: an unset required key is the person's to set, said as '<Label> needs <noun> before it works', with its link and never the key's name", () => {
  for (const who of ["bitmuse", "sam"]) {
    const s = shown(who, "@thetis/exa");
    assert.equal(s.attention, true);
    assert.equal(s.waiting, false);
    assert.equal(s.reason, "Exa Web Search needs an Exa API key before it works. Get one at dashboard.exa.ai.");
    assert.deepEqual(s.setup.link, { text: "dashboard.exa.ai", href: "https://dashboard.exa.ai" });
    assert.doesNotMatch(s.reason, /\.env|environment|\(apiKey\)/);
    assert.deepEqual(s.todo, { kind: "setup", tone: "err", action: "Set up", reason: s.reason, link: s.setup.link }, "the to-do row draws the link as a link too");
  }
});

test("state: something given to everyone that needs a personal setting is a neutral row: who gave it, and that it is optional", () => {
  const b = shown("bitmuse", "@thetis/notion");
  assert.equal(b.todo.kind, "optional");
  assert.equal(b.todo.tone, "dim");
  assert.equal(b.reason, "You gave everyone Notion. Set it up if you use it, or remove it for yourself.");
  assert.equal(b.setup.reason, "Notion needs an internal connection or personal access token before it works. Get one at https://www.notion.so/my-integrations.");
  const s = shown("sam", "@thetis/notion");
  assert.equal(s.reason, "bitmuse gave everyone Notion. Set it up if you use it, or remove it for yourself.");
  // An admin who installed it for one person gave it to them.
  const given = { name: "@thetis/x", label: "x", installed: true, givenBy: "bitmuse", config: { keys: [{ key: "token", state: "missing", secret: true, help: "" }], broken: true } };
  assert.equal(stateOf(given, { user: "sam", giver: "bitmuse" }).reason, "bitmuse gave you X. Set it up if you use it, or remove it for yourself.");
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
  assert.equal(person.todo, null);
  assert.equal(person.reason, "Waiting for your admin to finish setting this up.");
  // A key declared for admins only is the admin's too; a ${VAR} the person wrote themselves is theirs.
  const system = { name: "@thetis/x", installed: true, config: { keys: [{ key: "secure", state: "missing", scope: "system", required: true }], broken: true } };
  assert.equal(setupOf(system).waiting, true);
  assert.equal(setupOf(system, { admin: true, label: "X" }).reason, "Secure is not set. Set it for everyone in Control panel → Extensions → X → Settings.");
  const mine = { name: "@thetis/x", installed: true, config: { keys: [{ key: "token", state: "missing", missing: ["MY_TOKEN"], source: "user" }], broken: true } };
  assert.equal(setupOf(mine).chip, true);
  // A short report that says broken and names nothing is still the person's, in the kernel's words.
  assert.equal(setupOf({ installed: true, config: { broken: true, summary: "apiKey is required and not set" } }).reason, "apiKey is required and not set. Open Settings to fix it.");
  // Not installed: no report, no setup state -- the Needs line says it instead.
  assert.equal(setupOf({ ...find("sam", "@thetis/exa"), installed: false }).chip, false);
});

test("state: a copy the official version moved past is Customized and a Review, never an update", () => {
  const s = shown("bitmuse", "@bitmuse/tool-exec");
  assert.equal(s.update, null);
  assert.deepEqual(s.behind, { kind: "origin", to: "0.4.1", from: "0.3.3", reason: "Thetis's 0.4.1 is newer than your copy (made from 0.3.3)." });
  assert.deepEqual(s.todo, { kind: "review", tone: "dim", action: "Review", reason: s.behind.reason });
  assert.equal(s.attention, false, "not counted with the updates");
  // A copy without the kernel's fork facts reads the official member's version instead.
  const loose = { name: "@a/x", installed: true, forkedFrom: { name: "@thetis/x", version: "1.0.0" } };
  assert.equal(behindOf(loose, { origin: { name: "@thetis/x", version: "1.1.0" } }).to, "1.1.0");
  assert.equal(behindOf(loose, { origin: { name: "@thetis/x", version: "1.0.0" } }), null, "the same version is nothing newer");
  // A copy of a person's extension goes back to their version, not Thetis's.
  assert.equal(useOriginLabel(find("bitmuse", "@bitmuse/notion-read"), "bitmuse"), "Use your original");
  assert.equal(useOriginLabel(find("bitmuse", "@bitmuse/notion-read"), "sam"), "Use bitmuse's version");
  assert.equal(useOriginLabel(find("bitmuse", "@bitmuse/tool-exec"), "bitmuse"), "Use Thetis's version");
});

test("state: an update is only a real newer version of what the person runs, and says a new name when it has one", () => {
  assert.equal(shown("sam", "@thetis/gateway-web").reason, "Version 0.16.1 is ready; you have 0.16.0.");
  assert.equal(shown("sam", "@thetis/gateway-web").todo.action, "Update");
  assert.equal(updateOf({ installed: true, version: "0.3.3-fork.1", update: { apply: "reload", installed: "0.3.3-fork.1", available: "0.3.3-fork.1" } }), null, "never 'X is ready; you have X'");
  assert.equal(updateOf({ installed: true, version: "1.0.0", update: { apply: "unfork", version: "1.1.0" } }), null);
  assert.equal(updateOf({ installed: true, version: "1.0.0", update: { apply: "install", version: "1.0.0", from: "aaaaaaa", to: "bbbbbbb" } }).reason, "A newer build of 1.0.0 is ready.");
  const renamed = { installed: true, version: "0.1.0", label: "Orleans docs", wasLabel: "skills orleans", update: { apply: "install", version: "0.1.1", from: "a", to: "b" } };
  assert.equal(updateOf(renamed).reason, "Version 0.1.1 is ready; you have 0.1.0. Now called Orleans Docs.");
  // Update and setup at once: one row, the update, which says the rest.
  const both = { name: "@thetis/x", label: "x", installed: true, version: "1.0.0", update: { apply: "install", version: "1.1.0", from: "a", to: "b" }, config: { keys: [{ key: "k", state: "missing" }], broken: true } };
  assert.equal(stateOf(both).todo.reason, "Version 1.1.0 is ready; you have 1.0.0, and it still needs setting up.");
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
  assert.equal(publisherShort(find("sam", "@thetis/exa")), "Thetis · Tools", "a confirm's from row, never 'by by'");
  assert.equal(publisherOf({ name: "@thetis/lonely", everyoneBy: "promoted" }).text, "by Thetis", "a promoted copy whose original is not here");
  assert.equal(publisherOf({ name: "@thetis/n", everyoneBy: "promoted", sharedBy: { owner: "rae" } }).text, "by rae", "the journal's word, when the original is not here");
  // Kinds: from what the manifest brings, never from a type that brings nothing.
  assert.deepEqual(kindsOf({ type: "tool", tools: [] }), []);
  assert.deepEqual(kindsOf({ type: "skill" }), ["Skills"]);
  assert.equal(typeOf({ type: "tool", tools: [{ name: "a" }], pages: 1, service: true }), "Tools · Page");
  assert.deepEqual(KINDS.map((k) => k.id), ["Tools", "Skills", "Page", "Models", "Background"]);
  assert.deepEqual(FILTERS.map((f) => f.label), ["All", "Tools", "Skills", "Pages", "Models", "Background"]);
  assert.deepEqual(PILLS.map((p) => p.label), ["All", "Installed by you", "Given to you", "Customized"]);
  assert.deepEqual(PILLS.map((p) => p.id), ["", "mine", "given", "customized"]);
  assert.equal(WORDS.legend, "Tools let your assistant do things. Skills teach it how. Pages add a screen. Models add a model provider. Background parts work without a screen or tools.");
});

test("labels: one name per extension, Title Case; a variant keeps its own, a copy without one reads as its origin", () => {
  const { rows } = FIXTURES.bitmuse;
  const byName = new Map(rows.map((r) => [r.name, r]));
  assert.equal(labelOf(byName.get("@bitmuse/tool-exec"), byName.get("@thetis/tool-exec")), "Extensions and Helper Chats");
  assert.equal(labelOf(byName.get("@bitmuse/notion-read"), byName.get("@bitmuse/notion")), "Notion (Read Only)");
  assert.equal(isVariant(byName.get("@bitmuse/notion-read"), byName.get("@bitmuse/notion")), true);
  assert.equal(labelOf({ name: "@a/x-copy", label: "x copy", labelGiven: false, forkedFrom: { name: "@a/x" } }, { name: "@a/x", label: "Ex" }), "Ex", "a label made from the name is not the copy's own");
  assert.equal(titleCase("web gateway"), "Web Gateway");
  assert.equal(titleCase("Exa web search"), "Exa Web Search");
  assert.equal(titleCase("extensions and helper chats"), "Extensions and Helper Chats");
  assert.equal(titleCase("skill loader (all)"), "Skill Loader (All)");
  // One line under a card: the manifest's own summary, a part of Thetis in plain words, else the description's first sentence.
  assert.equal(summaryOf({ name: "@thetis/notion", summary: "Lets your assistant read and write your Notion pages.", description: "The Notion API as eleven tools." }), "Lets your assistant read and write your Notion pages.");
  assert.equal(summaryOf({ name: "@thetis/gateway-web", component: true, summary: "Its own words.", description: "x" }), "Its own words.", "the manifest's words first, for a part too");
  assert.equal(summaryOf({ name: "@thetis/gateway-web", component: true, description: "Your browser interface: long." }), "The web page you are using now.");
  assert.equal(summaryOf({ name: "@thetis/x", description: "Does one thing. Then more." }), "Does one thing.");
  // What it brings, from the same kinds as the type: the two never disagree.
  assert.equal(bringsOf({ tools: [{ name: "a" }, { name: "b" }], skills: 12, hasSkills: true }), "2 tools · 12 skills");
  assert.equal(typeOf({ tools: [{ name: "a" }, { name: "b" }], skills: 12, hasSkills: true }), "Tools · Skills");
  assert.equal(bringsOf({ tools: [{ name: "a" }], hasSkills: true }), "1 tool · skills");
  assert.equal(bringsOf({ type: "ui", pages: 1 }), "1 page");
  assert.equal(bringsOf({ type: "provider" }), "Models");
  assert.equal(bringsOf({ type: "tool" }), "Runs in the background");
  // The original of a shared copy is never titled like the shared copy.
  const fam = familyOf(byName.get("@bitmuse/notion"), rows).members;
  assert.equal(titleOf(byName.get("@bitmuse/notion"), { family: fam, user: "bitmuse" }), "Notion — your original");
  assert.equal(titleOf(byName.get("@bitmuse/notion"), { family: fam, user: "sam" }), "Notion — bitmuse's original");
  assert.equal(titleOf(byName.get("@thetis/notion"), { family: fam, user: "bitmuse" }), "Notion");
  assert.equal(titleOf(byName.get("@bitmuse/notion-read"), { family: fam, user: "bitmuse", origin: byName.get("@bitmuse/notion") }), "Notion (Read Only)");
  assert.equal(dateWords("2026-09-27T10:28:31.237Z"), "27 September 2026");
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
});

test("other versions: ✓ the one you use, ○ the rest with how each stands to you, and Use instead where it can be", () => {
  const { rows, user } = FIXTURES.bitmuse;
  const fam = familyOf(find("bitmuse", "@thetis/notion"), rows);
  const lines = otherVersions(fam, find("bitmuse", "@thetis/notion"), { user, admin: true });
  assert.deepEqual(lines.map((l) => [l.text, l.action]), [
    ["✓ Notion — you use this (shared with everyone)", null],
    ["○ Notion — your original, in your folder", "use"],
    ["○ Notion (Read Only) — a variant in your folder", "use"],
  ], "the one in use first, even on its own page; no registry jargon");
  // From the copy's page, the one in use is ticked, and first.
  const fromCopy = otherVersions(fam, find("bitmuse", "@bitmuse/notion-read"), { user, admin: true });
  assert.equal(fromCopy[0].text, "✓ Notion — you use this (shared with everyone)");
  assert.equal(fromCopy[0].action, null);
  assert.ok(!fromCopy.some((l) => l.row.name === "@bitmuse/notion-read"), "the page's own row is not listed unless it is the one in use");
  // sam reads the same family from the other side, and is never offered bitmuse's original.
  const samFam = familyOf(find("sam", "@thetis/notion"), FIXTURES.sam.rows);
  assert.deepEqual(otherVersions(samFam, find("sam", "@thetis/notion"), { user: "sam" }).map((l) => [l.text, l.action]), [
    ["✓ Notion — you use this (shared with everyone)", null],
    ["○ Notion — bitmuse's original (same tools)", null],
  ]);
  // The confirm that switches says which one.
  assert.equal(switchTitle("Notion", "your original, in your folder"), "Switch to your original Notion?");
  assert.equal(switchTitle("Notion (Read Only)", "a variant in your folder"), "Switch to Notion (Read Only)?");
  // The official version of the copy in use goes back through "Use Thetis's version", not a second install.
  const toolExec = familyOf(find("bitmuse", "@bitmuse/tool-exec"), rows);
  assert.equal(otherVersions(toolExec, find("bitmuse", "@bitmuse/tool-exec"), { user, admin: true })[0].action, null);
});

test("for everyone: the admin's table, the same on both surfaces", () => {
  const { rows, user } = FIXTURES.bitmuse;
  const fam = (name) => familyOf(find("bitmuse", name), rows).members;
  const act = (name, extra = {}) => everyoneActions(find("bitmuse", name), { family: fam(name), user, ...extra });
  // The shared copy: who shared it, when, and that people get this one; Remove for everyone names who loses it.
  const shared = everyoneActions({ ...find("bitmuse", "@thetis/notion"), sharedBy: { from: "@bitmuse/notion", owner: "bitmuse", at: "2026-09-27T10:28:31Z" } }, { family: fam("@thetis/notion"), user, holders: ["bitmuse", "sam"] });
  assert.deepEqual(shared.lines, ["Shared with everyone from Notion by you on 27 September 2026. Your people get this one."]);
  assert.deepEqual(shared.acts, ["removeEveryone"]);
  assert.equal(shared.hints.removeEveryone, "Sharing can't be stopped yet; Remove for everyone takes it from the people who have it now.", "said beside the one act there is");
  // Its original: already shared, and nothing else.
  const original = act("@bitmuse/notion");
  assert.deepEqual([original.lines, original.acts, original.open], [["Already shared with everyone as Notion."], [], "@thetis/notion"]);
  // A variant copy: never "Already shared"; a copy of Thetis's older one says why it is not shared; only mine: no Remove.
  assert.deepEqual(act("@bitmuse/notion-read").lines, []);
  const behind = act("@bitmuse/tool-exec", { holders: ["bitmuse"], origin: find("bitmuse", "@thetis/tool-exec") });
  assert.deepEqual(behind.lines, ["You can share your copy once it is based on Thetis's 0.4.1.", "Only you have this. Use Remove for me."]);
  assert.equal(WORDS.privateCopy("sam", "Thetis's"), "This is your own copy. To give sam this extension, use Thetis's version:");
  assert.equal(WORDS.removeForNote, "Their settings are kept. It stops for them from their next message. Everyone else keeps it.");
  assert.deepEqual(behind.acts, []);
  // By Thetis, not for everyone: Turn on; nobody else has it: no Remove.
  assert.deepEqual(act("@thetis/exa", { holders: [] }).acts, ["turnOn"]);
  // Marked: Turn off with its hint, and Remove naming the people.
  const marked = everyoneActions({ name: "@thetis/w", label: "workflows", installed: true, system: true, everyone: true, everyoneBy: "marked" }, { user, holders: ["bitmuse", "sam"] });
  assert.deepEqual(marked.acts, ["turnOff", "removeEveryone"]);
  assert.equal(marked.hints.turnOff, "New people stop getting it; people who have it keep it.");
  // The configuration's: said so; admin-only: no Turn on; inside Thetis: nothing at all.
  assert.deepEqual(act("@thetis/skills-hybrid", { holders: ["bitmuse"] }).lines, ["Everyone gets it (set in Server settings).", "Only you have this. Use Remove for me."]);
  assert.deepEqual(act("@thetis/tool-operator", { holders: [] }), { lines: ["Only admins can have this."], acts: [], hints: {}, open: null, shared: null });
  assert.deepEqual(everyoneActions({ name: "@thetis/gateway-login", type: "gateway", system: true }, { user }).lines, ["Runs inside Thetis itself."]);
  assert.deepEqual(everyoneActions({ name: "@thetis/gateway-web", type: "gateway", installed: true, system: true, everyone: true, everyoneBy: "config" }, { user }).acts, [], "Required: never removed");
});

test("sections: an admin's place and a person's place from the same installation", () => {
  const names = (list) => list.map((e) => e.row.name);
  const b = placeSections(FIXTURES.bitmuse.rows, FIXTURES.bitmuse);
  assert.deepEqual(b.attention.map((e) => [e.row.name, e.todo.kind]), [["@thetis/gateway-web", "update"], ["@thetis/exa", "setup"], ["@thetis/skills-hybrid", "setup"], ["@thetis/notion", "optional"], ["@bitmuse/tool-exec", "review"]], "a fixed order: updates, setting up, reviews, each by label");
  assert.deepEqual(b.updates, ["@thetis/gateway-web"], "Update N is exactly the Update rows");
  assert.deepEqual(names(b.installed), ["@thetis/notion", "@bitmuse/tool-exec", "@thetis/exa", "@thetis/skills-hybrid"]);
  assert.deepEqual(b.installed.map((e) => e.pills), [["given"], ["mine", "customized"], ["mine"], ["given"]]);
  assert.deepEqual(names(b.discover), ["@thetis/tool-operator", "@tg/lore"], "never a version of what they have; the admin's own tool is offered to an admin");
  assert.deepEqual(names(b.drafts), [], "the folder copies of Notion are in its card's Other versions");
  assert.deepEqual(names(b.thetis), ["@thetis/gateway-web"]);
  assert.deepEqual(b.counts, { installed: 4, mine: 2, given: 2, customized: 1, thetis: 1, updates: 1, attention: 5 });
  assert.deepEqual(b.found, { installed: 4, mine: 2, given: 2, customized: 1 });
  assert.equal(b.installed[1].label, "Extensions and Helper Chats");
  assert.equal(b.installed[1].publisher, "by you · Tools");
  assert.deepEqual(names(placeSections(FIXTURES.bitmuse.rows, { ...FIXTURES.bitmuse, pill: "customized" }).installed), ["@bitmuse/tool-exec"]);

  const s = placeSections(FIXTURES.sam.rows, FIXTURES.sam);
  assert.deepEqual(names(s.attention), ["@thetis/gateway-web", "@thetis/exa", "@thetis/notion"], "the server's missing key is not sam's attention");
  assert.deepEqual(names(s.installed), ["@thetis/notion", "@thetis/exa", "@thetis/skills-hybrid", "@thetis/tool-exec"]);
  assert.deepEqual(names(s.discover), ["@tg/lore"], "no restart tool for a person, and no second Notion");
  assert.equal(s.installed[2].state.waiting, true);
  assert.deepEqual(names(s.drafts), []);
  // The search narrows every section, and finds a family by any of its versions.
  assert.deepEqual(names(placeSections(FIXTURES.sam.rows, { ...FIXTURES.sam, q: "google" }).installed), ["@thetis/exa"], "google finds web search");
  assert.deepEqual(names(placeSections(FIXTURES.bitmuse.rows, { ...FIXTURES.bitmuse, q: "reading only" }).installed), ["@thetis/notion"], "found through notion-read, shown as the family's card");
  // The pills count what the search leaves, and a pill that hides a result says which.
  const given = placeSections(FIXTURES.bitmuse.rows, { ...FIXTURES.bitmuse, q: "exa", pill: "given" });
  assert.deepEqual(given.found, { installed: 1, mine: 1, given: 0, customized: 0 });
  assert.deepEqual(names(given.installed), []);
  assert.deepEqual(given.hidden, ["Exa Web Search"]);
  assert.equal(WORDS.hiddenByPill(given.hidden, "Given to you"), "Exa Web Search is hidden by the 'Given to you' filter");
  // A match on the name comes first, whatever order the rows came in.
  const ranked = placeSections(FIXTURES.bitmuse.rows, { ...FIXTURES.bitmuse, q: "search" });
  assert.deepEqual(names(ranked.installed), ["@thetis/exa", "@thetis/notion"], "Exa Web Search before what only mentions searching, though Notion's row came first");
  assert.equal(matchRank({ name: "@thetis/exa", label: "Exa web search" }, "exa"), 0);
  assert.equal(matchRank({ name: "@thetis/exa", label: "Exa web search" }, "search"), 1);
  assert.equal(matchRank({ name: "@thetis/notion", label: "Notion", description: "search pages" }, "search"), 2);
  // A family that is only a folder is a draft; a part a person does not have is not theirs to see.
  const draft = { name: "@sam/idea", label: "idea", folder: { dir: "packages/idea" }, local: true, tools: [{ name: "t" }] };
  const part = { name: "@thetis/gateway-cli", type: "gateway", component: true, system: true };
  const more = placeSections([...FIXTURES.sam.rows, draft, part], FIXTURES.sam);
  assert.deepEqual(names(more.drafts), ["@sam/idea"]);
  assert.ok(!names(more.thetis).includes("@thetis/gateway-cli"));
  assert.ok(names(placeSections([...FIXTURES.sam.rows, part], { ...FIXTURES.sam, user: "x", admin: true }).thetis).includes("@thetis/gateway-cli"));
});

test("required, admin-only and inside Thetis: the rules as data, and what they decide", () => {
  assert.deepEqual(REQUIRED.types, ["gateway", "provider", "storage", "host"]);
  assert.deepEqual(REQUIRED.names, ["@thetis/harness-core", "@thetis/marketplace", "@thetis/ui-marketplace", "@thetis/ui-admin", "@thetis/gateway-login", "@thetis/gateway-web"]);
  assert.equal(isRequired(find("sam", "@thetis/gateway-web")), true);
  assert.equal(isRequired({ name: "@thetis/ui-admin", type: "ui" }), true);
  assert.equal(isRequired({ name: "@bitmuse/ui-admin", type: "ui", forkedFrom: { name: "@thetis/ui-admin", version: "1" } }), true, "a copy of a required extension is required");
  assert.equal(isRequired(find("sam", "@thetis/exa")), false);
  assert.deepEqual([ADMIN_ONLY.audience, ADMIN_ONLY.types, ADMIN_ONLY.names, ADMIN_ONLY.line], ["admin", ["host", "storage"], ["@thetis/gateway-login"], "Only admins can have this."]);
  assert.equal(isAdminOnly(find("sam", "@thetis/tool-operator")), true);
  assert.equal(isAdminOnly({ name: "@thetis/store-toml", type: "storage" }), true);
  assert.equal(isAdminOnly(find("sam", "@thetis/exa")), false);
  assert.equal(runsInsideThetis({ name: "@thetis/store-toml", type: "storage" }), true);
  assert.equal(runsInsideThetis({ name: "@thetis/gateway-login", type: "gateway" }), true);
  assert.equal(runsInsideThetis({ name: "@thetis/marketplace", type: "service" }), true);
  assert.equal(runsInsideThetis(find("sam", "@thetis/gateway-web")), false, "the web gateway a person has runs in their space");
  assert.equal(WORDS.required, "Required by Thetis");
});

test("needs: the key's help as a short noun with its link, never the key's name, examples or the server's .env", () => {
  assert.equal(needsLine(find("sam", "@thetis/exa")), "Needs an Exa API key. Get one at dashboard.exa.ai.");
  assert.equal(needsLine(find("sam", "@bitmuse/notion")), "Needs an internal connection or personal access token. Get one at https://www.notion.so/my-integrations.");
  assert.equal(needsLine({ needs: [{ key: "url", help: "Base URL of the Grafana instance, e.g. https://x.grafana.net (Cloud) or http://localhost:3000." }, { key: "token", secret: true, help: "" }] }), "Needs the base URL of the Grafana instance and a token.");
  assert.equal(needsLine({ needs: [{ key: "apiKey", help: "Put it in .env as K." }] }), "Needs an API key.", "an .env sentence is the admin's, so it is not said");
  assert.equal(needsLine({ needs: [] }), null);
  assert.equal(nounOf({ key: "token", help: "A service account token (glsa_…) from Administration → Users. Every tool reads it." }).noun, "a service account token");
  assert.equal(linkOf("Base URL, e.g. https://x.grafana.net or http://localhost:3000."), null, "an example is not a link");
  assert.equal(setupSentence("Notion", [{ key: "token", help: "An internal connection token from https://www.notion.so/my-integrations." }]), "Notion needs an internal connection token before it works. Get one at https://www.notion.so/my-integrations.");
  assert.equal(humanKey("apiKey"), "API key");
  assert.equal(humanKey("timeoutMs"), "timeout (ms)");
});

test("search: name, label, description, tool names, and a narrow list of synonyms that look only at names", () => {
  const exa = find("sam", "@thetis/exa");
  for (const q of ["exa", "web", "internet", "google", "search", "EXA_CONTENTS", "deep research"]) assert.equal(matches(exa, q), true, q);
  assert.equal(matches(exa, "notion"), false);
  assert.equal(matches(exa, "web", "Skills"), false, "the kind filter narrows too");
  assert.deepEqual(SYNONYMS, [["web", "internet", "google"]]);
  assert.equal(matches({ name: "@thetis/files", label: "Files", description: "The Files place of the web gateway." }, "google"), false, "a synonym is not looked for in a description");
  assert.equal(matches({ name: "@thetis/lore", label: "lore", description: "Search the lore." }, "google"), false, "search is nobody's synonym");
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

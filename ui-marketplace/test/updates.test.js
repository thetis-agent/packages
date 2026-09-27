// The "Updates ready" card from both ends. The server half: what the `updates` command answers for each kind
// of behind, the person's own changes, copies that can switch back, and the terminal count read through a
// soft link. The browser half: the card's state machine driven with fakes -- what it shows, when it keeps
// quiet, what Update all sends and in which order, when own changes apply by themselves, and that nothing
// ever cancels a reply. Then the store's sections and the page's "what you get" line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as commands from "../index.js";
import { labelOf, newestChange, shellsOf, updatesOf } from "../lib/updates.js";
import { createUpdater, isBusy, listOf, lostGateway, shellsLine, signatureOf, words } from "../ui/updates-notice.js";
import { bringsLine, sections, statusText, withConfig } from "../ui/gallery.js";
import { changedLine, whatYouGet } from "../ui/page.js";

const REPO = "https://github.com/thetis-agent/packages.git";
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

const shipped = (name, extra = {}) => ({ name, version: "0.1.0", type: "tool", description: "", root: "/nowhere", thetis: { type: "tool" }, source: { kind: "system", ref: "/sys" }, loadedVersion: "0.1.0", ...extra });
const entry = (name, version, commit, extra = {}) => ({ name, version, type: "tool", description: "", keywords: [], registry: "thetis", url: REPO, dir: name.slice(8), commit, source: `${REPO}#${name.slice(8)}@${commit}`, steps: [], tools: [], service: false, ...extra });
const indexOf = (...packages) => ({ version: 1, updatedAt: "2026-09-27T00:00:00.000Z", registries: [{ name: "thetis", url: REPO }], packages });

// ---- the server half ----

test("updates: a newer commit is fetched first, a newer version on disk is only applied, and each has a name a person reads", async () => {
  const installed = [
    { ...shipped("@thetis/exa"), version: "0.1.0", source: { kind: "git", ref: `${REPO}#exa@${OLD}` } },
    { ...shipped("@thetis/gateway-web", { thetis: { type: "gateway", label: "web gateway" } }), version: "0.13.1", loadedVersion: "0.13.0" },
    shipped("@thetis/terminal"),
  ];
  const out = await updatesOf({ installed, index: indexOf(entry("@thetis/exa", "0.2.0", NEW)), openedAt: Date.now(), newestOf: () => 0 });
  assert.deepEqual(out.items, [
    { name: "@thetis/exa", label: "Exa", from: "0.1.0", to: "0.2.0", apply: "install" },
    { name: "@thetis/gateway-web", label: "Web Gateway", from: "0.13.0", to: "0.13.1", apply: "apply" },
  ], "labels in Title Case, the ones the cards say, never an id");
  // The newest version's label names it, so the card and the toast say what the place says.
  const renamed = await updatesOf({ installed, index: indexOf(entry("@thetis/exa", "0.2.0", NEW, { label: "Exa web search" })), openedAt: Date.now(), newestOf: () => 0 });
  assert.equal(renamed.items[0].label, "Exa Web Search");
  // Two versions that are the same are nothing to update.
  const same = await updatesOf({ installed: [{ ...shipped("@thetis/x"), version: "0.3.3-fork.1", loadedVersion: "0.3.3-fork.1" }], index: undefined, openedAt: Date.now(), newestOf: () => 0 });
  assert.deepEqual(same.items, []);
  assert.deepEqual(out.own, []);
  assert.deepEqual(out.forks, []);
  assert.equal(labelOf({ name: "@thetis/ui-workspace" }), "workspace", "the page's own prefix is not part of the name");
  assert.equal(labelOf({ name: "@thetis/x", thetis: { label: "  Files " } }), "Files");
});

test("updates: the person's own extensions count when their files changed after the space opened, or were added since", async () => {
  const opened = 1_000_000;
  const own = (name, extra = {}) => ({ ...shipped(name), source: { kind: "local", ref: `packages/${name.slice(7)}` }, root: `/home/${name}`, ...extra });
  const installed = [
    own("@alice/moo"), // edited after the space opened, with no version bump: no version comparison can see this
    own("@alice/old"), // untouched
    own("@alice/new", { loadedVersion: undefined, thetis: { type: "ui", ui: { dir: "ui" } } }), // installed after the space opened
    // An own package whose version moved as well: it is the person's change to apply, not an update to take.
    own("@alice/bumped", { version: "0.2.0", loadedVersion: "0.1.0" }),
    { ...shipped("@thetis/terminal"), root: "/shipped/terminal" }, // shipped packages never count by time: every build touches them
  ];
  const times = { "/home/@alice/moo": opened + 5000, "/home/@alice/old": opened - 5000, "/home/@alice/new": opened - 1, "/home/@alice/bumped": opened + 1, "/shipped/terminal": opened + 9999 };
  const out = await updatesOf({ installed, index: undefined, openedAt: opened, newestOf: (root) => times[root] ?? 0 });
  assert.deepEqual(
    out.own.map((o) => [o.name, o.label, o.ui]),
    [
      ["@alice/moo", "Moo", false],
      ["@alice/new", "New", true],
      ["@alice/bumped", "Bumped", false],
    ]
  );
  assert.equal(out.own[0].at, opened + 5000, "the change's own time, so the next edit is a new set");
  assert.deepEqual(out.items, [], "an own package is never listed twice");
});

test("updates: a copy is offered back only when it carries nothing the official version lacks", async () => {
  const copy = (name, fork) => ({ ...shipped(name), source: { kind: "local", ref: "packages/x" }, root: `/home/${name}`, forkedFrom: { name: fork.name, version: fork.version }, fork });
  const installed = [
    copy("@alice/tool-exec", { name: "@thetis/tool-exec", version: "0.3.3", shipped: "0.3.4" }),
    copy("@alice/gateway-web", { name: "@thetis/gateway-web", version: "0.13.0", shipped: "0.13.0", identical: true }),
    copy("@alice/terminal", { name: "@thetis/terminal", version: "0.1.3", shipped: "0.1.3" }),
  ];
  const catalog = [shipped("@thetis/tool-exec", { root: "/sys/tool-exec" }), shipped("@thetis/gateway-web", { root: "/sys/gateway-web", thetis: { type: "gateway", label: "web gateway" } }), shipped("@thetis/terminal", { root: "/sys/terminal" })];
  const states = { "/home/@alice/tool-exec": "superseded", "/home/@alice/gateway-web": "unknown", "/home/@alice/terminal": "diverged" };
  const out = await updatesOf({ installed, catalog, index: undefined, openedAt: Date.now() + 1e9, newestOf: () => 0, forkStateOf: (root) => states[root] });
  assert.deepEqual(out.forks, [
    { name: "@alice/tool-exec", label: "Tool Exec", origin: "@thetis/tool-exec", state: "superseded" },
    // No recorded base: the kernel's byte-for-byte flag is what is left, and it says identical.
    { name: "@alice/gateway-web", label: "Web Gateway", origin: "@thetis/gateway-web", state: "identical" },
  ]);
  // An older runtime without the comparison: only the identical copy can be said anything about.
  const bare = await updatesOf({ installed, catalog, index: undefined, openedAt: Date.now() + 1e9, newestOf: () => 0, forkStateOf: null });
  assert.deepEqual(bare.forks.map((f) => [f.name, f.state]), [["@alice/gateway-web", "identical"]]);
  // A copy behind its origin is the page's business, not the card's: it is never an item either.
  assert.deepEqual(out.items, []);
});

test("updates: the command answers the lists, the terminal count and the person's choice, from real state", async () => {
  const env = {
    user: "alice",
    shared: mkdtempSync(join(tmpdir(), "ui-market-up-")),
    config: { applyOwnChanges: "ask" },
    kernel: { packages: { list: async () => [shipped("@thetis/gateway-web", { version: "0.13.1", loadedVersion: "0.13.0" })] }, config: { effective: async () => ({}) } },
  };
  try {
    const out = (await commands.updates({}, env)).data;
    assert.deepEqual(Object.keys(out).sort(), ["applyOwnChanges", "forks", "items", "own", "shells", "watched"]);
    assert.equal(out.items.length, 1);
    assert.equal(out.shells, 0, "no terminal installed: no sessions to close");
    assert.equal(out.applyOwnChanges, "ask");
    env.config = {};
    assert.equal((await commands.updates({}, env)).data.applyOwnChanges, "auto", "the default is auto");
  } finally {
    rmSync(env.shared, { recursive: true, force: true });
  }
});

test("updates: the terminal count comes from the terminal's own command, and an older or broken terminal counts as none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-market-term-"));
  const terminal = (source, commandsDeclared) => {
    const root = join(dir, String(Math.random()).slice(2));
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@thetis/terminal", type: "module", main: "index.js" }));
    writeFileSync(join(root, "index.js"), source);
    return { name: "@thetis/terminal", root, thetis: { type: "tool", ui: { commands: commandsDeclared } } };
  };
  const env = { kernel: { config: { effective: async () => ({ shell: "/bin/bash" }) } } };
  try {
    const counted = terminal("export async function sessionsCount(_a, env) { return { data: { open: env.config.shell ? 2 : 0 } }; }", [{ verb: "sessions-count", export: "sessionsCount" }]);
    assert.equal(await shellsOf(env, [counted]), 2, "run with the terminal's own configuration");
    const older = terminal("export async function uiSessions() { return { data: { sessions: [{ id: 'a' }, { id: 'b', closed: true }, { id: 'c' }] } }; }", [{ verb: "sessions", export: "uiSessions" }]);
    assert.equal(await shellsOf(env, [older]), 2, "an older terminal: its session list is counted");
    const broken = terminal("export async function sessionsCount() { throw new Error('no host'); }", [{ verb: "sessions-count", export: "sessionsCount" }]);
    assert.equal(await shellsOf(env, [broken]), 0);
    assert.equal(await shellsOf(env, []), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updates: the newest change skips what never needs applying", () => {
  const root = mkdtempSync(join(tmpdir(), "ui-market-mtime-"));
  try {
    for (const d of ["dist", "skills/a", "node_modules/x", "ui"]) mkdirSync(join(root, d), { recursive: true });
    const put = (rel, at) => {
      writeFileSync(join(root, rel), "x");
      utimesSync(join(root, rel), at / 1000, at / 1000);
    };
    put("dist/index.js", 1_000_000);
    put("ui/index.css", 2_000_000);
    put("skills/a/SKILL.md", 9_000_000); // read on every turn: already live
    put("node_modules/x/index.js", 9_000_000);
    put("README.md", 9_000_000);
    assert.equal(newestChange(root), 2_000_000);
    assert.equal(newestChange(join(root, "missing")), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the browser half: the card's state machine ----

/** A fake world for the updater: the answers, the running replies, the cards drawn, the requests sent. */
function world({ answer, running = false, local = {}, session = {}, back = "back", fenceReload } = {}) {
  const sent = [];
  const cards = new Map();
  const closed = [];
  const toasts = [];
  const idle = new Set();
  const stores = { local: new Map(Object.entries(local)), session: new Map(Object.entries(session)) };
  const store = (m) => ({ get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) });
  const state = { running, answer, reloads: 0, reviews: 0 };
  const deps = {
    request: async (verb, args) => {
      sent.push([verb, args]);
      if (verb === "updates") return structuredClone(state.answer);
      if (verb === "fence-reload" && fenceReload) return fenceReload(args, sent);
      return {};
    },
    notice: (id, spec) => {
      cards.set(id, spec);
      return { update() {}, close() {} };
    },
    closeNotice: (id) => {
      closed.push(id);
      cards.delete(id);
    },
    running: () => state.running,
    onIdle: (fn) => {
      idle.add(fn);
      return () => idle.delete(fn);
    },
    awaitReturn: async () => back,
    reloadPage: () => (state.reloads += 1),
    toast: (text, opts) => toasts.push([text, opts?.tone]),
    openReview: () => (state.reviews += 1),
    local: store(stores.local),
    session: store(stores.session),
    every: () => () => {},
    // Short waits pass at once; the long ones (a card closing itself after 8 s, the 5 min cap) never come.
    later: (ms, fn) => void (ms < 5000 && Promise.resolve().then(fn)),
    onVisible: () => () => {},
    now: () => 1000,
    ask: async () => false,
  };
  const endTurn = () => {
    state.running = false;
    for (const fn of [...idle]) fn();
  };
  return { deps, sent, cards, closed, toasts, stores, state, endTurn, settle: () => new Promise((r) => setTimeout(r, 5)) };
}

const ITEMS = [
  { name: "@thetis/gateway-web", label: "web gateway", from: "0.13.0", to: "0.13.1", apply: "apply" },
  { name: "@thetis/exa", label: "exa", from: "0.1.0", to: "0.2.0", apply: "install" },
  { name: "@thetis/compaction", label: "compaction", from: "0.1.0", to: "0.1.1", apply: "install" },
];
const answer = (extra = {}) => ({ items: [], own: [], forks: [], shells: 0, applyOwnChanges: "auto", ...extra });

test("card: Updates ready names what has an update, with Review and Update all; × hides it until the set changes", async () => {
  const w = world({ answer: answer({ items: ITEMS }) });
  const u = createUpdater(w.deps);
  await u.check();
  const card = w.cards.get("updates");
  assert.equal(card.title, "Updates ready");
  assert.equal(card.body, "Updates for 3 extensions: web gateway, exa and compaction.");
  assert.deepEqual(card.actions.map((a) => [a.label, !!a.primary]), [["Review", false], ["Update all", true]]);
  card.actions[0].run();
  assert.equal(w.state.reviews, 1);
  // ×: hidden for this exact set, and back when the set changes.
  card.onDismiss();
  w.cards.clear();
  await u.check();
  assert.equal(w.cards.has("updates"), false);
  w.state.answer = answer({ items: [...ITEMS, { name: "@thetis/skills", label: "skills", from: "0.1.0", to: "0.1.1", apply: "apply" }] });
  await u.check();
  assert.equal(w.cards.get("updates").body, "Updates for 4 extensions: web gateway, exa, compaction and skills.");
  // Nothing left to update: the card goes.
  w.state.answer = answer();
  await u.check();
  assert.equal(w.cards.has("updates"), false);
  assert.ok(w.closed.includes("updates"));
});

test("card: while the Extensions place is open the Updates card stays away, and comes back after the last view lets go", async () => {
  const w = world({ answer: answer({ items: ITEMS }) });
  const u = createUpdater(w.deps);
  await u.check();
  assert.equal(w.cards.has("updates"), true);
  const first = u.hold();
  assert.equal(w.cards.has("updates"), false, "the place's status line says it instead");
  await u.check();
  assert.equal(w.cards.has("updates"), false, "a check while it is held draws no card");
  // The store hands over to a page: one lets go as the other holds, and the card does not flicker back.
  const second = u.hold();
  first();
  await w.settle();
  assert.equal(w.cards.has("updates"), false);
  second();
  second();
  await w.settle();
  assert.equal(w.cards.has("updates"), true, "back once nothing holds it");
});

test("card: never asked, shown or changed while a reply is running; it appears when the reply ends", async () => {
  const w = world({ answer: answer({ items: ITEMS }), running: true });
  const u = createUpdater(w.deps);
  u.start();
  await w.settle();
  assert.deepEqual(w.sent, [], "nothing is asked mid-reply");
  assert.equal(w.cards.size, 0);
  assert.equal(u.pending, true);
  w.endTurn();
  await w.settle();
  assert.deepEqual(w.sent.map((s) => s[0]), ["updates"]);
  assert.equal(w.cards.get("updates").title, "Updates ready");
  u.stop();
});

test("card: Update all fetches what has to be fetched, in order, then applies once with drain, waits, and refreshes with one sentence", async () => {
  const w = world({ answer: answer({ items: ITEMS }) });
  const u = createUpdater(w.deps);
  await u.check();
  await w.cards.get("updates").actions[1].run();
  await w.settle();
  assert.deepEqual(w.sent.slice(1), [
    ["update", { name: "@thetis/exa" }],
    ["update", { name: "@thetis/compaction" }],
    ["fence-reload", { drain: true }],
  ]);
  assert.equal(w.state.reloads, 1);
  assert.equal(w.stores.session.get("thetis.ui-marketplace.after"), "Updated: web gateway, exa and compaction.");
  // After the refresh, the new page says it once.
  const after = world({ answer: answer(), session: Object.fromEntries(w.stores.session) });
  createUpdater(after.deps).start();
  await after.settle();
  assert.deepEqual(after.toasts, [["Updated: web gateway, exa and compaction.", "good"]]);
  assert.equal(after.stores.session.has("thetis.ui-marketplace.after"), false);
});

test("card: a failed fetch is named and the rest still apply; a reply that is running pauses at a safe point, never cancelled", async () => {
  const w = world({ answer: answer({ items: ITEMS }), fenceReload: () => ({}) });
  w.deps.request = ((inner) => async (verb, args) => {
    if (verb === "update" && args.name === "@thetis/exa") {
      w.sent.push([verb, args]);
      throw Object.assign(new Error("build failed"), { status: 400 });
    }
    return inner(verb, args);
  })(w.deps.request);
  const u = createUpdater(w.deps);
  await u.check();
  // A reply starts between the card being drawn and the click: the card says so, and still never forces.
  w.state.running = true;
  const said = [];
  const notice = w.deps.notice;
  w.deps.notice = (id, spec) => (said.push(spec.body), notice(id, spec));
  await u.updateAll();
  assert.ok(said.includes(words.applying(true)), "Pausing your reply at a safe point…");
  assert.equal(words.applying(true), "Pausing your reply at a safe point… it continues afterwards.");
  assert.ok(w.sent.every(([verb, args]) => verb !== "fence-reload" || (args.drain === true && !("force" in args))));
  assert.equal(w.stores.session.get("thetis.ui-marketplace.after"), "Updated: web gateway and compaction. exa could not be fetched and stays as it was.");
});

test("card: an older kernel that refuses while a reply runs is waited out and asked again, never forced", async () => {
  let refusals = 1;
  const w = world({
    answer: answer({ items: [ITEMS[0]] }),
    fenceReload: () => {
      if (refusals-- > 0) throw Object.assign(new Error("alice has a turn running in s_1: wait for it to end, or reload with force to cancel it"), { status: 400 });
      return {};
    },
  });
  const u = createUpdater(w.deps);
  await u.check();
  await u.updateAll();
  assert.deepEqual(w.sent.filter((s) => s[0] === "fence-reload").map((s) => s[1]), [{ drain: true }, { drain: true }]);
  assert.equal(w.state.reloads, 1);
  assert.equal(isBusy(new Error("x has a turn running in y")), true);
  assert.equal(lostGateway(Object.assign(new Error("Not connected."), { status: 0 })), true);
  assert.equal(lostGateway(Object.assign(new Error("refused"), { status: 400 })), false);
});

test("card: open terminal sessions are asked about once, on the card; Not now sends nothing", async () => {
  const w = world({ answer: answer({ items: ITEMS, shells: 2 }) });
  const u = createUpdater(w.deps);
  await u.check();
  const going = u.updateAll();
  await w.settle();
  const ask = w.cards.get("updates");
  assert.equal(ask.title, "Update now?");
  assert.equal(ask.body, "2 terminal sessions will close. Conversations and files are kept.");
  ask.actions.find((a) => a.label === "Not now").run();
  assert.equal(await going, false);
  assert.deepEqual(w.sent.map((s) => s[0]), ["updates"], "nothing installed, nothing applied");
  assert.equal(w.cards.get("updates").title, "Updates ready", "the card goes back to what it was");
  const again = u.updateAll();
  await w.settle();
  w.cards.get("updates").actions.find((a) => a.label === "Update").run();
  await again;
  assert.ok(w.sent.some((s) => s[0] === "fence-reload"));
  assert.equal(shellsLine(1), "1 terminal session will close.");
});

test("card: the space not coming back says so plainly, with Try again", async () => {
  const w = world({ answer: answer({ items: [ITEMS[0]] }), back: "timeout" });
  const u = createUpdater(w.deps);
  await u.check();
  assert.equal(await u.updateAll(), false);
  assert.equal(w.cards.get("updates").title, "This is taking longer than usual");
  assert.equal(w.state.reloads, 0);
});

test("own changes: applied by themselves when a reply ends and nothing runs and no terminal is open, once per set", async () => {
  const own = [{ name: "@alice/moo", label: "moo", ui: false, at: 5 }];
  const w = world({ answer: answer({ own }) });
  const u = createUpdater(w.deps);
  // Opening the page applies nothing by surprise: it offers.
  await u.check();
  assert.equal(w.cards.get("updates-own").title, "Changes ready");
  assert.equal(w.cards.get("updates-own").body, "Your changes to moo are ready to use.");
  assert.equal(w.sent.some((s) => s[0] === "fence-reload"), false);
  // A reply ends: now it applies, and a change that touched no page code keeps the page.
  await u.check("idle");
  await w.settle();
  assert.ok(w.sent.some((s) => s[0] === "fence-reload" && s[1].drain === true));
  assert.equal(w.state.reloads, 0);
  assert.equal(w.cards.get("updates-own").title, "Applied your changes to moo.");
  // The same set still there after that (it did not take): offered, not applied again in a loop.
  const count = w.sent.filter((s) => s[0] === "fence-reload").length;
  await u.check("idle");
  await w.settle();
  assert.equal(w.sent.filter((s) => s[0] === "fence-reload").length, count);
  assert.equal(w.cards.get("updates-own").title, "Changes ready");
  // A new edit is a new set, and applies.
  w.state.answer = answer({ own: [{ ...own[0], at: 6 }] });
  await u.check("idle");
  await w.settle();
  assert.equal(w.sent.filter((s) => s[0] === "fence-reload").length, count + 1);
});

test("own changes: shells only the agent used do not hold an automatic apply back; one a person is watching does", async () => {
  const own = [{ name: "@alice/moo", label: "moo", ui: false, at: 5 }];
  const agentOnly = world({ answer: answer({ own, shells: 1, watched: 0 }) });
  await createUpdater(agentOnly.deps).check("idle");
  await agentOnly.settle();
  assert.ok(agentOnly.sent.some((s) => s[0] === "fence-reload"), "the agent's own shell is reopened by the agent");
  const watched = world({ answer: answer({ own, shells: 1, watched: 1 }) });
  await createUpdater(watched.deps).check("idle");
  await watched.settle();
  assert.equal(watched.sent.some((s) => s[0] === "fence-reload"), false, "a shell on a person's screen is asked about");
});

test("own changes: ask, an open terminal, or page code all change what happens", async () => {
  const own = [{ name: "@alice/moo", label: "moo", ui: false, at: 5 }];
  const asked = world({ answer: answer({ own, applyOwnChanges: "ask" }) });
  await createUpdater(asked.deps).check("idle");
  assert.equal(asked.cards.get("updates-own").actions[0].label, "Apply");
  assert.equal(asked.sent.some((s) => s[0] === "fence-reload"), false);

  const shells = world({ answer: answer({ own, shells: 1 }) });
  await createUpdater(shells.deps).check("idle");
  assert.equal(shells.cards.get("updates-own").body, "Your changes to moo are ready to use. 1 terminal session will close.");
  assert.equal(shells.sent.some((s) => s[0] === "fence-reload"), false);

  const page = world({ answer: answer({ own: [{ ...own[0], ui: true }] }) });
  await createUpdater(page.deps).check("idle");
  await page.settle();
  assert.equal(page.state.reloads, 1, "a change to page code needs the page refreshed");
  assert.equal(page.stores.session.get("thetis.ui-marketplace.after"), "Applied your changes to moo.");
});

test("copies: the card says the strongest true thing, and Use Thetis's version unforks then applies", async () => {
  assert.deepEqual(words.forks([{ name: "@alice/tool-exec", label: "tool exec", state: "superseded" }]).title, "Your changes are in the official version");
  assert.deepEqual(words.forks([{ name: "@alice/gateway-web", label: "web gateway", state: "identical" }]).title, "Your copy has no changes");
  assert.equal(words.forks([{ label: "a", state: "identical" }, { label: "b", state: "superseded" }]).title, "Your copies can go back to the official versions");
  assert.match(words.forks([{ label: "a", origin: "@bitmuse/notion", state: "identical" }]).body, /Use the original to get its fixes/, "a copy of a person's extension goes back to their original, not to Thetis's");
  const forks = [{ name: "@alice/gateway-web", label: "web gateway", origin: "@thetis/gateway-web", state: "superseded" }];
  const w = world({ answer: answer({ forks }) });
  // Switching the web gateway back replaces the process answering: that lost answer is the success.
  const inner = w.deps.request;
  w.deps.request = async (verb, args) => {
    if (verb === "unfork") {
      w.sent.push([verb, args]);
      throw Object.assign(new Error("Not connected."), { status: 0 });
    }
    return inner(verb, args);
  };
  const u = createUpdater(w.deps);
  await u.check();
  const card = w.cards.get("updates-forks");
  assert.equal(card.actions[0].label, "Use Thetis's version");
  await card.actions[0].run();
  await w.settle();
  assert.deepEqual(w.sent.slice(1).map((s) => s[0]), ["unfork", "fence-reload"]);
  assert.equal(w.stores.session.get("thetis.ui-marketplace.after"), "Back on the official web gateway.");
});

test("card words: lists read as a sentence, and signatures change only when the set does", () => {
  assert.equal(listOf(["a"]), "a");
  assert.equal(listOf(["a", "b"]), "a and b");
  assert.equal(listOf(["a", "b", "c"]), "a, b and c");
  assert.equal(signatureOf.updates([{ name: "b", to: "1" }, { name: "a", to: "2" }]), signatureOf.updates([{ name: "a", to: "2" }, { name: "b", to: "1" }]));
  assert.notEqual(signatureOf.updates([{ name: "a", to: "2" }]), signatureOf.updates([{ name: "a", to: "3" }]));
  // None of the card's words is one a person should never see.
  const all = [words.updates(ITEMS), words.own([{ label: "moo" }], 2), words.forks([{ label: "x", state: "superseded" }]), words.slow, words.failed].flatMap((w) => [w.title, w.body]).join(" ");
  assert.doesNotMatch(all, /fence|workspace|reload|daemon|package|fork|loaded|on disk/i);
});

// ---- the store and the page ----

test("store: a to-do strip, Installed with its pills, Discover, Drafts and Part of Thetis, and one update verdict", () => {
  const rows = [
    { name: "@thetis/gateway-web", label: "web gateway", type: "gateway", installed: true, system: true, everyone: true, everyoneBy: "config", component: true, update: { apply: "reload", version: "0.13.1", installed: "0.13.0", available: "0.13.1" } },
    { name: "@thetis/exa", label: "Exa web search", type: "tool", installed: true, system: true, everyone: false, component: false, update: null, tools: [{ name: "exa_search" }] },
    { name: "@thetis/terminal", label: "terminal", type: "tool", installed: true, system: true, everyone: true, everyoneBy: "config", component: false, update: null, tools: [{ name: "shell" }] },
    { name: "@thetis/store-toml", label: "store toml", type: "storage", installed: false, system: true, component: true, update: null },
    { name: "@thetis/skills-orleans", label: "skills orleans", type: "skill", installed: false, system: true, component: false, update: null },
    { name: "@alice/copy", label: "copy", labelGiven: false, type: "tool", installed: true, local: true, component: false, forkedFrom: { name: "@thetis/thing", version: "0.1.0" }, fork: { name: "@thetis/thing", version: "0.1.0", shipped: "0.2.0" }, update: { apply: "unfork", version: "0.2.0", installed: "0.1.0", available: "0.2.0", origin: "@thetis/thing" } },
    { name: "@thetis/thing", label: "thing", type: "tool", installed: false, system: true, component: false, update: null },
    { name: "@alice/draft", label: "draft", type: "tool", installed: false, folder: { dir: "packages/draft" }, local: true, component: false, update: null },
  ];
  const plain = sections(rows, { user: "alice" });
  assert.deepEqual(plain.attention.map((e) => [e.row.name, e.todo.kind, e.todo.action]), [["@thetis/gateway-web", "update", "Update"], ["@alice/copy", "review", "Review"]], "an update to a part of Thetis is still the person's to take; a copy behind is a Review");
  assert.deepEqual(plain.all.updates, ["@thetis/gateway-web"], "Update N is exactly the Update rows: never the copy");
  assert.equal(statusText(plain.all, { checked: "15 min ago" }), "Updates ready: Web Gateway · checked 15 min ago");
  assert.deepEqual(plain.installed.map((e) => e.row.name), ["@thetis/exa", "@thetis/terminal", "@alice/copy"]);
  assert.equal(plain.installed[2].label, "Thing", "a copy without a label of its own takes its official version's");
  assert.deepEqual(plain.installed[2].state.chips.map((c) => c.label), ["Customized"]);
  assert.deepEqual(plain.discover.map((e) => e.row.name), ["@thetis/skills-orleans"], "the copy's official version is not offered again");
  assert.deepEqual(plain.drafts.map((e) => e.row.name), ["@alice/draft"]);
  assert.deepEqual(plain.thetis.map((e) => e.row.name), ["@thetis/gateway-web"], "a storage driver is an admin's: never offered to anybody else");
  assert.deepEqual(sections(rows, { user: "alice", admin: true }).thetis.map((e) => e.row.name), ["@thetis/gateway-web", "@thetis/store-toml"]);
  assert.deepEqual(plain.all.counts.installed, 3, "the number the Control panel says too");
  assert.deepEqual(sections(rows, { user: "alice", pill: "given" }).installed.map((e) => e.row.name), ["@thetis/terminal"], "Given to you: what everyone gets");
  assert.deepEqual(sections(rows, { user: "alice", pill: "mine" }).installed.map((e) => e.row.name), ["@thetis/exa", "@alice/copy"]);
  // The person's own changes waiting to be applied come from the `updates` answer.
  assert.deepEqual(sections(rows, { user: "alice", updates: answer({ items: ITEMS, own: [{ name: "@alice/moo", label: "moo" }] }) }).own.map((o) => o.name), ["@alice/moo"]);
  // A search narrows every section, synonyms included, and a type chip narrows by what it brings.
  const found = sections(rows, { user: "alice", q: "internet" });
  assert.deepEqual([...found.installed, ...found.discover].map((e) => e.row.name), ["@thetis/exa"], "internet finds web search");
  assert.equal(found.all.counts.installed, 3, "the counts are the unnarrowed place's");
  assert.deepEqual(sections(rows, { user: "alice", kind: "Skills" }).discover.map((e) => e.row.name), ["@thetis/skills-orleans"]);
  assert.equal(statusText({ attention: [] }), "All up to date");
});

test("store: a card's foot says what it brings, and the configuration reports fold onto installed rows", () => {
  assert.equal(bringsLine({ tools: [{}, {}] }), "2 tools");
  assert.equal(bringsLine({ tools: [], skills: 4 }), "4 skills");
  assert.equal(bringsLine({ tools: [], pages: 1 }), "1 page");
  assert.equal(bringsLine({ tools: [], type: "provider" }), "Models");
  assert.equal(bringsLine({ tools: [], type: "loader" }), "Runs in the background", "a card's foot is never empty");
  assert.equal(bringsLine({ tools: [{}, {}, {}, {}, {}, {}, {}], skills: 12, hasSkills: true }), "7 tools · 12 skills", "the foot names the same kinds as the type line (Tools · Skills)");
  const rows = withConfig([{ name: "@a/x", installed: true }, { name: "@a/y", installed: false }], new Map([["@a/x", { broken: true }], ["@a/y", { broken: true }]]));
  assert.deepEqual(rows.map((r) => !!r.config), [true, false], "only an installed row has a report of its own");
});

test("page: what you get is counted in the words a person uses", () => {
  assert.equal(whatYouGet({ tools: [{}, {}, {}], skills: 2, pages: 1 }), "3 tools · 2 skills · 1 page");
  assert.equal(whatYouGet({ tools: [{}], skills: 0, pages: 0, service: true }), "1 tool · runs in the background");
  assert.equal(whatYouGet({ tools: [], skills: 0, pages: 0 }), null);
  assert.equal(changedLine({ changed: ["dist/src/index.js"], fork: { version: "0.3.3" } }), "You changed 1 file since 0.3.3: dist/src/index.js.");
  assert.equal(changedLine({ forkedFrom: { version: "1.0.0" } }), null, "not known without a base");
});

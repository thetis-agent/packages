// The sections drawn into a small fake DOM, to check what a person reads: a section whose command failed says
// "X could not be read: <reason>. <fix>" (with Restart Thetis for an admin when only a restart fixes it, and
// the raw error folded under Details), and never the empty state an empty answer would draw ("0 mounts",
// "No person has a workspace here"). And the Overview, Workspaces and extensions pages say the three words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainFailure, failureSentence } from "../ui/failed.js";

/** A node of the fake DOM: a tag, its props, its children; enough of Element for the modules. */
class FakeNode {
  constructor(tag, props = {}) {
    this.tag = tag;
    this.props = { ...props };
    this.children = [];
    this.disabled = Boolean(props.disabled);
    const classes = new Set(String(props.class ?? "").split(/\s+/).filter(Boolean));
    this.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
    this.className = "";
  }
  append(...kids) {
    for (const k of kids.flat()) if (k != null && k !== false) this.children.push(k instanceof FakeNode ? k : String(k));
  }
  setAttribute(k, v) {
    this.props[k] = v;
  }
  addEventListener(name, fn) {
    this.props[`on${name[0].toUpperCase()}${name.slice(1)}`] = fn;
  }
  remove() {}
  querySelector() {
    return null;
  }
}

const el = (tag, props, ...kids) => {
  const n = new FakeNode(tag, props ?? {});
  n.append(...kids);
  return n;
};
const clear = (n) => void (n.children = []);
/** Everything a person would read in a node, in order. */
const text = (n) => (typeof n === "string" ? n : n.children.map(text).join(""));
/** Every node under `n` that `pick` keeps. */
const all = (n, pick) => (typeof n === "string" ? [] : [...(pick(n) ? [n] : []), ...n.children.flatMap((c) => all(c, pick))]);
const buttons = (n) => all(n, (x) => x.tag === "button").map(text);

/** An ext over the fake DOM. `answers[verb]` is a value, an Error to throw, or a function of the args. */
function fakeExt(answers = {}, { admin = true } = {}) {
  const calls = [];
  const toasts = [];
  const put = (node, ...kids) => {
    node.append(...kids.flat().filter((k) => k != null && k !== false));
    return node;
  };
  return {
    calls,
    toasts,
    can: (verb) => admin || !["status", "restart-request", "update-check", "users", "fleet"].includes(verb),
    toast: (t, o) => toasts.push([t, o?.tone]),
    async request(verb, { args } = {}) {
      calls.push([verb, args ?? null]);
      const a = answers[verb];
      if (a instanceof Error) throw a;
      if (a === undefined) throw Object.assign(new Error(`no answer for ${verb}`), { status: 500 });
      return { data: typeof a === "function" ? a(args) : a };
    },
    dom: { el, clear, icon: () => el("svg"), setHidden: () => {} },
    ui: {
      badge: (t, tone = "dim") => el("span", { class: `badge is-${tone}` }, t),
      busy: () => () => {},
      button: (label, { onClick, disabled, title } = {}) => el("button", { onClick, disabled, title }, label),
      card: (title, ...kids) => el("div", { class: "card" }, title, ...kids),
      confirm: async () => false,
      field: (label, input) => el("label", {}, label, input),
      heading: (label, note) => el("div", { class: "section-head" }, label, note ? ` · ${note}` : null),
      kv: (pairs) => el("dl", {}, ...pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v ?? "—")])),
      put,
      table: (cols, rows, { empty = "Nothing here." } = {}) => (rows.length ? el("table", {}, ...rows.map((r) => el("tr", {}, ...cols.map((c) => el("td", {}, c.render ? c.render(r) : String(r[c.key] ?? "")))))) : el("div", { class: "table-empty" }, empty)),
      tags: (items, tone, empty = "none") => (items.length ? el("div", {}, ...items.map((t) => el("span", {}, t))) : el("span", {}, empty)),
      when: () => "just now",
      pickDirectory: async () => null,
    },
  };
}

const settled = async () => {
  for (let i = 0; i < 6; i++) await new Promise((done) => setImmediate(done));
};

// The error production showed on 09-26: the daemon's stale copy of host-grants/lib/ssh.js.
const STALE = () => Object.assign(new Error("The requested module './lib/ssh.js' does not provide an export named 'isWithin'"), { status: 500 });

test("plainFailure: a module error is 'needs a restart', a lost answer is 'did not answer', a kernel sentence stays, code never shows", () => {
  const stale = plainFailure(STALE(), { admin: true });
  assert.equal(stale.reason, "part of Thetis needs a restart to load this page");
  assert.equal(stale.restart, true);
  assert.match(stale.fix, /^Restart Thetis/);
  assert.equal(plainFailure(STALE()).fix, "Ask an admin to restart Thetis.");
  assert.equal(plainFailure(Object.assign(new Error("the host package @thetis/host-update (update) does not export a method named restart"), { status: 404 })).restart, true, "a host package loaded older than what calls it");
  assert.equal(plainFailure(Object.assign(new Error("Not connected."), { status: 0 })).reason, "Thetis did not answer");
  assert.equal(plainFailure(Object.assign(new Error("user zed is suspended"), { status: 400 })).reason, "user zed is suspended", "a kernel sentence is already plain");
  assert.equal(plainFailure(Object.assign(new Error("TypeError: x is undefined\n    at file:///a.js:3:4"), { status: 500 })).reason, "something went wrong on the server");
  assert.equal(failureSentence("Mounts", STALE(), { admin: true }), "Mounts could not be read: part of Thetis needs a restart to load this page. Restart Thetis to load it; running replies pause at a safe point and continue after.");
});

test("Access → Mounts, for an admin: a failed read is the failure card with Restart Thetis, never '0 mounts'", async () => {
  const { mountAccess } = await import("../ui/access.js");
  const ext = fakeExt({ users: [{ id: "bob", role: "user" }], "mounts-list": STALE() });
  const root = el("div");
  mountAccess(ext, root, { role: "admin", user: "root" });
  await settled();
  const said = text(root);
  assert.match(said, /Mounts could not be read: part of Thetis needs a restart to load this page\./);
  assert.doesNotMatch(said, /0 mounts|No host directory is bound/);
  assert.ok(buttons(root).includes("Restart Thetis"));
  assert.ok(buttons(root).includes("Try again"));
  const details = all(root, (n) => n.tag === "details");
  assert.equal(details.length, 1);
  assert.match(text(details[0]), /^DetailsThe requested module/, "the raw error, folded");
  assert.deepEqual(ext.toasts, [], "nothing raw reached a toast");
  // The same page when the read works and there really are none: that is when "0 mounts" is true.
  const ok = fakeExt({ users: [{ id: "bob", role: "user" }], "mounts-list": {} });
  const root2 = el("div");
  mountAccess(ok, root2, { role: "admin", user: "root" });
  await settled();
  assert.match(text(root2), /0 mounts/);
});

test("Access → Mounts, for a user: their own, in their words, and a failure without an admin's button", async () => {
  const { mountMounts } = await import("../ui/mounts.js");
  const failing = fakeExt({ "mounts-list": STALE() }, { admin: false });
  const root = el("div");
  mountMounts(failing, root, { role: "user", user: "bob" });
  await settled();
  assert.match(text(root), /Your mounts could not be read: part of Thetis needs a restart to load this page\. Ask an admin to restart Thetis\./);
  assert.ok(!buttons(root).includes("Restart Thetis"));
  const ok = fakeExt({ "mounts-list": { bob: [{ path: "/srv/gone", mode: "rw", present: false, kind: "none" }] } }, { admin: false });
  const root2 = el("div");
  mountMounts(ok, root2, { role: "user", user: "bob" });
  await settled();
  assert.match(text(root2), /your space opened without it/);
  assert.doesNotMatch(text(root2), /workspace|fence/i, "a person reads 'your space'");
});

test("Access → SSH keys: a failed read never says 'No person has a workspace here'", async () => {
  const { mountSsh } = await import("../ui/ssh.js");
  const ext = fakeExt({ users: [{ id: "bob", role: "user" }], "ssh-list": STALE() });
  const root = el("div");
  mountSsh(ext, root, { role: "admin", user: "root" });
  await settled();
  assert.match(text(root), /The SSH keys could not be read: part of Thetis needs a restart/);
  assert.doesNotMatch(text(root), /No person has a workspace|has no key/);
  const mine = fakeExt({ "ssh-list": { bob: [] } }, { admin: false });
  const root2 = el("div");
  mountSsh(mine, root2, { role: "user", user: "bob" });
  await settled();
  assert.match(text(root2), /Your space has no key/);
});

test("People, Models, Activity, Workspaces and the extensions pages: a failed read is said, never drawn as empty", async () => {
  const { mountPeople } = await import("../ui/people.js");
  const { mountModels } = await import("../ui/models.js");
  const { mountActivity } = await import("../ui/activity.js");
  const { mountWorkspaces } = await import("../ui/workspaces.js");
  const { mountFleet } = await import("../ui/fleet.js");
  const lost = () => Object.assign(new Error("Not connected."), { status: 0 });
  const cases = [
    [(ext, root) => mountPeople(ext, root, { user: "root" }), { users: lost() }, /The people could not be read: Thetis did not answer\./, /0 people/],
    [(ext, root) => mountModels(ext, root, { role: "admin" }), { models: STALE() }, /The models could not be read/, /No model provider is installed/],
    [(ext, root) => mountActivity(ext, root, { role: "admin" }), { journal: STALE() }, /The activity could not be read/, /Nothing recorded yet/],
    [(ext, root) => mountWorkspaces(ext, root, { user: "root" }), { status: STALE(), "update-check": { updating: false } }, /The workspaces could not be read/, /No workspace has been opened yet/],
    [(ext, root) => mountFleet(ext, root, { user: "root", mode: "simple" }), { fleet: STALE(), "update-check": { updating: false } }, /The extensions could not be read/, /No extension is installed anywhere/],
  ];
  for (const [mount, answers, said, never] of cases) {
    const ext = fakeExt(answers);
    const root = el("div");
    mount(ext, root);
    await settled();
    assert.match(text(root), said);
    assert.doesNotMatch(text(root), never);
    assert.deepEqual(ext.toasts, [], `${said}: nothing raw in a toast`);
  }
});

test("Advanced → Workspaces: Up to date or Update ready per workspace, restart drained by default, and every control off while an update installs", async () => {
  const { mountWorkspaces } = await import("../ui/workspaces.js");
  const status = { daemon: { startedAt: "2026-09-27T10:00:00Z", uptimeSecs: 600, supervised: true, restartPolicy: "always", stale: true, codeAt: "2026-09-27T10:05:00Z" }, restart: { reason: "update", by: "root" }, workspaces: [{ user: "bob", openedAt: "2026-09-27T10:00:00Z", changed: [{ name: "@thetis/terminal", loaded: "0.1.0", onDisk: "0.2.0" }], services: [] }, { user: "root", openedAt: "2026-09-27T10:00:00Z", changed: [], services: [] }] };
  const ext = fakeExt({ status, "update-check": { updating: false } });
  const root = el("div");
  mountWorkspaces(ext, root, { user: "root" });
  await settled();
  const said = text(root);
  assert.match(said, /Restart needed/, "the server runs older code than the disk");
  assert.match(said, /Update ready/);
  assert.match(said, /Up to date/);
  assert.match(said, /Restart pending/);
  assert.ok(buttons(root).includes("Cancel"), "the pending restart can be called off here");
  assert.doesNotMatch(said, /older code|reload|daemon|fence/i);
  const locked = fakeExt({ status: { ...status, restart: null }, "update-check": { updating: true } });
  const root2 = el("div");
  mountWorkspaces(locked, root2, { user: "root" });
  await settled();
  assert.match(text(root2), /An update is installing; Thetis restarts by itself when it is done\./);
  const restartButtons = all(root2, (n) => n.tag === "button" && ["Restart", "Force…", "Restart Thetis…"].includes(text(n)));
  assert.ok(restartButtons.length >= 3);
  for (const b of restartButtons) assert.equal(b.props.disabled, true, `${text(b)} is off while the update installs`);
  // The restart itself: drained unless force was chosen.
  const { reloadWorkspace } = await import("../ui/workspaces.js");
  const sent = fakeExt({ "fence-reload": (a) => ({ user: a.user, services: [], drained: ["s_1"] }) });
  const out = await reloadWorkspace(sent, "bob");
  assert.deepEqual(sent.calls[0], ["fence-reload", { user: "bob", drain: true }]);
  assert.deepEqual(out.drained, ["s_1"]);
  await reloadWorkspace(sent, "bob", { mode: "force" });
  assert.deepEqual(sent.calls[1], ["fence-reload", { user: "bob", force: true }]);
});

test("All extensions: what is installed for you, in the columns every list uses, with the chips and one Apply button", async () => {
  const { mountFleet } = await import("../ui/fleet.js");
  const fleet = {
    people: [{ user: "bob" }, { user: "root" }],
    packages: [
      { name: "@thetis/terminal", label: "terminal", type: "tool", tools: ["run"], version: "0.2.0", everyone: true, everyoneBy: "config", source: { kind: "system" }, mine: true, state: "update", waiting: ["bob", "root"], registry: { version: "0.2.0", update: { apply: "reload", version: "0.2.0" } }, config: null, byUser: { bob: { version: "0.2.0", loaded: "0.1.0", state: "update" }, root: { version: "0.2.0", loaded: "0.1.0", state: "update" } } },
      { name: "@thetis/exa", type: "tool", tools: ["exa_search"], version: "0.1.0", everyone: true, everyoneBy: "marked", source: { kind: "system" }, mine: true, state: "current", waiting: [], registry: null, config: { keys: 1, broken: false }, byUser: { root: { version: "0.1.0", state: "current" } }, description: "Web search." },
      { name: "@thetis/provider-openrouter", type: "provider", version: "0.3.0", source: { kind: "system" }, mine: false, state: "current", waiting: [], registry: null, config: { keys: 1, broken: true, summary: "apiKey is missing", missing: [{ key: "apiKey", state: "missing", missing: ["OPENROUTER_API_KEY"], source: "default" }] }, byUser: { _system: { version: "0.3.0", state: "current" } } },
    ],
    stats: { current: 2, updates: 1, installs: 0, waiting: 2, forks: 0, broken: 1 },
  };
  const ext = fakeExt({ fleet, "update-check": { updating: false } });
  const root = el("div");
  mountFleet(ext, root, { user: "root", mode: "simple" });
  await settled();
  const said = text(root);
  assert.match(said, /All extensions · 2 installed/, "the count is what is installed for the reader, the same as the place's");
  assert.match(said, /Every extension installed here/);
  assert.match(said, /TerminalBy Thetis · Tools|Terminalby Thetis · Tools/);
  assert.match(said, /Update available2 people haven't applied it yet\./);
  assert.match(said, /Exaby Thetis · ToolsFor everyone/, "an admin's mark carries For everyone; the configuration's own list does not");
  assert.match(said, /Web search\./, "What it does");
  assert.doesNotMatch(said, /OpenRouter|Provider Openrouter/, "only in Thetis itself: shown under everywhere, not in the count");
  const chips = all(root, (n) => n.tag === "span" && String(n.props.class ?? "").startsWith("badge"));
  assert.ok(chips.every((c) => c.props.title), "every chip has its tooltip");
  assert.ok(buttons(root).includes("Apply updates for 2 people"));
  assert.doesNotMatch(said, /reload|older code|◐|↻|fence|Update ready|Up to date·|set up/i, "no machinery words, no glyphs, no old badges");
  // Everywhere adds the rest, with the admin's own words for a problem only an admin fixes.
  const everywhere = all(root, (n) => n.tag === "button" && text(n) === "everywhere")[0];
  everywhere.props.onClick();
  const wide = text(root);
  assert.match(wide, /Provider Openrouterby Thetis · ModelsNeeds setup/);
  assert.match(wide, /OPENROUTER_API_KEY is not in the server's environment, so apiKey has no value\. Set it for everyone in Control panel → Extensions → Provider Openrouter → Settings\./);
});

test("Extensions by person: the system workspace's column is Thetis itself, and the table scrolls in its own box", async () => {
  const { mountFleet, SYSTEM_COLUMN } = await import("../ui/fleet.js");
  const fleet = { people: [{ user: "root" }], packages: [{ name: "@thetis/gateway-login", type: "gateway", version: "0.1.0", source: { kind: "system" }, state: "current", waiting: [], registry: null, config: null, scope: "system", byUser: { _system: { version: "0.1.0", state: "current" } } }], stats: {} };
  const ext = fakeExt({ fleet, "update-check": { updating: false } });
  const root = el("div");
  mountFleet(ext, root, { user: "root", mode: "full" });
  await settled();
  assert.equal(SYSTEM_COLUMN, "Thetis itself");
  const heads = all(root, (n) => n.tag === "th").map(text);
  assert.ok(heads.includes("Thetis itself") && !heads.includes("_system"), heads.join("|"));
  assert.ok(all(root, (n) => String(n.props.class ?? "").includes("ua-fl-scroll")).length === 1, "the table's own scroll box");
});

// The Overview draws its lineage as SVG through `document`; the fake DOM stands in for it on these pages.
globalThis.document ??= { createElementNS: (_ns, tag) => new FakeNode(tag), createTextNode: (t) => String(t), getElementById: () => null };

/** The answers an extension page reads, for one extension. */
function pageAnswers({ info, where, config = { package: info.name, broken: false, summary: "every key is set", keys: [] } }) {
  return { "package-info": info, "package-where": where, "config-show": config, "package-log": { commits: [] }, "package-readme": { text: null } };
}

test("an extension's page: the label, the publisher line and the chips; Remove for everyone names the people; Required has no Remove", async () => {
  const { mountPackagePage } = await import("../ui/package-page.js");
  const people = [{ user: "bitmuse", role: "admin", installed: true, version: "0.1.1" }, { user: "sam", role: "user", installed: true, version: "0.1.1" }];
  const notion = { name: "@thetis/notion", label: "Notion", version: "0.1.1", type: "tool", tools: ["notion_search"], description: "The Notion API.", everyone: true, everyoneBy: "promoted", source: { kind: "system", ref: "/data/packages/notion" }, promotedFrom: { name: "@bitmuse/notion", by: "bitmuse", at: "2026-09-24T10:00:00Z" }, registry: null, git: null, dependencies: [], dependents: [] };
  const ext = fakeExt(pageAnswers({ info: notion, where: { people, counts: { people: 2, installed: 2 } } }));
  let asked = null;
  ext.ui.confirm = async (_anchor, opts) => ((asked = opts), false);
  const root = el("div");
  mountPackagePage(ext, root, { name: "@thetis/notion", user: "sam" });
  await settled();
  const said = text(root);
  const title = all(root, (n) => n.tag === "h2")[0];
  assert.equal(text(title), "Notion");
  assert.equal(title.props.title, "@thetis/notion", "the raw id is the tooltip");
  assert.match(said, /by bitmuse · Tools/, "a shared copy is by the person it was shared from");
  assert.match(said, /For everyone/);
  assert.match(said, /Shared with everyone from @bitmuse\/notion by bitmuse on 2026-09-24/, "Provenance tells the truth");
  assert.doesNotMatch(said, /shipped with Thetis|Default for everyone|Up to date|set up/);
  assert.ok(buttons(root).includes("Remove for everyone…"));
  assert.ok(!buttons(root).includes("Turn on for everyone…") && !buttons(root).includes("Share with everyone…"), "a shared copy is neither turned on nor shared again");
  // The confirm names the people who lose it.
  all(root, (n) => n.tag === "button" && text(n) === "Remove for everyone…")[0].props.onClick();
  await settled();
  assert.deepEqual(asked.lines.find(([k]) => k === "people"), ["people", "bitmuse, sam"]);

  // Required by Thetis: no Remove of any kind, here or for one person.
  const core = { ...notion, name: "@thetis/harness-core", label: "harness core", type: "loader", everyoneBy: "config", promotedFrom: null, tools: [] };
  const ext2 = fakeExt(pageAnswers({ info: core, where: { people, counts: { people: 2, installed: 2 } } }));
  const root2 = el("div");
  mountPackagePage(ext2, root2, { name: "@thetis/harness-core", user: "bitmuse" });
  await settled();
  assert.match(text(root2), /Required by Thetis/);
  assert.ok(!buttons(root2).some((b) => /Remove/.test(b)), buttons(root2).join("|"));
});

test("an extension's page: Turn on and off for everyone, Share with everyone, and never a silent downgrade", async () => {
  const { mountPackagePage } = await import("../ui/package-page.js");
  const people = [{ user: "bitmuse", role: "admin", installed: true, version: "0.3.3-fork.1" }];
  const where = { people, counts: { people: 1, installed: 1 } };
  const exa = { name: "@thetis/exa", version: "0.1.0", type: "tool", tools: ["exa_search"], description: "", everyone: false, everyoneBy: null, source: { kind: "system", ref: "exa" }, registry: null, git: null, dependencies: [], dependents: [] };
  const draw = async (info, user = "bitmuse") => {
    const ext = fakeExt(pageAnswers({ info, where: { ...where, people: people.map((p) => ({ ...p, version: info.version })) } }));
    const root = el("div");
    mountPackagePage(ext, root, { name: info.name, user });
    await settled();
    return root;
  };
  assert.ok(buttons(await draw(exa)).includes("Turn on for everyone…"));
  assert.ok(buttons(await draw({ ...exa, everyone: true, everyoneBy: "marked" })).includes("Turn off for everyone…"));
  assert.match(text(await draw({ ...exa, everyone: true, everyoneBy: "config" })), /For everyone by the server's settings file/);
  // A person's own extension is shared, with the words the contract gives.
  const mine = { ...exa, name: "@bitmuse/moo", label: "moo", source: { kind: "local", ref: "packages/moo" } };
  assert.ok(buttons(await draw(mine)).includes("Share with everyone…"));
  assert.match(text(await draw({ ...mine, sharedAs: "@thetis/moo" })), /Already shared with everyone as Moo/);
  // A customised copy whose official version is newer: Update available, Use Thetis's version, and no Share.
  const copy = { ...exa, name: "@bitmuse/tool-exec", label: "tool exec", version: "0.3.3-fork.1", forkedFrom: { name: "@thetis/tool-exec", version: "0.3.3" }, fork: { name: "@thetis/tool-exec", version: "0.3.3", shipped: "0.4.1", identical: false, everyone: true }, source: { kind: "local", ref: "packages/tool-exec" } };
  const root = await draw(copy);
  const said = text(root);
  assert.match(said, /Update available/);
  assert.match(said, /Customized/);
  assert.match(said, /by you · Tools/);
  assert.match(said, /Your copy is older than Thetis's 0\.4\.1; sharing it would replace it for everyone\./);
  assert.ok(!buttons(root).includes("Share with everyone…"), "never a silent downgrade");
  assert.ok(buttons(root).includes("Use Thetis's version"));
});

test("the README tab reads this extension's own README, and says when its title names the extension it was shared from", async () => {
  const { mountReadme, writtenFor } = await import("../ui/package-readme.js");
  assert.equal(writtenFor("# @bitmuse/notion\n\nThe Notion API.", "@thetis/notion"), "@bitmuse/notion");
  assert.equal(writtenFor("# @thetis/notion", "@thetis/notion"), null);
  const ext = fakeExt({ "package-readme": (a) => ({ text: a.name === "@thetis/notion" ? "# @bitmuse/notion\n\nThe Notion API." : null }) });
  ext.markdown = (t) => [el("div", {}, t)];
  const root = el("div");
  mountReadme(ext, root, { name: "@thetis/notion", info: { promotedFrom: { name: "@bitmuse/notion" } } });
  await settled();
  assert.deepEqual(ext.calls.map((c) => c[1]?.name), ["@thetis/notion"], "the README asked for is this extension's own");
  assert.match(text(root), /written for @bitmuse\/notion, the extension this was shared from/);
});

test("Overview: a check that failed is said with Restart Thetis; the update card and the pending restart's Cancel are there when they should be", async () => {
  const { mountOverview } = await import("../ui/overview.js");
  const { createUpdateFlow } = await import("../ui/update-flow.js");
  const failing = fakeExt({ "update-check": STALE(), status: { daemon: { stale: false }, restart: null, workspaces: [] } });
  const flow = createUpdateFlow(failing, { store: null });
  const root = el("div");
  mountOverview(failing, root, { flow });
  await settled();
  assert.match(text(root), /The installation could not be read: part of Thetis needs a restart to load this page/);
  assert.ok(buttons(root).includes("Restart Thetis"));
  const incoming = [{ commit: "a1b2c3d", subject: "one button" }];
  const ok = fakeExt({ "update-check": { runtime: { branch: "main", commit: "8309ab0", upstream: "origin/main", behind: 1 }, packages: { commit: "dad30dc", pinned: "dad30dc" }, incoming, behind: true, dirty: false, stale: { daemon: false }, needs: { restart: true }, updating: false }, status: { daemon: { stale: false, startedAt: "2026-09-27T10:00:00Z" }, restart: { reason: "Update to fedcba9", by: "root" }, workspaces: [] } });
  const flow2 = createUpdateFlow(ok, { store: null });
  const root2 = el("div");
  mountOverview(ok, root2, { flow: flow2 });
  await settled();
  const said = text(root2);
  assert.match(said, /Thetis update available · 1 change/);
  assert.ok(buttons(root2).includes("Update and restart"), "the one button");
  assert.ok(buttons(root2).includes("Check for updates"));
  assert.ok(buttons(root2).includes("Cancel"), "a pending restart can be called off from the Overview");
  for (const gone of ["Update now", "Restart the daemon", "Reload 2 workspaces"]) assert.ok(!buttons(root2).some((b) => b.startsWith(gone.split(" ")[0] + " " + gone.split(" ")[1])), gone);
  assert.doesNotMatch(said, /projectRoot|systemPackagesDir|Kernel/, "the raw configuration moved to Advanced");
});

test("Activity: Thetis and the host are named in words, and the raw kind is a tooltip only with developer details on", async () => {
  const { mountActivity, nameOf } = await import("../ui/activity.js");
  assert.equal(nameOf("daemon"), "Thetis");
  assert.equal(nameOf("operator"), "the host");
  assert.equal(nameOf("bob"), "bob");
  const rows = [
    { at: "2026-09-27T01:07:34Z", kind: "daemon.stop", actor: "daemon", target: "daemon", data: {} },
    { at: "2026-09-27T01:07:18Z", kind: "fence.reload", actor: "operator", target: "user1", data: {} },
  ];
  for (const developer of [false, true]) {
    const ext = { ...fakeExt({ journal: rows }, { admin: false }), developer: () => developer };
    const root = el("div");
    mountActivity(ext, root, { role: "user" });
    await settled();
    const said = text(root);
    assert.match(said, /Thetis stopped/);
    assert.match(said, /Workspace restarted/);
    assert.doesNotMatch(said, /daemon|operator/, "the ids are said as words");
    assert.match(said, /the host/);
    const titles = all(root, (n) => typeof n.props?.title === "string").map((n) => n.props.title);
    assert.equal(titles.includes("fence.reload"), developer, "the raw kind only for a developer");
  }
});

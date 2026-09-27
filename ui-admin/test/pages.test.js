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

test("All extensions: the three words, who has not applied it, and one Apply button that reports every person", async () => {
  const { mountFleet } = await import("../ui/fleet.js");
  const fleet = {
    people: [{ user: "bob" }, { user: "root" }],
    packages: [
      { name: "@thetis/terminal", type: "tool", version: "0.2.0", state: "update", waiting: ["bob", "root"], registry: { version: "0.2.0", update: { apply: "reload", version: "0.2.0" } }, config: null, byUser: { bob: { version: "0.2.0", loaded: "0.1.0", state: "update" }, root: { version: "0.2.0", loaded: "0.1.0", state: "update" } } },
      { name: "@thetis/exa", type: "tool", version: "0.1.0", state: "current", waiting: [], registry: null, config: { keys: 1, broken: false }, byUser: { bob: { version: "0.1.0", state: "current" } } },
    ],
    stats: { current: 1, updates: 1, installs: 0, waiting: 2, forks: 0, broken: 0 },
  };
  const ext = fakeExt({ fleet, "update-check": { updating: false } });
  const root = el("div");
  mountFleet(ext, root, { user: "root", mode: "simple" });
  await settled();
  const said = text(root);
  assert.match(said, /Update ready2 people haven't applied it yet/);
  assert.match(said, /Up to date/);
  assert.ok(buttons(root).includes("Apply updates for 2 people"));
  assert.doesNotMatch(said, /reload|older code|◐|↻|fence/i, "no machinery words and no glyphs");
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

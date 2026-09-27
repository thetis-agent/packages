// The people and fleet commands over a fake operator: what each asks the kernel, how the answers fold
// into one package's "where it runs", the journal about it, the update and remove paths, and the matrix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as commands from "../fleet.js";
import { sentence } from "../ui/package-activity.js";

/** A package directory whose newest file is from `at`: what "older code" is measured against. */
function rootAt(at) {
  const dir = mkdtempSync(join(tmpdir(), "thetis-fleet-"));
  writeFileSync(join(dir, "index.js"), "export {};\n");
  const when = new Date(at);
  utimesSync(join(dir, "index.js"), when, when);
  utimesSync(dir, when, when);
  return dir;
}
// Every copy's files are from 14:00: root's workspace opened at 14:17, bob's at 05:27 (before them).
const CODE_AT = "2026-09-21T14:00:00.000Z";
const codeRoot = rootAt(CODE_AT);

const users = [
  { id: "root", role: "admin", status: "active" },
  { id: "bob", role: "user", status: "active" },
  { id: "sys", role: "system", status: "active" },
];

const terminal = { name: "@thetis/terminal", version: "0.1.0", type: "tool", description: "Shells.", everyone: true, root: codeRoot, source: { kind: "system", ref: "terminal" } };
const bobFork = { name: "@bob/terminal", version: "0.1.0-fork.1", type: "tool", description: "Shells.", forkedFrom: { name: "@thetis/terminal", version: "0.1.0" }, replaced: "@thetis/terminal", root: codeRoot, source: { kind: "local", ref: "packages/terminal" } };
const exa = { name: "@thetis/exa", version: "0.1.0", type: "tool", description: "Search.", everyone: false, root: codeRoot, source: { kind: "git", ref: "https://x/r.git#exa@0123456789abcdef" } };

/** An env whose operator answers from `answers` by method name and records every call. */
function fakeEnv(answers = {}, { user = "root", own = [terminal, exa] } = {}) {
  const calls = [];
  const env = {
    user,
    role: "admin",
    cwd: "/home/root",
    root: "/",
    readFile: async () => { throw new Error("no index"); },
    kernel: {
      packages: { list: async () => own, install: async (source) => ({ name: "@root/x", version: "1", source }) },
      operator: {
        call: async (method, args) => {
          calls.push({ method, args });
          if (answers[method] instanceof Error) throw answers[method];
          return typeof answers[method] === "function" ? answers[method](args) : answers[method] ?? null;
        },
      },
    },
  };
  return { env, calls };
}

const status = { workspaces: [{ user: "root", openedAt: "2026-09-21T14:17:00Z", codeAt: "2026-09-21T14:00:00Z", stale: false, services: ["@thetis/terminal"] }, { user: "bob", openedAt: "2026-09-21T05:27:00Z", codeAt: "2026-09-21T14:00:00Z", stale: true, services: [] }] };
const lists = { root: [terminal, exa], bob: [bobFork, exa] };

test("package-where: every person's copy, the workspace it runs in, the forks, and the counts", async () => {
  const { env, calls } = fakeEnv({
    "users.list": users,
    "packages.list": (a) => lists[a.user] ?? new Error("no such workspace"),
    status,
    "config.show": (a) => ({ package: a.name, broken: a.user === "bob", summary: a.user === "bob" ? "shell is required and not set" : "every key is set" }),
  });
  const out = await commands.packageWhere({ name: "@thetis/terminal" }, env);
  const { people, forks, counts } = out.data;
  assert.deepEqual(people.map((p) => p.user), ["root", "bob"], "the system account has no row");
  assert.deepEqual(people[0], { user: "root", role: "admin", status: "active", installed: true, version: "0.1.0", forkedFrom: null, replaced: null, source: { kind: "system", ref: "terminal" }, loaded: { openedAt: "2026-09-21T14:17:00Z", state: "current" }, services: ["@thetis/terminal"], config: { broken: false, summary: "every key is set" } });
  assert.equal(people[1].installed, true, "bob has it as the fork that replaced it");
  assert.equal(people[1].version, "0.1.0-fork.1");
  assert.deepEqual(people[1].forkedFrom, { name: "@thetis/terminal", version: "0.1.0" });
  assert.deepEqual(people[1].config, { broken: true, summary: "shell is required and not set" }, "the configuration is asked at bob's layer");
  assert.deepEqual(people[1].loaded, { openedAt: "2026-09-21T05:27:00Z", state: "current" }, "bob's copy is newer on disk, but a tool's code is read on every call: it is not behind");
  assert.deepEqual(forks, [{ user: "bob", name: "@bob/terminal", version: "0.1.0-fork.1" }]);
  assert.deepEqual(counts, { people: 2, installed: 2, waiting: 0, forks: 1, broken: 1 }, "bob has it as his own copy, with a broken key, and nobody waits to apply it");
  assert.deepEqual(calls.filter((c) => c.method === "config.show").map((c) => c.args), [{ name: "@thetis/terminal", user: "root" }, { name: "@bob/terminal", user: "bob" }], "config is read where the package is installed, under the fork's name for a fork");
  await assert.rejects(commands.packageWhere({ name: "nope" }, env), /looks like @scope\/name/);
});

test("package-activity: only the entries about the package, newest first, cut to the limit", async () => {
  const tail = [
    { at: "2026-09-20T10:00:00Z", kind: "package.install", actor: "root", target: "bob", data: { name: "@thetis/terminal" } },
    { at: "2026-09-21T05:27:01Z", kind: "service.start", target: "bob", data: { package: "@thetis/terminal" } },
    { at: "2026-09-21T06:00:00Z", kind: "package.promote", actor: "root", target: "bob", data: { name: "@bob/x", promoted: "@thetis/terminal" } },
    { at: "2026-09-21T07:00:00Z", kind: "config.set", actor: "root", target: "@thetis/terminal", data: { key: "shell" } },
    { at: "2026-09-21T08:00:00Z", kind: "package.install", actor: "root", target: "bob", data: { name: "@thetis/exa" } },
  ];
  const { env, calls } = fakeEnv({ "journal.tail": tail });
  const out = await commands.packageActivity({ name: "@thetis/terminal", limit: 3 }, env);
  assert.deepEqual(out.data.entries.map((e) => e.at), ["2026-09-21T07:00:00Z", "2026-09-21T06:00:00Z", "2026-09-21T05:27:01Z"]);
  assert.deepEqual(out.data.entries[0], { at: "2026-09-21T07:00:00Z", kind: "config.set", actor: "root", target: "@thetis/terminal", data: { key: "shell" } });
  assert.deepEqual(calls[0], { method: "journal.tail", args: { limit: 1000 } });
  const all = await commands.packageActivity({ name: "@thetis/terminal" }, env);
  assert.equal(all.data.entries.length, 4, "the exa install is not about this package");
});

/**
 * A fleet-wide install does not reach a person holding a fork of the package: the kernel refuses to put a
 * package over somebody's fork of it, and the sweep names them instead of stopping. The row is the only
 * durable record of that, so the sentence has to carry the names -- "installed for everyone" read months
 * later is otherwise a claim about the fleet that was never true.
 */
test("package-activity: a fleet-wide install says who it left alone, and why", () => {
  const forks = [{ user: "bob", fork: "@bob/gateway-web" }];
  assert.equal(
    sentence({ kind: "package.everyone", target: "@thetis/gateway-web", data: { userspaces: ["root"], forks } }),
    "turned @thetis/gateway-web on for everyone, except bob, who uses a copy of their own",
  );
  assert.equal(sentence({ kind: "package.everyone", target: "@thetis/gateway-web", data: { userspaces: ["root", "bob"] } }), "turned @thetis/gateway-web on for everyone");
  assert.equal(sentence({ kind: "package.everyone", target: "@thetis/gateway-web", data: { on: false } }), "turned @thetis/gateway-web off for everyone");
  assert.equal(
    sentence({ kind: "package.promote", target: "alice", data: { name: "@alice/gw", promoted: "@thetis/gw", userspaces: ["root"], forks } }),
    "shared @alice/gw with everyone as @thetis/gw for 1 workspace, except bob, who uses a copy of their own",
  );
});

test("package-update: a system package moves for everyone, a personal one in the admin's workspace; nothing to do is a refusal", async () => {
  // A fake marketplace is not reachable from here, so the paths that need it are exercised through a
  // package the index knows nothing about: the refusal is the sentence about the library or the registry.
  const { env } = fakeEnv({ "packages.installEveryone": { userspaces: ["root", "bob"] } });
  await assert.rejects(commands.packageUpdate({ name: "@thetis/terminal" }, env), /not installed here|not behind its registry/);
  await assert.rejects(commands.packageUpdate({ name: "@thetis/nope" }, env), /is not installed in your workspace|marketplace library/);
});

test("package-promote and package-install-for go through the operator; a system name cannot be promoted", async () => {
  const { env, calls } = fakeEnv({ "packages.promote": { name: "@thetis/moo", userspaces: ["root", "bob"] }, "packages.install": (a) => ({ name: a.source, version: "0.1.0" }) });
  assert.deepEqual(await commands.packagePromote({ name: "@bob/moo", user: "bob" }, env), { data: { name: "@thetis/moo", userspaces: ["root", "bob"] } });
  assert.deepEqual(calls[0], { method: "packages.promote", args: { user: "bob", name: "@bob/moo" } });
  await assert.rejects(commands.packagePromote({ name: "@thetis/moo", user: "bob" }, env), /already everyone's/);
  assert.deepEqual(await commands.packageInstallFor({ name: "@thetis/exa", user: "bob" }, env), { data: { name: "@thetis/exa", version: "0.1.0" } });
  assert.deepEqual(calls.at(-1), { method: "packages.install", args: { user: "bob", source: "@thetis/exa" } });
  await assert.rejects(commands.packageInstallFor({ name: "@thetis/exa", user: "Bob!" }, env), /user must be/);
});

test("package-remove: one person, or everyone who has it", async () => {
  const { env, calls } = fakeEnv({ "users.list": users, "packages.list": (a) => lists[a.user] ?? [] });
  assert.deepEqual(await commands.packageRemove({ name: "@thetis/exa", user: "bob" }, env), { data: { removed: ["bob"] } });
  assert.deepEqual(calls.at(-1), { method: "packages.uninstall", args: { user: "bob", name: "@thetis/exa" } });
  assert.deepEqual(await commands.packageRemove({ name: "@thetis/exa", user: "*" }, env), { data: { removed: ["root", "bob"] } });
  assert.deepEqual(await commands.packageRemove({ name: "@thetis/terminal", user: "*" }, env), { data: { removed: ["root"] } }, "bob has the fork, not the original");
});

test("fleet: one row per package with each person's copy, a fork standing in for its original, the scope and the counts", async () => {
  const { env } = fakeEnv({
    "users.list": users,
    "packages.list": (a) => (a.user === "_system" ? [{ name: "@thetis/gateway-login", version: "0.1.0", type: "service", description: "Sign in." }] : lists[a.user] ?? []),
    status,
    "config.list": (a) => (a.user === "bob" ? [{ package: "@bob/terminal", broken: true, keys: [{ key: "shell" }] }] : [{ package: "@thetis/terminal", broken: false, keys: [{ key: "shell" }] }, { package: "@thetis/exa", broken: true, keys: [{ key: "apiKey" }] }]),
  });
  const out = await commands.fleet({}, env);
  const { people: who, packages, stats } = out.data;
  assert.deepEqual(who, [{ user: "root", role: "admin", status: "active" }, { user: "bob", role: "user", status: "active" }]);
  assert.deepEqual(packages.map((p) => p.name), ["@bob/terminal", "@thetis/exa", "@thetis/gateway-login", "@thetis/terminal"]);
  const term = packages.find((p) => p.name === "@thetis/terminal");
  assert.equal(term.scope, "everyone");
  assert.equal(term.version, "0.1.0");
  assert.deepEqual(term.config, { broken: false, keys: 1, summary: "", missing: [] });
  assert.equal(term.mine, true, "root has the terminal itself");
  assert.equal(packages.find((p) => p.name === "@bob/terminal").mine, false, "bob's copy is not installed for root");
  assert.deepEqual(term.byUser.root, { version: "0.1.0", fork: false, forkOf: null, broken: false, loaded: null, state: "current" });
  assert.deepEqual(term.byUser.bob, { version: "0.1.0-fork.1", fork: true, forkOf: "@bob/terminal", broken: true, loaded: null, state: "current" }, "bob's own copy stands in for the original; its code is read per call, so it is not behind");
  assert.equal(term.state, "current");
  assert.deepEqual(term.waiting, []);
  const fork = packages.find((p) => p.name === "@bob/terminal");
  assert.equal(fork.scope, "some");
  assert.deepEqual(fork.byUser.bob, { version: "0.1.0-fork.1", fork: false, forkOf: "@thetis/terminal", broken: true, loaded: null, state: "current" });
  const login = packages.find((p) => p.name === "@thetis/gateway-login");
  assert.equal(login.scope, "system");
  assert.deepEqual(Object.keys(login.byUser), ["_system"]);
  assert.equal(packages.find((p) => p.name === "@thetis/exa").registry, null, "no index here");
  assert.deepEqual(term.byUser.root.loaded, null, "no fence loaded a version here, so nothing is behind the disk");
  assert.deepEqual(stats, { current: 4, updates: 0, installs: 0, waiting: 0, forks: 2, broken: 1 });
  assert.deepEqual(out.data.daemon, { state: "current" }, "a daemon on the code on disk needs no restart");
});

test("fleet: a workspace holding a version the disk has moved past is marked, counted, and given a reload row", async () => {
  // root's fence read 0.2.1 of skills-hybrid and 0.2.2 is on disk; bob's fence read the version it runs.
  const hybrid = (loadedVersion) => ({ name: "@thetis/skills-hybrid", version: "0.2.2", type: "loader", description: "Skills.", everyone: true, root: codeRoot, source: { kind: "system", ref: "skills-hybrid" }, ...(loadedVersion ? { loadedVersion } : {}) });
  const own = [hybrid("0.2.1")];
  const { env } = fakeEnv(
    {
      "users.list": users,
      "packages.list": (a) => (a.user === "root" ? own : a.user === "bob" ? [hybrid("0.2.2")] : []),
      status,
      "config.list": () => [],
    },
    { own }
  );
  const { packages, stats } = (await commands.fleet({}, env)).data;
  const row = packages.find((p) => p.name === "@thetis/skills-hybrid");
  assert.deepEqual(row.byUser.root, { version: "0.2.2", fork: false, forkOf: null, broken: false, loaded: "0.2.1", state: "update" });
  assert.deepEqual(row.byUser.bob.loaded, "0.2.2");
  assert.equal(row.byUser.bob.state, "current", "bob's workspace read what is on disk");
  assert.deepEqual(row.registry, { version: "0.2.2", update: { apply: "reload", version: "0.2.2" } }, "no index carries it, and it is still behind its own disk");
  assert.equal(row.state, "update");
  assert.deepEqual(row.waiting, ["root"], "root has not applied it yet");
  assert.equal(stats.waiting, 1, "one workspace has not applied what is on disk");
  assert.equal(stats.installs, 0, "nothing is behind a registry");
  assert.equal(stats.updates, 1);
});

test("drift: three words, from what a workspace reads once", async () => {
  const { copyState, readOnce } = commands;
  const space = { openedAt: "2026-09-21T05:27:00Z", services: ["@thetis/terminal"] };
  const newer = () => true;
  const older = () => false;
  // A version the workspace loaded that is not the one on disk: Update ready, whatever the kind of code.
  assert.equal(copyState({ name: "@thetis/exa", type: "tool", version: "0.2.0", loadedVersion: "0.1.0" }, space, { newer: older }), "update");
  // Files changed without a version bump: only code read once when the workspace opened is behind.
  assert.equal(copyState({ name: "@thetis/terminal", type: "tool", version: "0.1.0" }, space, { newer }), "update", "a service the workspace runs");
  assert.equal(copyState({ name: "@thetis/provider-openrouter", type: "provider", version: "0.3.0" }, space, { newer }), "update", "a provider");
  assert.equal(copyState({ name: "@thetis/exa", type: "tool", version: "0.1.0" }, space, { newer }), "current", "a tool's code is read on every call: never older");
  assert.equal(copyState({ name: "@thetis/terminal", type: "tool", version: "0.1.0", loadedVersion: "0.1.0" }, space, { newer: older }), "current");
  assert.equal(readOnce({ name: "@thetis/x", type: "ui" }, null), false);
  // The daemon alone is Restart needed.
  const { env } = fakeEnv({ "users.list": [], status: { daemon: { stale: true }, workspaces: [] }, "config.list": () => [] }, { own: [] });
  assert.deepEqual((await commands.fleet({}, env)).data.daemon, { state: "restart" });
});

test("fleet: the facts the one state reads -- label, what it brings, whose copy -- and where a shared copy came from", async () => {
  const notion = { name: "@thetis/notion", version: "0.1.1", type: "tool", description: "Notion.", everyone: true, everyoneBy: "promoted", root: codeRoot, source: { kind: "system", ref: "notion" }, thetis: { type: "tool", label: "Notion", tools: [{ name: "notion_search" }, { name: "notion_page_get" }], ui: { places: [{ id: "n" }] } } };
  const exaKeyed = { ...exa, thetis: { type: "tool", tools: [{ name: "exa_search" }] } };
  const own = [notion, exaKeyed];
  const { env, calls } = fakeEnv(
    {
      "users.list": users,
      "packages.list": (a) => (a.user === "root" ? own : []),
      status,
      "config.list": (a) => (a.user ? [] : [{ package: "@thetis/exa", broken: true, summary: "apiKey is missing", keys: [{ key: "apiKey", state: "missing", secret: true, value: "never sent", missing: ["EXA_API_KEY"], source: "default", help: "The Exa API key." }] }]),
      "journal.tail": (a) => (a.kind === "package.promote" ? [{ at: "2026-09-20T10:00:00Z", kind: "package.promote", actor: "root", data: { name: "@bitmuse/notion", promoted: "@thetis/notion" } }, { at: "2026-09-24T10:00:00Z", kind: "package.promote", actor: "root", data: { name: "@bitmuse/notion", promoted: "@thetis/notion" } }] : []),
    },
    { own }
  );
  const { packages } = (await commands.fleet({}, env)).data;
  const row = packages.find((p) => p.name === "@thetis/notion");
  assert.equal(row.label, "Notion");
  assert.deepEqual(row.tools, ["notion_search", "notion_page_get"]);
  assert.equal(row.pages, 1);
  assert.equal(row.everyoneBy, "promoted");
  assert.deepEqual(row.promotedFrom, { name: "@bitmuse/notion", by: "bitmuse", at: "2026-09-24T10:00:00Z", actor: "root" }, "the newest promotion speaks");
  assert.ok(calls.some((c) => c.method === "journal.tail" && c.args.kind === "package.promote"), "the journal is asked for promotions only");
  const keyed = packages.find((p) => p.name === "@thetis/exa");
  assert.deepEqual(keyed.config.missing, [{ key: "apiKey", state: "missing", missing: ["EXA_API_KEY"], source: "default", help: "The Exa API key.", secret: true }], "the missing key travels without its value");
});

test("package-everyone turns an extension by Thetis on for everyone by name, a registry one by its pinned source, and off by the mark", async () => {
  const { env, calls } = fakeEnv({ "packages.installEveryone": (a) => ({ name: a.source.startsWith("@") ? a.source : "@thetis/exa", userspaces: ["root", "bob"] }), "packages.unmarkEveryone": null }, { own: [terminal, exa, { name: "@root/mine", version: "1.0.0", type: "tool", description: "", root: codeRoot, source: { kind: "local", ref: "packages/mine" } }, { name: "@tg/nova", version: "0.3.0", type: "skill", description: "", root: codeRoot, source: { kind: "git", ref: "https://x/r.git#nova@0123456789abcdef" } }] });
  assert.deepEqual((await commands.packageEveryone({ name: "@thetis/terminal", on: true }, env)).data, { name: "@thetis/terminal", on: true, userspaces: ["root", "bob"] });
  assert.deepEqual(calls.at(-1), { method: "packages.installEveryone", args: { source: "@thetis/terminal" } });
  await commands.packageEveryone({ name: "@thetis/exa", on: true }, env);
  assert.deepEqual(calls.at(-1), { method: "packages.installEveryone", args: { source: "@thetis/exa" } }, "a @thetis name goes by name");
  await commands.packageEveryone({ name: "@tg/nova", on: true }, env);
  assert.deepEqual(calls.at(-1), { method: "packages.installEveryone", args: { source: "https://x/r.git#nova@0123456789abcdef" } }, "a registry's extension goes by the source it is pinned to, never one the browser sent");
  await assert.rejects(commands.packageEveryone({ name: "@root/mine", on: true }, env), /share it with everyone instead/);
  assert.deepEqual((await commands.packageEveryone({ name: "@thetis/terminal", on: false }, env)).data, { name: "@thetis/terminal", on: false });
  assert.deepEqual(calls.at(-1), { method: "packages.unmarkEveryone", args: { name: "@thetis/terminal" } });
});

test("package-unfork puts the admin's own copy back on its official version, and refuses anything else", async () => {
  const mine = { ...bobFork, name: "@root/terminal" };
  const { env } = fakeEnv({}, { own: [mine, exa] });
  env.kernel.packages.unfork = async (name) => ({ ...terminal, from: name });
  assert.deepEqual((await commands.packageUnfork({ name: "@root/terminal" }, env)).data, { name: "@thetis/terminal", version: "0.1.0", from: "@root/terminal" });
  await assert.rejects(commands.packageUnfork({ name: "@thetis/exa" }, env), /not a copy/);
  await assert.rejects(commands.packageUnfork({ name: "@bob/terminal" }, env), /not installed in your workspace/);
});

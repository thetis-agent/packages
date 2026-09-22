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
// Every copy's files are from 14:00: root's workspace opened at 14:17 (current), bob's at 05:27 (older code).
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
  assert.deepEqual(people[0], { user: "root", role: "admin", status: "active", installed: true, version: "0.1.0", forkedFrom: null, replaced: null, source: { kind: "system", ref: "terminal" }, loaded: { openedAt: "2026-09-21T14:17:00Z", codeAt: CODE_AT, stale: false }, services: ["@thetis/terminal"], config: { broken: false, summary: "every key is set" } });
  assert.equal(people[1].installed, true, "bob has it as the fork that replaced it");
  assert.equal(people[1].version, "0.1.0-fork.1");
  assert.deepEqual(people[1].forkedFrom, { name: "@thetis/terminal", version: "0.1.0" });
  assert.deepEqual(people[1].config, { broken: true, summary: "shell is required and not set" }, "the configuration is asked at bob's layer");
  assert.deepEqual(people[1].loaded, { openedAt: "2026-09-21T05:27:00Z", codeAt: CODE_AT, stale: true }, "bob's copy is newer on disk than his workspace");
  assert.deepEqual(forks, [{ user: "bob", name: "@bob/terminal", version: "0.1.0-fork.1" }]);
  assert.deepEqual(counts, { people: 2, installed: 2, stale: 1, forks: 1, broken: 1 }, "bob has it as his fork, on older code, with a broken key");
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
    "installed @thetis/gateway-web for everyone, except bob, who holds a fork of it",
  );
  assert.equal(sentence({ kind: "package.everyone", target: "@thetis/gateway-web", data: { userspaces: ["root", "bob"] } }), "installed @thetis/gateway-web for everyone");
  assert.equal(
    sentence({ kind: "package.promote", target: "alice", data: { name: "@alice/gw", promoted: "@thetis/gw", userspaces: ["root"], forks } }),
    "promoted @alice/gw to @thetis/gw for 1 workspace, except bob, who holds a fork of it",
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
  assert.deepEqual(term.config, { broken: false, keys: 1 });
  assert.deepEqual(term.byUser.root, { version: "0.1.0", fork: false, forkOf: null, stale: false, broken: false, loaded: null, behindDisk: false });
  assert.deepEqual(term.byUser.bob, { version: "0.1.0-fork.1", fork: true, forkOf: "@bob/terminal", stale: true, broken: true, loaded: null, behindDisk: false }, "bob's fork stands in for the original");
  const fork = packages.find((p) => p.name === "@bob/terminal");
  assert.equal(fork.scope, "some");
  assert.deepEqual(fork.byUser.bob, { version: "0.1.0-fork.1", fork: false, forkOf: "@thetis/terminal", stale: true, broken: true, loaded: null, behindDisk: false });
  const login = packages.find((p) => p.name === "@thetis/gateway-login");
  assert.equal(login.scope, "system");
  assert.deepEqual(Object.keys(login.byUser), ["_system"]);
  assert.equal(packages.find((p) => p.name === "@thetis/exa").registry, null, "no index here");
  assert.deepEqual(term.byUser.root.loaded, null, "no fence loaded a version here, so nothing is behind the disk");
  assert.equal(term.byUser.root.behindDisk, false);
  assert.deepEqual(stats, { current: 0, updates: 0, reloads: 0, forks: 2, broken: 1, stale: 1, unpushed: 0 });
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
  assert.deepEqual(row.byUser.root, { version: "0.2.2", fork: false, forkOf: null, stale: false, broken: false, loaded: "0.2.1", behindDisk: true });
  assert.deepEqual(row.byUser.bob.loaded, "0.2.2");
  assert.equal(row.byUser.bob.behindDisk, false, "bob's fence read what is on disk");
  assert.deepEqual(row.registry, { version: "0.2.2", update: { apply: "reload", version: "0.2.2" } }, "no index carries it, and it is still behind its own disk");
  assert.equal(stats.reloads, 1, "one workspace has not loaded what is on disk");
  assert.equal(stats.updates, 0, "nothing is behind a registry");
});

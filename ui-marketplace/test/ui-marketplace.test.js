// The commands over a fake env: the merge of what is installed with what the index offers, the update
// offer in the short form a person reads, what each verb refuses before anything is asked, and which
// operator method the admin verbs send. Then the browser modules: they parse, and the entry defines
// `install` and nothing else at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as commands from "../index.js";
import { mergeRows, withAhead, withUpdate } from "../lib/rows.js";
import { aheadBadge, forkBadge, publishRecord, updateBadge } from "../ui/badges.js";
import { blockerLines, passengersOf } from "../ui/actions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const REPO = "https://github.com/thetis-agent/packages.git";
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

const shipped = (name, extra = {}) => ({ name, version: "0.1.0", type: "tool", description: `${name} does things`, root: ROOT, thetis: { type: "tool", tools: [{ name: "t", description: "a tool" }] }, everyone: true, source: { kind: "system", ref: "/sys" }, ...extra });
const fromRegistry = (name, commit) => ({ name, version: "0.1.0", type: "tool", description: "", root: ROOT, thetis: { type: "tool" }, source: { kind: "git", ref: `${REPO}#${name.slice(8)}@${commit}` } });
const entry = (name, version, commit, extra = {}) => ({ name, version, type: "tool", description: `${name} from the registry`, keywords: ["k"], registry: "thetis", url: REPO, dir: name.slice(8), commit, source: `${REPO}#${name.slice(8)}@${commit}`, steps: [], tools: ["t"], service: false, ...extra });

/** An env with a shared directory holding `index`, `installed` behind the kernel, and an operator that records calls. */
function fakeEnv({ installed = [], index, readmes = {}, answers = {}, role = "user", user = "alice", reports = {}, effective = {}, tools = {} } = {}) {
  const shared = mkdtempSync(join(tmpdir(), "ui-market-"));
  mkdirSync(join(shared, "marketplace", "readme", "thetis"), { recursive: true });
  if (index) writeFileSync(join(shared, "marketplace", "index.json"), JSON.stringify(index));
  for (const [file, text] of Object.entries(readmes)) writeFileSync(join(shared, "marketplace", "readme", "thetis", file), text);
  const calls = [];
  const env = {
    user,
    role,
    shared,
    readFile: (p) => import("node:fs/promises").then((fs) => fs.readFile(p, "utf8")),
    // The seam a UI command runs another package's tool through, as the agent's env provides it: the ref
    // off that package's manifest, the args, and that package's effective configuration.
    invokeTool: async (ref, args, opts) => {
      calls.push({ method: "invokeTool", ref, args, config: opts.config, session: opts.session });
      const answer = tools[ref.name];
      if (answer === undefined) throw new Error(`no such tool: ${ref.name}`);
      return typeof answer === "function" ? answer(args) : answer;
    },
    kernel: {
      packages: {
        list: async () => installed,
        install: async (source) => {
          calls.push({ method: "install", source });
          return { ...shipped("@thetis/new"), everyone: false, source: { kind: "git", ref: source } };
        },
        uninstall: async (name) => calls.push({ method: "uninstall", name }),
        unfork: async (name, deleteFiles) => (calls.push({ method: "unfork", name, deleteFiles }), shipped("@thetis/gateway-web")),
        delete: async (name) => (calls.push({ method: "delete", name }), { name, path: "/p", restored: "@alice/old" }),
      },
      operator: {
        call: async (method, args) => {
          calls.push({ method, args });
          return typeof answers[method] === "function" ? answers[method](args) : (answers[method] ?? null);
        },
      },
      // The person's own configuration layer, as the fence RPC answers it: a report per package from `reports`.
      config: {
        show: async (name) => (calls.push({ method: "config.show", name }), reports[name] instanceof Error ? Promise.reject(reports[name]) : reports[name] ?? { package: name, inherits: [], keys: [], summary: "every key is set", broken: false }),
        set: async (name, key, value) => (calls.push({ method: "config.set", name, key, value }), reports[name] ?? { package: name, inherits: [], keys: [], summary: "every key is set", broken: false }),
        unset: async (name, key) => (calls.push({ method: "config.unset", name, key }), reports[name] ?? { package: name, inherits: [], keys: [], summary: "every key is set", broken: false }),
        // What a package's own code receives. A fence is one person's authority, so a package in it may
        // read another's: this is how the marketplace reaches the publishing package's targets.
        effective: async (name) => (calls.push({ method: "config.effective", name }), effective[name] ?? {}),
      },
    },
  };
  return { env, calls, cleanup: () => rmSync(shared, { recursive: true, force: true }) };
}

/** Runs `fn` with every console method and stderr write recorded, and answers what was written. */
async function captured(fn) {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, write: process.stderr.write };
  for (const m of ["log", "error", "warn", "info"]) console[m] = (...a) => lines.push(a.map(String).join(" "));
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  try {
    await fn();
  } finally {
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn, info: saved.info });
    process.stderr.write = saved.write;
  }
  return lines;
}

test("rows: installed first, then the registry's; a shared name learns its registry and whether it is behind", () => {
  const index = { version: 1, updatedAt: "2026-09-14T00:00:00.000Z", registries: [{ name: "thetis", url: REPO }], packages: [entry("@thetis/exa", "0.2.0", NEW), entry("@thetis/memo", "0.1.0", OLD)] };
  const rows = mergeRows([shipped("@thetis/harness-core"), fromRegistry("@thetis/exa", OLD)], index.packages, index);
  assert.deepEqual(rows.map((r) => [r.name, r.installed, r.available, r.scope]), [["@thetis/harness-core", true, false, "everyone"], ["@thetis/exa", true, true, "me"], ["@thetis/memo", false, true, null]]);
  const exa = rows[1];
  assert.equal(exa.pin, "1111111");
  assert.equal(exa.tip, "0.2.0");
  assert.equal(exa.registry, "thetis");
  assert.deepEqual(exa.update, { apply: "install", version: "0.2.0", from: "1111111", to: "2222222", registry: "thetis", source: `${REPO}#exa@${NEW}` }, "short commits, because a person reads them");
  assert.equal(exa.description, "@thetis/exa from the registry", "the registry's description fills an empty one");
  assert.equal(rows[0].update, null, "a shipped package has no pin and is never behind");
  assert.equal(rows[0].license, "MIT", "the installed copy's package.json says the license");
  assert.deepEqual(rows[0].tools, [{ name: "t", description: "a tool" }]);
  assert.deepEqual(rows[2].tools, [{ name: "t", description: "" }], "the index knows names only");
  assert.equal(withUpdate({ name: "x" }, undefined).update, undefined, "nothing newer says nothing");
});

test("rows: a copy the workspace has not loaded is behind its own disk, index or no index, and the badge says reload", () => {
  const badge = (text, tone) => ({ text, tone });
  // The fence read 0.2.1 when it opened; the files on disk are 0.2.2. Nothing is fetched: a reload applies it.
  const loaded = { ...shipped("@thetis/skills-hybrid"), version: "0.2.2", loadedVersion: "0.2.1" };
  const bare = mergeRows([loaded], [], undefined);
  assert.deepEqual(bare[0].update, { apply: "reload", version: "0.2.2", installed: "0.2.1", available: "0.2.2" }, "no index is needed: a shipped package is behind its own disk");
  assert.deepEqual(updateBadge(badge, bare[0]), { text: "reload to 0.2.2", tone: "warn" });
  const index = { version: 1, updatedAt: "2026-09-21T00:00:00.000Z", registries: [{ name: "thetis", url: REPO }], packages: [entry("@thetis/skills-hybrid", "0.2.2", NEW)] };
  const listed = mergeRows([loaded], index.packages, index);
  assert.deepEqual(listed[0].update, { apply: "reload", version: "0.2.2", installed: "0.2.1", available: "0.2.2" }, "an index entry does not change what applies it");
  assert.equal(listed[0].registry, "thetis", "the row still learns the registry's word");
  // A stale pin and a different loaded version at once: the install wins, because it brings the pin and reopens.
  const both = mergeRows([{ ...fromRegistry("@thetis/exa", OLD), version: "0.2.0", loadedVersion: "0.1.0" }], [entry("@thetis/exa", "0.2.0", NEW)], { ...index, packages: [entry("@thetis/exa", "0.2.0", NEW)] });
  assert.equal(both[0].update.apply, "install");
  assert.deepEqual(updateBadge(badge, both[0]), { text: "update to 0.2.0", tone: "warn" });
  const current = mergeRows([{ ...shipped("@thetis/terminal"), loadedVersion: "0.1.0" }], [], undefined);
  assert.equal(current[0].update, null, "the version it loaded is the version on disk: nothing is behind");
  assert.equal(updateBadge(badge, current[0]), null);
});

test("duplicate registry names keep the newest entry's version, source and README together", async () => {
  const older = entry("@alice/widget", "1.0.0", OLD, { registry: "old", readme: true, source: `https://example.com/old.git#widget@${OLD}`, dir: "widget" });
  const newer = entry("@alice/widget", "2.0.0", NEW, { registry: "new", readme: true, source: `https://example.com/new.git#widget@${NEW}`, dir: "widget" });
  for (const packages of [[older, newer], [newer, older]]) {
    const index = { version: 1, registries: [], packages };
    const { env, cleanup } = fakeEnv({ index });
    try {
      for (const item of packages) {
        const dir = join(env.shared, "marketplace", "readme", item.registry);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "widget.md"), `# ${item.version}`);
      }
      const { data } = await commands.show({ name: "@alice/widget" }, env);
      assert.equal(data.row.version, "2.0.0");
      assert.equal(data.row.tip, "2.0.0");
      assert.equal(data.row.source, newer.source);
      assert.equal(data.row.registry, newer.registry);
      assert.equal(data.readme, "# 2.0.0");
    } finally {
      cleanup();
    }
  }
});

test("rows: a fork carries what it was forked from and how far that has moved, and the badges say the strongest true thing", () => {
  const badge = (text, tone) => ({ text, tone });
  const forkOf = (fork) => ({ ...shipped("@alice/gateway-web", { everyone: false }), version: "0.1.1-fork.1", forkedFrom: { name: fork.name, version: fork.version }, fork });
  // The live shape: the fork changed nothing, and the package it copied is what is shipped. No version
  // anywhere shows it, which is why the badge has to say it in words.
  const same = mergeRows([forkOf({ name: "@thetis/gateway-web", version: "0.1.1", shipped: "0.1.1", identical: true })], [], undefined);
  assert.deepEqual(same[0].update, { apply: "unfork", version: "0.1.1", installed: "0.1.1", available: "0.1.1", origin: "@thetis/gateway-web", identical: true });
  assert.deepEqual(updateBadge(badge, same[0]), { text: "identical to what is shipped", tone: "warn" }, "terse: this one also rides on a gallery card beside the name");
  assert.deepEqual(forkBadge(badge, same[0]), { text: "identical to @thetis/gateway-web 0.1.1, which is shipped", tone: "warn" });
  const moved = mergeRows([forkOf({ name: "@thetis/gateway-web", version: "0.1.1", shipped: "0.2.0" })], [], undefined);
  assert.deepEqual(updateBadge(badge, moved[0]), { text: "0.2.0 is shipped now", tone: "warn" });
  assert.deepEqual(forkBadge(badge, moved[0]), { text: "fork of @thetis/gateway-web 0.1.1 · 0.2.0 is shipped now", tone: "warn" });
  const working = mergeRows([forkOf({ name: "@thetis/gateway-web", version: "0.1.1", shipped: "0.1.1" })], [], undefined);
  assert.equal(working[0].update, null, "a fork that differs from the current origin is doing its job");
  assert.deepEqual(forkBadge(badge, working[0]), { text: "fork of @thetis/gateway-web 0.1.1", tone: "warn" });
  // The origin is what everyone on this host gets, and the person holding the fork is the one it could not
  // be made the default for: the kernel refuses to install a package over somebody's fork of it. The badge
  // is where that decision reaches them, so it rides on whichever sentence wins rather than replacing one.
  const house = mergeRows([forkOf({ name: "@thetis/gateway-web", version: "0.1.1", shipped: "0.2.0", everyone: true })], [], undefined);
  assert.deepEqual(forkBadge(badge, house[0]), { text: "fork of @thetis/gateway-web 0.1.1 · 0.2.0 is shipped now · everyone else gets that one", tone: "warn" });
  const houseSame = mergeRows([forkOf({ name: "@thetis/gateway-web", version: "0.1.1", shipped: "0.1.1", identical: true, everyone: true })], [], undefined);
  assert.deepEqual(forkBadge(badge, houseSame[0]), { text: "identical to @thetis/gateway-web 0.1.1, which is shipped · everyone else gets that one", tone: "warn" });

  // A row from a kernel that does not answer with `fork` still says what the manifest said, and no more.
  const old = mergeRows([{ ...shipped("@alice/thing", { everyone: false }), forkedFrom: { name: "@thetis/thing", version: "0.1.0" } }], [], undefined);
  assert.equal(old[0].fork, null);
  assert.deepEqual(forkBadge(badge, old[0]), { text: "fork of @thetis/thing 0.1.0", tone: "warn" });
});

test("search: no index answers the installed rows and says so; a query narrows through the index and the installed names", async () => {
  const bare = fakeEnv({ installed: [shipped("@thetis/harness-core")] });
  try {
    const { data } = await commands.search({}, bare.env);
    assert.equal(data.indexed, false);
    assert.equal(data.updatedAt, null);
    assert.deepEqual(data.rows.map((r) => r.name), ["@thetis/harness-core"]);
    assert.deepEqual([data.user, data.role], ["alice", "user"]);
  } finally {
    bare.cleanup();
  }
  const index = { version: 1, updatedAt: "2026-09-14T00:00:00.000Z", registries: [{ name: "thetis", url: REPO }], packages: [entry("@thetis/exa", "0.2.0", NEW, { keywords: ["web", "search"] }), entry("@thetis/memo", "0.1.0", OLD, { type: "memory" })] };
  const t = fakeEnv({ installed: [shipped("@thetis/harness-core")], index });
  try {
    const all = (await commands.search({}, t.env)).data;
    assert.equal(all.total, 2);
    assert.deepEqual(all.registries.map((r) => r.name), ["thetis"]);
    assert.deepEqual(all.rows.map((r) => r.name), ["@thetis/harness-core", "@thetis/exa", "@thetis/memo"]);
    assert.deepEqual((await commands.search({ q: "web" }, t.env)).data.rows.map((r) => r.name), ["@thetis/exa"], "a keyword matches through the index");
    assert.deepEqual((await commands.search({ q: "harness" }, t.env)).data.rows.map((r) => r.name), ["@thetis/harness-core"], "an installed name matches without the index");
    assert.deepEqual((await commands.search({ type: "memory" }, t.env)).data.rows.map((r) => r.name), ["@thetis/memo"]);
    assert.deepEqual((await commands.search({ type: "tool" }, t.env)).data.rows.map((r) => r.name), ["@thetis/harness-core", "@thetis/exa"]);
  } finally {
    t.cleanup();
  }
});

test("show: the row with its README copy, null without one; an unknown name is refused", async () => {
  const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
  const index = {
    version: 1,
    updatedAt: "2026-09-14T00:00:00.000Z",
    registries: [{ name: "thetis", url: REPO }],
    packages: [entry("@thetis/exa", "0.2.0", NEW, { readme: true, readmeAssets: ["bench/s-v1/chart.svg", "img/logo.png", "lost.svg"] }), entry("@thetis/memo", "0.1.0", OLD)],
  };
  const t = fakeEnv({ index, readmes: { "exa.md": "# exa\n\n![chart](bench/s-v1/chart.svg)\n", "exa__bench__s-v1__chart.svg": svg, "exa__img__logo.png": "AAEC" }, role: "admin", user: "root" });
  try {
    const page = (await commands.show({ name: "@thetis/exa" }, t.env)).data;
    assert.equal(page.readme, "# exa\n\n![chart](bench/s-v1/chart.svg)\n");
    assert.equal(page.row.readme, true);
    // The pictures the README shows come with it, keyed as written; one whose copy is gone is left out.
    assert.deepEqual(page.assets, { "bench/s-v1/chart.svg": { type: "image/svg+xml", data: svg }, "img/logo.png": { type: "image/png", data: "AAEC" } });
    assert.deepEqual([page.user, page.role], ["root", "admin"]);
    const memo = (await commands.show({ name: "@thetis/memo" }, t.env)).data;
    assert.equal(memo.readme, null);
    assert.deepEqual(memo.assets, {});
    await assert.rejects(commands.show({ name: "@thetis/nope" }, t.env), /not installed here and no registry offers it/);
    await assert.rejects(commands.show({ name: "nope" }, t.env), /looks like @scope\/name/);
  } finally {
    t.cleanup();
  }
});

test("install, remove, delete and update go through the person's own packages; update refuses what is not behind", async () => {
  const index = { version: 1, updatedAt: "2026-09-14T00:00:00.000Z", registries: [{ name: "thetis", url: REPO }], packages: [entry("@thetis/exa", "0.2.0", NEW), entry("@thetis/memo", "0.1.0", OLD)] };
  const t = fakeEnv({ installed: [fromRegistry("@thetis/exa", OLD), fromRegistry("@thetis/memo", OLD)], index });
  try {
    const installed = (await commands.install({ source: "@thetis/exa" }, t.env)).data;
    assert.equal(installed.name, "@thetis/new");
    assert.equal(installed.reinstalled, false);
    await assert.rejects(commands.install({}, t.env), /source is required/);
    assert.deepEqual((await commands.remove({ name: "@thetis/exa" }, t.env)).data, { name: "@thetis/exa" });
    assert.equal((await commands.del({ name: "@alice/mine" }, t.env)).data.restored, "@alice/old");
    const updated = (await commands.update({ name: "@thetis/exa" }, t.env)).data;
    assert.deepEqual([updated.from, updated.to], ["1111111", "2222222"]);
    await assert.rejects(commands.update({ name: "@thetis/memo" }, t.env), /not behind its registry/);
    await assert.rejects(commands.update({ name: "@thetis/nope" }, t.env), /not installed here/);
    assert.deepEqual(
      t.calls.map((c) => c.method + ":" + (c.source ?? c.name)),
      ["install:@thetis/exa", "uninstall:@thetis/exa", "delete:@alice/mine", `install:${REPO}#exa@${NEW}`],
      "an update is an install of the newer pinned source"
    );
  } finally {
    t.cleanup();
  }
});

test("unfork goes through the person's own packages and keeps the fork's files", async () => {
  const t = fakeEnv({ installed: [{ ...shipped("@alice/gateway-web", { everyone: false }), forkedFrom: { name: "@thetis/gateway-web", version: "0.1.1" } }] });
  try {
    assert.equal((await commands.unfork({ name: "@alice/gateway-web" }, t.env)).data.name, "@thetis/gateway-web");
    await assert.rejects(commands.unfork({ name: "not a package" }, t.env), /a package name looks like/);
    // No second argument: this page never deletes a person's own work, and Delete is where that lives.
    assert.deepEqual(t.calls, [{ method: "unfork", name: "@alice/gateway-web", deleteFiles: undefined }]);
  } finally {
    t.cleanup();
  }
});

test("fence-reload names the person who sent it and nobody else", async () => {
  const t = fakeEnv({ user: "alice", answers: { "fence.reload": (a) => ({ user: a.user, services: ["@thetis/gateway-web"] }) } });
  try {
    assert.deepEqual((await commands.fenceReload({}, t.env)).data, { user: "alice", services: ["@thetis/gateway-web"] });
    // The browser cannot ask for anyone else's: the id comes from the fence, so an argument is ignored.
    await commands.fenceReload({ user: "bob" }, t.env);
    assert.deepEqual(t.calls, [
      { method: "fence.reload", args: { user: "alice" } },
      { method: "fence.reload", args: { user: "alice" } },
    ]);
  } finally {
    t.cleanup();
  }
});

test("the admin verbs send one operator method each, with the arguments checked first", async () => {
  const t = fakeEnv({
    role: "admin",
    user: "root",
    answers: {
      "packages.installEveryone": { name: "@thetis/exa", userspaces: ["alice", "bob"] },
      "packages.install": (a) => ({ ...shipped(a.source), everyone: false }),
      "packages.promote": { name: "@thetis/hello", userspaces: ["alice"] },
      "users.list": [{ id: "root", role: "admin", status: "active" }, { id: "_system", role: "system", status: "active" }, { id: "bob", role: "user", status: "active" }],
    },
  });
  try {
    assert.deepEqual((await commands.installEveryone({ source: "@thetis/exa" }, t.env)).data, { name: "@thetis/exa", userspaces: ["alice", "bob"] });
    assert.equal((await commands.installFor({ user: "bob", source: "@thetis/exa" }, t.env)).data.scope, "me");
    assert.deepEqual((await commands.removeFor({ user: "bob", name: "@thetis/exa" }, t.env)).data, { user: "bob", name: "@thetis/exa" });
    assert.equal((await commands.promote({ user: "alice", name: "@alice/hello" }, t.env)).data.name, "@thetis/hello");
    assert.deepEqual((await commands.people({}, t.env)).data, [{ id: "root", role: "admin", status: "active" }, { id: "bob", role: "user", status: "active" }], "the system user is not a person to install for");
    assert.deepEqual(t.calls, [
      { method: "packages.installEveryone", args: { source: "@thetis/exa" } },
      { method: "packages.install", args: { user: "bob", source: "@thetis/exa" } },
      { method: "packages.uninstall", args: { user: "bob", name: "@thetis/exa" } },
      { method: "packages.promote", args: { user: "alice", name: "@alice/hello" } },
      { method: "users.list", args: {} },
    ]);
    await assert.rejects(commands.installFor({ user: "Bob!", source: "x" }, t.env), /user must be/);
    await assert.rejects(commands.promote({ user: "alice", name: "hello" }, t.env), /looks like @scope\/name/);
    await assert.rejects(commands.installEveryone({}, t.env), /source is required/);
  } finally {
    t.cleanup();
  }
});

test("config-show, config-set and config-unset go to the person's own layer; config-list folds the installed packages' sentences", async () => {
  const broken = { package: "@thetis/exa", inherits: [], keys: [{ key: "apiKey", state: "missing", secret: true, declared: true, required: true }], summary: "apiKey is required and not set", broken: true };
  const t = fakeEnv({ installed: [shipped("@thetis/harness-core"), shipped("@thetis/exa"), shipped("@thetis/gone")], reports: { "@thetis/exa": broken, "@thetis/gone": new Error("not-found") } });
  const secret = "exa-key-hunter2-never-logged";
  try {
    const lines = await captured(async () => {
      assert.deepEqual((await commands.configShow({ name: "@thetis/exa" }, t.env)).data, broken);
      assert.equal((await commands.configSet({ name: "@thetis/exa", key: "apiKey", value: secret }, t.env)).data.package, "@thetis/exa");
      assert.equal((await commands.configSet({ name: "@thetis/exa", key: "defaults", value: { numResults: 5 } }, t.env)).data.package, "@thetis/exa");
      assert.equal((await commands.configUnset({ name: "@thetis/exa", key: "apiKey" }, t.env)).data.package, "@thetis/exa");
      assert.deepEqual((await commands.configList({}, t.env)).data, [
        { package: "@thetis/harness-core", summary: "every key is set", broken: false },
        { package: "@thetis/exa", summary: "apiKey is required and not set", broken: true },
      ], "one sentence per installed package; one the kernel cannot report on is left out");
      await assert.rejects(commands.configShow({ name: "exa" }, t.env), /looks like @scope\/name/);
      await assert.rejects(commands.configSet({ name: "@thetis/exa", key: "api key", value: secret }, t.env), /a configuration key is a word/);
      await assert.rejects(commands.configSet({ name: "@thetis/exa", key: "apiKey" }, t.env), /needs a value; config-unset removes one/);
      await assert.rejects(commands.configSet({ name: "@thetis/exa", key: "apiKey", value: null }, t.env), /needs a value/);
      await assert.rejects(commands.configUnset({ name: "@thetis/exa" }, t.env), /a configuration key is a word/);
    });
    assert.deepEqual(t.calls, [
      { method: "config.show", name: "@thetis/exa" },
      { method: "config.set", name: "@thetis/exa", key: "apiKey", value: secret },
      { method: "config.set", name: "@thetis/exa", key: "defaults", value: { numResults: 5 } },
      { method: "config.unset", name: "@thetis/exa", key: "apiKey" },
      { method: "config.show", name: "@thetis/harness-core" },
      { method: "config.show", name: "@thetis/exa" },
      { method: "config.show", name: "@thetis/gone" },
    ], "a refused call never reaches the kernel, and nothing goes through the operator");
    assert.deepEqual(lines, [], "nothing is written to the console or stderr, so no value can be");
    const err = await commands.configSet({ name: "@thetis/exa", key: "bad key", value: secret }, t.env).then(() => null, (e) => e);
    assert.ok(err && !String(err.message).includes(secret), "a refusal never echoes the value");
  } finally {
    t.cleanup();
  }
});

test("the configuration form is the same file as @thetis/ui-admin's, because a page may import only its own", () => {
  const twin = join(ROOT, "..", "ui-admin", "ui", "config-form.js");
  if (!existsSync(twin)) return;
  assert.equal(readFileSync(join(ROOT, "ui", "config-form.js"), "utf8"), readFileSync(twin, "utf8"), "packages/ui-marketplace/ui/config-form.js has drifted from packages/ui-admin/ui/config-form.js: copy one over the other");
});

test("the browser modules parse, and the entry defines install and nothing else", () => {
  const ui = join(ROOT, "ui");
  for (const file of readdirSync(ui).filter((f) => f.endsWith(".js"))) {
    const out = spawnSync(process.execPath, ["--check", join(ui, file)], { encoding: "utf8" });
    assert.equal(out.status, 0, `${file}: ${out.stderr}`);
  }
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as m from ${JSON.stringify("file://" + join(ui, "index.js"))}; console.log(JSON.stringify(Object.keys(m)));`], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), ["default"]);
});

// ---- ahead: the work that is here and nowhere else ----

test("rows: a version newer here than the registry holds is unpublished work, and the badge says it short", () => {
  const badge = (text, tone) => ({ text, tone });
  const index = { version: 1, updatedAt: "2026-09-22T00:00:00.000Z", registries: [{ name: "thetis", url: REPO }], packages: [entry("@thetis/exa", "0.2.0", NEW)] };
  const rows = mergeRows([{ ...shipped("@thetis/exa"), version: "0.3.0" }], index.packages, index);
  assert.deepEqual(rows[0].ahead, { state: "ahead", version: "0.3.0", published: "0.2.0", registry: "thetis" });
  assert.deepEqual(aheadBadge(badge, rows[0]), { text: "0.3.0 here, 0.2.0 published", tone: "warn" }, "a gap between what runs here and what anybody else can get");
  // The index does not carry it. Said as the fact about the index that it is, and not as "never
  // published", which is a claim about the world the index cannot make: it is built from the registries
  // this installation mirrors, and a package can sit in one nobody here trusts.
  const mine = mergeRows([shipped("@thetis/package-publish")], index.packages, index);
  assert.deepEqual(mine[0].ahead, { state: "unpublished", version: "0.1.0", published: "", registry: "" });
  assert.deepEqual(aheadBadge(badge, mine[0]), { text: "no registry here lists it", tone: "dim" }, "quiet: on a maintainer's machine this is true of nearly every package at once");
  // Caught up, and a row the index only offers: nothing to say either way.
  const level = mergeRows([{ ...shipped("@thetis/exa"), version: "0.2.0" }], index.packages, index);
  assert.equal(level[0].ahead, null);
  assert.equal(aheadBadge(badge, level[0]), null);
  assert.equal(mergeRows([], index.packages, index)[0].ahead, null, "a package that is only offered here is nobody's unpublished work");
  assert.equal(withAhead({ name: "x" }, undefined).ahead, undefined, "nothing ahead says nothing");
});

test("rows: 0.10.0 is ahead of 0.9.0, and a fork is never listed as unpublished", () => {
  const index = { version: 1, updatedAt: "", registries: [{ name: "thetis", url: REPO }], packages: [entry("@thetis/exa", "0.9.0", NEW)] };
  assert.equal(mergeRows([{ ...shipped("@thetis/exa"), version: "0.10.0" }], index.packages, index)[0].ahead.published, "0.9.0", "compared as versions, not as text");
  assert.equal(mergeRows([{ ...shipped("@thetis/exa"), version: "0.9.0" }], index.packages, index)[0].ahead, null);
  // A fork is by construction a package no registry holds. It already has a fork badge saying what it was
  // copied from and how that package stands now; a second badge calling it unpublished would be the same
  // package shouting twice, and the fork badge is the one worth reading.
  const fork = { ...shipped("@alice/gateway-web", { everyone: false }), version: "0.1.1-fork.1", fork: { name: "@thetis/gateway-web", version: "0.1.1", shipped: "0.2.0" } };
  assert.equal(mergeRows([fork], index.packages, index)[0].ahead, null);
});

// ---- publishing: a soft dependency on @thetis/package-publish ----

/** The publishing package as the kernel lists it, with the three tools its manifest declares. */
const publisher = () => ({
  name: "@thetis/package-publish",
  version: "0.1.0",
  type: "tool",
  description: "publishes packages",
  root: ROOT,
  everyone: false,
  source: { kind: "system", ref: "/sys" },
  thetis: {
    type: "tool",
    tools: [
      { name: "publish_targets", description: "where this workspace may publish", export: "publishTargets" },
      { name: "publish_package", description: "publish one package", export: "publishPackage" },
      { name: "unpublish_package", description: "take one package out of a registry", export: "unpublishPackage" },
    ],
  },
});

/** The same package before removal was a verb: the page must draw no button for a tool that is not there. */
const olderPublisher = () => {
  const p = publisher();
  return { ...p, thetis: { ...p.thetis, tools: p.thetis.tools.filter((t) => t.name !== "unpublish_package") } };
};

const TARGETS = [{ name: "thetis", url: "git@github.com:thetis-agent/packages.git" }];

test("publish-targets: no publishing package, or no target configured, is an answer and not a failure", async () => {
  // The case almost every installation is in, for ever. Nothing is imported, nothing is declared as a
  // dependency, nothing throws, and the page simply does not draw the action.
  const bare = fakeEnv({ installed: [shipped("@thetis/exa")] });
  try {
    assert.deepEqual(await commands.publishTargets({}, bare.env), { data: { available: false, targets: [] } });
    assert.deepEqual(bare.calls, [], "nothing is asked of a package that is not there");
  } finally {
    bare.cleanup();
  }
  const silent = fakeEnv({ installed: [shipped("@thetis/exa"), publisher()], effective: { "@thetis/package-publish": { targets: [] } } });
  try {
    assert.deepEqual(await commands.publishTargets({}, silent.env), { data: { available: false, targets: [] } });
    assert.ok(!silent.calls.some((c) => c.method === "invokeTool"), "the configuration decides it, before any tool runs");
  } finally {
    silent.cleanup();
  }
});

test("publish-targets: the tool runs under its own package with its own effective configuration", async () => {
  const t = fakeEnv({
    installed: [shipped("@thetis/exa"), publisher()],
    effective: { "@thetis/package-publish": { targets: TARGETS, workDir: "publish" } },
    tools: { publish_targets: { targets: [{ name: "thetis", url: TARGETS[0].url, holds: "0.2.0" }] } },
  });
  try {
    const out = await commands.publishTargets({ package: "@thetis/exa" }, t.env);
    assert.equal(out.data.available, true);
    assert.deepEqual(out.data.targets, [{ name: "thetis", url: TARGETS[0].url, holds: "0.2.0" }], "what the tool reports wins over the bare configuration");
    const invoked = t.calls.find((c) => c.method === "invokeTool");
    assert.deepEqual(invoked.ref, { package: "@thetis/package-publish", export: "publishTargets", name: "publish_targets" }, "the export comes off the installed manifest, not from a copy kept here");
    assert.deepEqual(invoked.args, { package: "@thetis/exa" });
    assert.deepEqual(invoked.config, { targets: TARGETS, workDir: "publish" }, "the tool's package's configuration, not this one's");
    assert.equal(invoked.session.user, "alice");
  } finally {
    t.cleanup();
  }
});

test("publish-targets: a registry that cannot be reached still leaves the action offered, with what went wrong", async () => {
  const t = fakeEnv({
    installed: [publisher()],
    effective: { "@thetis/package-publish": { targets: TARGETS } },
    tools: { publish_targets: () => { throw new Error("ssh: Could not resolve hostname github.com"); } },
  });
  try {
    const out = await commands.publishTargets({}, t.env);
    assert.equal(out.data.available, true, "the configured targets are still true");
    assert.deepEqual(out.data.targets, [{ name: "thetis", url: TARGETS[0].url, branch: null }]);
    assert.match(out.data.error, /Could not resolve hostname/);
  } finally {
    t.cleanup();
  }
});

test("publish: the dry run and the publish are the same call, and a bad version never reaches the tool", async () => {
  const t = fakeEnv({
    installed: [shipped("@thetis/exa"), publisher()],
    effective: { "@thetis/package-publish": { targets: TARGETS } },
    tools: { publish_package: (args) => ({ package: args.package, target: args.to, was: "0.2.0", now: "0.3.0", first: false, commit: "abc1234def", branch: "main" }) },
  });
  try {
    const dry = await commands.publish({ name: "@thetis/exa", to: "thetis", bump: "minor", dryRun: true }, t.env);
    assert.equal(dry.data.dryRun, true);
    assert.equal(dry.data.now, "0.3.0", "the page shows the old and the new version from this, not from arithmetic of its own");
    assert.deepEqual(t.calls.find((c) => c.method === "invokeTool").args, { package: "@thetis/exa", to: "thetis", bump: "minor", dryRun: true });
    const real = await commands.publish({ name: "@thetis/exa", to: "thetis", bump: "minor" }, t.env);
    assert.equal(real.data.dryRun, false);
    assert.deepEqual(t.calls.filter((c) => c.method === "invokeTool")[1].args, { package: "@thetis/exa", to: "thetis", bump: "minor" }, "no dryRun key at all once the person has agreed");
    // "as it is" sends neither a bump nor a version: the version on disk is the work, and the tool refuses
    // it if it does not move past what the target holds.
    await commands.publish({ name: "@thetis/exa" }, t.env);
    assert.deepEqual(t.calls.filter((c) => c.method === "invokeTool")[2].args, { package: "@thetis/exa" });
    await assert.rejects(commands.publish({ name: "exa" }, t.env), /looks like @scope\/name/);
    await assert.rejects(commands.publish({ name: "@thetis/exa", bump: "sideways" }, t.env), /patch, minor or major/);
    await assert.rejects(commands.publish({ name: "@thetis/exa", version: "next" }, t.env), /a version looks like/);
    await assert.rejects(commands.publish({ name: "@thetis/exa", version: "1.2.0", bump: "patch" }, t.env), /not both/);
    assert.equal(t.calls.filter((c) => c.method === "invokeTool").length, 3, "a refused call never reaches the tool");
  } finally {
    t.cleanup();
  }
});

test("publish: without the publishing package the verb refuses in one sentence, which is what a toast shows", async () => {
  const t = fakeEnv({ installed: [shipped("@thetis/exa")] });
  try {
    await assert.rejects(commands.publish({ name: "@thetis/exa" }, t.env), /package-publish is not installed in your workspace/);
  } finally {
    t.cleanup();
  }
});

/**
 * A publish in a checkout that is itself the registry pushes the branch, so a commit already on that branch
 * rides along even though the publish's own commit is scoped to one directory -- which is the ordinary state
 * of whoever maintains the packages. `with` is how the deliberate ones are named, one at a time, by the
 * person. It is never filled in for them, here or in the page.
 */
test("publish: with names the passengers, and a name that cannot be one is refused before the tool is asked", async () => {
  const t = fakeEnv({
    installed: [shipped("@thetis/exa"), publisher()],
    effective: { "@thetis/package-publish": { targets: TARGETS } },
    tools: { publish_package: (args) => ({ package: args.package, target: args.to, was: "0.2.0", now: "0.3.0", first: false, commit: "abc1234", branch: "main", ok: true }) },
  });
  try {
    const out = await commands.publish({ name: "@thetis/exa", bump: "minor", with: ["@thetis/tools-files", "@thetis/terminal"] }, t.env);
    assert.deepEqual(t.calls.find((c) => c.method === "invokeTool").args, { package: "@thetis/exa", bump: "minor", with: ["@thetis/tools-files", "@thetis/terminal"] });
    assert.deepEqual(out.data.with, ["@thetis/tools-files", "@thetis/terminal"], "the page reads back what it asked for, and names it in the toast");
    await commands.publish({ name: "@thetis/exa" }, t.env);
    assert.equal("with" in t.calls.filter((c) => c.method === "invokeTool")[1].args, false, "no passengers is no key at all, not an empty list");
    await assert.rejects(commands.publish({ name: "@thetis/exa", with: "@thetis/terminal" }, t.env), /with is a list of package names/);
    await assert.rejects(commands.publish({ name: "@thetis/exa", with: ["terminal"] }, t.env), /looks like @scope\/name/);
    await assert.rejects(commands.publish({ name: "@thetis/exa", with: ["@thetis/exa"] }, t.env), /it does not go in with as well/);
    await assert.rejects(commands.publish({ name: "@thetis/exa", with: ["@thetis/a", "@thetis/a"] }, t.env), /names the same package twice/);
    assert.equal(t.calls.filter((c) => c.method === "invokeTool").length, 2, "a refused list never reaches the tool");
  } finally {
    t.cleanup();
  }
});

/**
 * What the page draws the passenger panel from. A dry run answers `ok: false` with the blockers rather than
 * refusing, so the rows are there to be shown, already sorted into the ones that can be named and the ones
 * that can never be: `publishable` is the whole decision, because a package whose version has gone past the
 * registry can be published in its own right and offered as a tick, and one that cannot has to be shown as
 * the reason instead. The blocked ones come first, because they are what has to be dealt with before any
 * tick means anything. A blocker that is not about passengers at all -- staged files -- keeps its sentence
 * and contributes no rows.
 */
test("publish: the dry run's blockers separate what can be ticked from what is a reason", () => {
  const blockers = [
    { code: "dirty-index", message: "Other files are staged in /srv/runtime: a.txt.", details: ["a.txt", "b.txt"] },
    {
      code: "unpushed-others",
      message: "Commits on this branch touch more than alpha/ and are not in thetis yet.",
      details: {
        blocked: [{ dir: "gamma", files: ["gamma/index.js"], package: "@dev/gamma", version: "0.1.0", holds: "0.1.0", moved: false, publishable: false, reason: "not-newer", problem: null }],
        nameable: [{ dir: "beta", files: ["beta/package.json"], package: "@dev/beta", version: "0.2.0", holds: "0.1.0", moved: true, publishable: true, reason: null, problem: null }],
      },
    },
  ];
  assert.deepEqual(blockerLines(blockers), ["Other files are staged in /srv/runtime: a.txt.", "Commits on this branch touch more than alpha/ and are not in thetis yet."], "each refusal's own sentence, whole");
  assert.deepEqual(passengersOf(blockers).map((r) => [r.package, r.publishable]), [["@dev/gamma", false], ["@dev/beta", true]], "blocked first: it is what has to be dealt with");
  // A row list rather than the sorted pair still reads, so a blocker that only meets the minimum shape is
  // drawn rather than dropped.
  assert.deepEqual(passengersOf([{ details: [{ dir: "beta", package: "@dev/beta", version: "0.2.0", holds: "0.1.0", moved: true }] }]).map((r) => r.package), ["@dev/beta"]);
  assert.deepEqual(passengersOf([{ code: "verify-failed", message: "verify refused" }]), [], "a blocker with no rows has no passengers");
  assert.deepEqual(passengersOf(undefined), [], "and neither has a dry run that had nothing to report");
});

/**
 * A fork's publish is two acts wearing one set of words, so the page asks which and passes the answer
 * through. It is never guessed at here and never remembered: `as` arrives with the press that carries it.
 */
test("publish: as says which of the two publishes a fork's is, and a word that is neither never reaches the tool", async () => {
  const t = fakeEnv({
    installed: [shipped("@dev/exa-mine"), publisher()],
    effective: { "@thetis/package-publish": { targets: TARGETS } },
    tools: { publish_package: (args) => ({ package: args.as === "origin" ? "@thetis/exa" : "@dev/exa-mine", as: args.as ?? "itself", fork: args.as === "origin" ? { name: "@dev/exa-mine", version: "0.0.9-fork.1" } : null, was: "0.0.9", now: "0.0.10", first: false, branch: "main", ok: true }) },
  });
  try {
    const origin = await commands.publish({ name: "@dev/exa-mine", to: "thetis", as: "origin", bump: "patch", dryRun: true }, t.env);
    assert.deepEqual(t.calls.find((c) => c.method === "invokeTool").args, { package: "@dev/exa-mine", to: "thetis", bump: "patch", as: "origin", dryRun: true });
    assert.equal(origin.data.package, "@thetis/exa", "what lands is the origin, and the popover says so from the answer");
    assert.deepEqual(origin.data.fork, { name: "@dev/exa-mine", version: "0.0.9-fork.1" }, "the copy that is not rewritten, shown beside the result");
    await commands.publish({ name: "@dev/exa-mine", as: "itself" }, t.env);
    assert.equal(t.calls.filter((c) => c.method === "invokeTool")[1].args.as, "itself");
    await commands.publish({ name: "@dev/exa-mine" }, t.env);
    assert.equal("as" in t.calls.filter((c) => c.method === "invokeTool")[2].args, false, "no answer is no key at all: the question is the publishing package's to ask");
    await assert.rejects(commands.publish({ name: "@dev/exa-mine", as: "upstream" }, t.env), /as is origin or itself/);
    assert.equal(t.calls.filter((c) => c.method === "invokeTool").length, 3, "a word that is neither never reaches the tool");
  } finally {
    t.cleanup();
  }
});

/**
 * Removal is a verb of its own, for the reason the tool is one: an argument that inverts what a command
 * does is how people delete things by accident. The page runs it with `dryRun` first exactly as it does a
 * publish, because the confirm has to name the version the registry is actually holding.
 */
test("unpublish: the dry run and the removal are the same call, and it is reached through the tool like everything else", async () => {
  const t = fakeEnv({
    installed: [shipped("@dev/hello"), publisher()],
    effective: { "@thetis/package-publish": { targets: TARGETS } },
    tools: { unpublish_package: (args) => ({ package: args.package, target: args.to ?? "thetis", removed: true, held: "0.2.0", directory: "hello", files: ["hello/package.json"], branch: "main", commit: "fed4321", ok: true }) },
  });
  try {
    const dry = await commands.unpublish({ name: "@dev/hello", to: "thetis", dryRun: true }, t.env);
    assert.equal(dry.data.dryRun, true);
    assert.equal(dry.data.held, "0.2.0", "the version the registry was carrying, which the confirm names");
    const invoked = t.calls.find((c) => c.method === "invokeTool");
    assert.deepEqual(invoked.ref, { package: "@thetis/package-publish", export: "unpublishPackage", name: "unpublish_package" }, "the export comes off the installed manifest");
    assert.deepEqual(invoked.args, { package: "@dev/hello", to: "thetis", dryRun: true });
    const real = await commands.unpublish({ name: "@dev/hello", to: "thetis" }, t.env);
    assert.equal(real.data.removed, true);
    assert.equal("dryRun" in t.calls.filter((c) => c.method === "invokeTool")[1].args, false, "the real one carries no dryRun key at all");
    await assert.rejects(commands.unpublish({ name: "hello" }, t.env), /looks like @scope\/name/);
    await assert.rejects(commands.unpublish({ name: "@dev/hello", with: ["@dev/hello"] }, t.env), /it does not go in with as well/);
    assert.equal(t.calls.filter((c) => c.method === "invokeTool").length, 2, "a refused call never reaches the tool");
  } finally {
    t.cleanup();
  }
});

test("unpublish: without the publishing package the verb refuses in one sentence, and an older one offers no removal at all", async () => {
  const t = fakeEnv({ installed: [shipped("@dev/hello")] });
  try {
    await assert.rejects(commands.unpublish({ name: "@dev/hello" }, t.env), /package-publish is not installed in your workspace/);
  } finally {
    t.cleanup();
  }
  // `canRemove` is read off the installed manifest, not written down here: a publishing package from
  // before removal existed draws no button, rather than a button for a tool nothing can carry out.
  const older = fakeEnv({ installed: [shipped("@dev/hello"), olderPublisher()], effective: { "@thetis/package-publish": { targets: TARGETS } }, tools: { publish_targets: { targets: [] } } });
  try {
    assert.equal((await commands.publishTargets({}, older.env)).data.canRemove, false);
  } finally {
    older.cleanup();
  }
  const now = fakeEnv({ installed: [shipped("@dev/hello"), publisher()], effective: { "@thetis/package-publish": { targets: TARGETS } }, tools: { publish_targets: { targets: [] } } });
  try {
    assert.equal((await commands.publishTargets({}, now.env)).data.canRemove, true);
  } finally {
    now.cleanup();
  }
});

/**
 * The two lists nothing reconciles. `ahead` reads the marketplace index, which covers the registries this
 * installation mirrors; a publish goes to one of the publishing package's targets. Publish to a target
 * nothing here mirrors and the index stays silent for ever, so the index's silence is said as what it is
 * -- a fact about what is mirrored here -- and the one thing that knows better is this workspace's own
 * record, which `publish_targets` answers per package and which the page says under the badge.
 */
test("badges: the record answers about one package at one target, and says nothing about anybody else's", () => {
  const badge = (text, tone) => ({ text, tone });
  const row = { name: "@dev/hello", version: "0.2.0", ahead: { state: "unpublished", version: "0.2.0", published: "", registry: "" } };
  const at = (name, record) => ({ package: { name }, targets: [{ name: "solo", record }] });
  const blank = { published: null, publishedAt: null, removed: null, removedAt: null, latest: null, commit: null };
  // The badge is the index's statement in every case: it is read on a gallery card too, where the record
  // cannot be had, and a badge that means one thing on the card and another on the page is two badges.
  assert.deepEqual(aheadBadge(badge, row), { text: "no registry here lists it", tone: "dim" });
  assert.equal(publishRecord(at("@dev/hello", blank), "@dev/hello"), null, "asked and answered with nothing: this person has done neither act here");
  const published = at("@dev/hello", { ...blank, published: "0.2.0", publishedAt: "2026-09-22T10:00:00.000Z", latest: "published", commit: "abc1234" });
  assert.deepEqual(publishRecord(published, "@dev/hello"), { target: "solo", version: "0.2.0", at: "2026-09-22T10:00:00.000Z", removed: false, commit: "abc1234" });
  // `latest` is the field to read: it survives any number of later publishes of anything else to the same
  // target, which the per-target `lastPublish` did not, and it saves comparing two timestamps here.
  const gone = at("@dev/hello", { published: "0.2.0", publishedAt: "2026-09-22T10:00:00.000Z", removed: "0.2.0", removedAt: "2026-09-22T11:00:00.000Z", latest: "removed", commit: "fed4321" });
  assert.deepEqual(publishRecord(gone, "@dev/hello"), { target: "solo", version: "0.2.0", at: "2026-09-22T11:00:00.000Z", removed: true, commit: "fed4321" });
  // `record` is only there when the tool was asked about a package, and it is about *that* package: the
  // cheap call carries none, and an answer fetched for another package must not be read as this one's.
  assert.equal(publishRecord(published, "@dev/other"), null, "an answer about @dev/hello says nothing about @dev/other");
  assert.equal(publishRecord({ targets: [{ name: "solo", lastPublish: { name: "@dev/hello", version: "0.2.0", at: "2026-09-22T10:00:00.000Z" } }] }, "@dev/hello"), null, "the cheap call's per-target keys are a different question and are not read as this one");
  assert.equal(publishRecord(null, "@dev/hello"), null, "no publishing package, no record, no difference");
  assert.equal(publishRecord(at("@dev/hello", { ...blank, latest: "published" }), "@dev/hello"), null, "a record with no time cannot be ranked against another, so it is not one");
  // The record never contradicts `ahead` where `ahead` has something to say: a registry holding an older
  // version is a true sentence about that registry, and the badge goes on saying it.
  const behindRow = { ...row, ahead: { state: "ahead", version: "0.2.0", published: "0.1.0", registry: "thetis" } };
  assert.deepEqual(aheadBadge(badge, behindRow), { text: "0.2.0 here, 0.1.0 published", tone: "warn" });
});

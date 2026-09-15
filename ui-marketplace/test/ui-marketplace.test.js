// The commands over a fake env: the merge of what is installed with what the index offers, the update
// offer in the short form a person reads, what each verb refuses before anything is asked, and which
// operator method the admin verbs send. Then the browser modules: they parse, and the entry defines
// `install` and nothing else at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as commands from "../index.js";
import { mergeRows, withUpdate } from "../lib/rows.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const REPO = "https://github.com/thetis-agent/packages.git";
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

const shipped = (name, extra = {}) => ({ name, version: "0.1.0", type: "tool", description: `${name} does things`, root: ROOT, thetis: { type: "tool", tools: [{ name: "t", description: "a tool" }] }, everyone: true, source: { kind: "system", ref: "/sys" }, ...extra });
const fromRegistry = (name, commit) => ({ name, version: "0.1.0", type: "tool", description: "", root: ROOT, thetis: { type: "tool" }, source: { kind: "git", ref: `${REPO}#${name.slice(8)}@${commit}` } });
const entry = (name, version, commit, extra = {}) => ({ name, version, type: "tool", description: `${name} from the registry`, keywords: ["k"], registry: "thetis", url: REPO, dir: name.slice(8), commit, source: `${REPO}#${name.slice(8)}@${commit}`, steps: [], tools: ["t"], service: false, ...extra });

/** An env with a shared directory holding `index`, `installed` behind the kernel, and an operator that records calls. */
function fakeEnv({ installed = [], index, readmes = {}, answers = {}, role = "user", user = "alice" } = {}) {
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
    kernel: {
      packages: {
        list: async () => installed,
        install: async (source) => {
          calls.push({ method: "install", source });
          return { ...shipped("@thetis/new"), everyone: false, source: { kind: "git", ref: source } };
        },
        uninstall: async (name) => calls.push({ method: "uninstall", name }),
        delete: async (name) => (calls.push({ method: "delete", name }), { name, path: "/p", restored: "@alice/old" }),
      },
      operator: {
        call: async (method, args) => {
          calls.push({ method, args });
          return typeof answers[method] === "function" ? answers[method](args) : (answers[method] ?? null);
        },
      },
    },
  };
  return { env, calls, cleanup: () => rmSync(shared, { recursive: true, force: true }) };
}

test("rows: installed first, then the registry's; a shared name learns its registry and whether it is behind", () => {
  const index = { version: 1, updatedAt: "2026-09-14T00:00:00.000Z", registries: [{ name: "thetis", url: REPO }], packages: [entry("@thetis/exa", "0.2.0", NEW), entry("@thetis/memo", "0.1.0", OLD)] };
  const rows = mergeRows([shipped("@thetis/harness-core"), fromRegistry("@thetis/exa", OLD)], index.packages, index);
  assert.deepEqual(rows.map((r) => [r.name, r.installed, r.available, r.scope]), [["@thetis/harness-core", true, false, "everyone"], ["@thetis/exa", true, true, "me"], ["@thetis/memo", false, true, null]]);
  const exa = rows[1];
  assert.equal(exa.pin, "1111111");
  assert.equal(exa.tip, "0.2.0");
  assert.equal(exa.registry, "thetis");
  assert.deepEqual(exa.update, { version: "0.2.0", from: "1111111", to: "2222222", registry: "thetis", source: `${REPO}#exa@${NEW}` }, "short commits, because a person reads them");
  assert.equal(exa.description, "@thetis/exa from the registry", "the registry's description fills an empty one");
  assert.equal(rows[0].update, null, "a shipped package has no pin and is never behind");
  assert.equal(rows[0].license, "MIT", "the installed copy's package.json says the license");
  assert.deepEqual(rows[0].tools, [{ name: "t", description: "a tool" }]);
  assert.deepEqual(rows[2].tools, [{ name: "t", description: "" }], "the index knows names only");
  assert.equal(withUpdate({ name: "x" }, undefined).update, undefined, "nothing newer says nothing");
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
  const index = { version: 1, updatedAt: "2026-09-14T00:00:00.000Z", registries: [{ name: "thetis", url: REPO }], packages: [entry("@thetis/exa", "0.2.0", NEW, { readme: true }), entry("@thetis/memo", "0.1.0", OLD)] };
  const t = fakeEnv({ index, readmes: { "exa.md": "# exa\n" }, role: "admin", user: "root" });
  try {
    const page = (await commands.show({ name: "@thetis/exa" }, t.env)).data;
    assert.equal(page.readme, "# exa\n");
    assert.equal(page.row.readme, true);
    assert.deepEqual([page.user, page.role], ["root", "admin"]);
    assert.equal((await commands.show({ name: "@thetis/memo" }, t.env)).data.readme, null);
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

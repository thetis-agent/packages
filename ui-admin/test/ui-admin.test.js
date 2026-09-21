// The commands over a fake `env.kernel.operator.call`: which method each one sends with which arguments,
// what each refuses before the kernel is asked, and the own-account refusal. Then the browser modules:
// they parse, and the entry does nothing at import beyond defining `install`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as commands from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** An env whose operator answers from `answers` by method name and records every call. */
function fakeEnv(answers = {}, user = "root") {
  const calls = [];
  const env = {
    user,
    role: "admin",
    kernel: {
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

const refuses = (fn, args, env, pattern) => assert.rejects(fn(args, env), pattern);

test("users, models, config and journal read through the operator", async () => {
  const { env, calls } = fakeEnv({ "users.list": [{ id: "root", role: "admin" }], models: [{ id: "echo" }], "config.get": { model: "echo", secret: "•••" }, "journal.tail": [{ kind: "user.create" }] });
  assert.deepEqual(await commands.users({}, env), { data: [{ id: "root", role: "admin" }] });
  assert.deepEqual(await commands.models({}, env), { data: { model: "echo", models: [{ id: "echo" }] } });
  assert.deepEqual(await commands.config({}, env), { data: { model: "echo", secret: "•••" } });
  assert.deepEqual(await commands.journal({ limit: "50", kind: "user.create" }, env), { data: [{ kind: "user.create" }] });
  assert.deepEqual(await commands.journal({ limit: 5000 }, env), { data: [{ kind: "user.create" }] });
  assert.deepEqual(await commands.journal({}, env), { data: [{ kind: "user.create" }] });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["users.list", "models", "config.get", "config.get", "journal.tail", "journal.tail", "journal.tail"],
    "models asks for the default model too"
  );
  assert.deepEqual(calls[4].args, { limit: 50, kind: "user.create" });
  assert.deepEqual(calls[5].args, { limit: 1000, kind: undefined }, "the limit is capped at 1000");
  assert.deepEqual(calls[6].args, { limit: 200, kind: undefined }, "200 rows by default, every kind");
});

test("user-create makes the person, then sets the password only when one was given", async () => {
  const { env, calls } = fakeEnv({ "users.create": (a) => ({ id: a.id, role: a.role, status: "active" }) });
  assert.deepEqual(await commands.userCreate({ id: "carol", role: "admin", password: "carolpass1" }, env), { data: { id: "carol", role: "admin", status: "active" } });
  assert.deepEqual(calls, [
    { method: "users.create", args: { id: "carol", role: "admin" } },
    { method: "users.passwd", args: { id: "carol", password: "carolpass1" } },
  ]);
  calls.length = 0;
  await commands.userCreate({ id: "dave" }, env);
  assert.deepEqual(calls, [{ method: "users.create", args: { id: "dave", role: "user" } }], "role defaults to user; no password call");
  await refuses(commands.userCreate, { id: "Bad Id" }, env, /lowercase letters, digits and dashes/);
  await refuses(commands.userCreate, { id: "eve", role: "system" }, env, /role must be user or admin/);
  await refuses(commands.userCreate, { id: "eve", password: "short" }, env, /at least 8 characters/);
  assert.equal(calls.length, 1, "a refused call never reaches the kernel");
});

test("user-role, user-status, user-password and user-remove send the checked arguments", async () => {
  const { env, calls } = fakeEnv({ "users.setRole": (a) => ({ id: a.id, role: a.role }), "users.setStatus": (a) => ({ id: a.id, status: a.status }) });
  assert.deepEqual(await commands.userRole({ id: "carol", role: "admin" }, env), { data: { id: "carol", role: "admin" } });
  assert.deepEqual(await commands.userStatus({ id: "carol", status: "suspended" }, env), { data: { id: "carol", status: "suspended" } });
  assert.deepEqual(await commands.userPassword({ id: "carol", password: "carolpass2" }, env), { data: { id: "carol" } });
  assert.deepEqual(await commands.userRemove({ id: "carol" }, env), { data: { id: "carol" } });
  assert.deepEqual(calls, [
    { method: "users.setRole", args: { id: "carol", role: "admin" } },
    { method: "users.setStatus", args: { id: "carol", status: "suspended" } },
    { method: "users.passwd", args: { id: "carol", password: "carolpass2" } },
    { method: "users.remove", args: { id: "carol" } },
  ]);
  await refuses(commands.userRole, { id: "carol", role: "boss" }, env, /role must be user or admin/);
  await refuses(commands.userStatus, { id: "carol", status: "gone" }, env, /status must be active or suspended/);
  await refuses(commands.userPassword, { id: "carol", password: "1234567" }, env, /at least 8 characters/);
  await refuses(commands.userRemove, { id: "../etc" }, env, /lowercase letters/);
  assert.equal(calls.length, 4);
});

test("your own account is refused for every change, before the kernel is asked", async () => {
  const { env, calls } = fakeEnv({}, "root");
  const own = /you cannot change your own account here/;
  await refuses(commands.userRole, { id: "root", role: "user" }, env, own);
  await refuses(commands.userStatus, { id: "root", status: "suspended" }, env, own);
  await refuses(commands.userPassword, { id: "root", password: "rootpass2" }, env, own);
  await refuses(commands.userRemove, { id: "root" }, env, own);
  assert.deepEqual(calls, []);
});

test("mounts-list asks for one person or everyone; mounts-set checks the list the way the kernel does", async () => {
  const { env, calls } = fakeEnv({ "mounts.list": (a) => (a.user ? { [a.user]: [] } : { bob: [{ path: "/srv/x", mode: "ro" }] }), "mounts.set": (a) => a.mounts });
  assert.deepEqual(await commands.mountsList({}, env), { data: { bob: [{ path: "/srv/x", mode: "ro" }] } });
  assert.deepEqual(await commands.mountsList({ user: "bob" }, env), { data: { bob: [] } });
  const mounts = [{ path: "/srv/repos/a", mode: "rw" }, { path: "/srv/repos/b", mode: "ro" }];
  assert.deepEqual(await commands.mountsSet({ user: "bob", mounts }, env), { data: mounts });
  assert.deepEqual(calls, [
    { method: "mounts.list", args: {} },
    { method: "mounts.list", args: { user: "bob" } },
    { method: "mounts.set", args: { user: "bob", mounts } },
  ]);
  await refuses(commands.mountsList, { user: "Bob" }, env, /user must be lowercase/);
  await refuses(commands.mountsSet, { user: "bob", mounts: "x" }, env, /list of at most 32/);
  await refuses(commands.mountsSet, { user: "bob", mounts: Array.from({ length: 33 }, (_, i) => ({ path: `/m/${i}`, mode: "ro" })) }, env, /list of at most 32/);
  await refuses(commands.mountsSet, { user: "bob", mounts: [{ path: "srv/x", mode: "rw" }] }, env, /absolute and normalized/);
  await refuses(commands.mountsSet, { user: "bob", mounts: [{ path: "/srv/../etc", mode: "rw" }] }, env, /absolute and normalized/);
  await refuses(commands.mountsSet, { user: "bob", mounts: [{ path: "/", mode: "rw" }] }, env, /absolute and normalized/);
  await refuses(commands.mountsSet, { user: "bob", mounts: [{ path: "/srv/x", mode: "rwx" }] }, env, /must be rw or ro/);
  await refuses(commands.mountsSet, { user: "bob", mounts: [{ path: "/srv/x", mode: "rw" }, { path: "/srv/x", mode: "ro" }] }, env, /listed twice/);
  await refuses(commands.mountsSet, { user: "_system", mounts: [] }, env, /user must be lowercase/);
  assert.equal(calls.length, 3);
});

test("fence-reload targets one workspace, `_system` included, and status reads the whole installation", async () => {
  const { env, calls } = fakeEnv({ "fence.reload": (a) => ({ user: a.user, services: a.user === "_system" ? [] : ["@thetis/gateway-web"] }), status: { daemon: { stale: false }, restart: null, workspaces: [{ user: "bob", stale: true }] } });
  assert.deepEqual(await commands.fenceReload({ user: "bob" }, env), { data: { user: "bob", services: ["@thetis/gateway-web"] } });
  assert.deepEqual(await commands.fenceReload({ user: "_system" }, env), { data: { user: "_system", services: [] } }, "_system is a legal target here, unlike a mount");
  assert.deepEqual(await commands.status({}, env), { data: { daemon: { stale: false }, restart: null, workspaces: [{ user: "bob", stale: true }] } });
  assert.deepEqual(calls, [
    { method: "fence.reload", args: { user: "bob" } },
    { method: "fence.reload", args: { user: "_system" } },
    { method: "status", args: {} },
  ]);
  await refuses(commands.fenceReload, { user: "Bad Id" }, env, /user must be lowercase letters, digits and dashes/);
  await refuses(commands.fenceReload, { user: "_other" }, env, /user must be lowercase/);
  await refuses(commands.fenceReload, {}, env, /user must be lowercase/);
  assert.equal(calls.length, 3, "a refused reload never reaches the kernel");
});

test("restart-request sends the trimmed reason and passes the latch's own sentence back", async () => {
  const { env, calls } = fakeEnv({ "restart.request": (a) => ({ state: "refused", why: "policy", message: `Refused, and nothing was restarted: ... \`Restart=on-failure\` ... reason was ${a.reason}` }) });
  const out = await commands.restartRequest({ reason: "  the kernel changed  " }, env);
  assert.equal(out.data.state, "refused");
  assert.match(out.data.message, /reason was the kernel changed$/, "the sentence comes back as the kernel wrote it");
  assert.deepEqual(calls, [{ method: "restart.request", args: { reason: "the kernel changed" } }]);
  const needsReason = /a restart needs a reason: it is shown to everyone waiting and recorded/;
  await refuses(commands.restartRequest, {}, env, needsReason);
  await refuses(commands.restartRequest, { reason: "   " }, env, needsReason);
  await refuses(commands.restartRequest, { reason: 7 }, env, needsReason);
  assert.equal(calls.length, 1, "a restart with no reason never reaches the kernel");
});

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

test("config-list, config-show, config-set, config-unset and config-reload pass their arguments to config.* and never say a value", async () => {
  const report = (a) => ({ package: a.name ?? "@thetis/exa", user: a.user, inherits: [], keys: [{ key: "apiKey", state: "set", secret: true, declared: true, redacted: true }], summary: "every key is set", broken: false });
  const { env, calls } = fakeEnv({ "config.list": (a) => [report(a)], "config.show": report, "config.set": report, "config.unset": report, "config.reload": { changed: ["@thetis/exa"], restarted: [{ user: "alice", package: "@thetis/exa" }] } });
  const secret = "sk-or-v1-hunter2-never-logged";
  const lines = await captured(async () => {
    assert.deepEqual((await commands.configList({}, env)).data, [report({})]);
    assert.equal((await commands.configList({ user: "alice" }, env)).data[0].user, "alice");
    assert.equal((await commands.configShow({ name: "@thetis/exa" }, env)).data.package, "@thetis/exa");
    assert.equal((await commands.configShow({ name: "@thetis/exa", user: "" }, env)).data.user, undefined, "an empty user is the system layer");
    assert.equal((await commands.configSet({ name: "@thetis/exa", key: "apiKey", value: secret }, env)).data.keys[0].redacted, true);
    assert.equal((await commands.configSet({ name: "@thetis/exa", key: "defaults", value: { n: 1 }, user: "alice" }, env)).data.user, "alice");
    assert.equal((await commands.configSet({ name: "@thetis/exa", key: "on", value: false }, env)).data.broken, false, "false is a value");
    assert.equal((await commands.configUnset({ name: "@thetis/exa", key: "apiKey", user: "alice" }, env)).data.user, "alice");
    assert.deepEqual((await commands.configReload({}, env)).data, { changed: ["@thetis/exa"], restarted: [{ user: "alice", package: "@thetis/exa" }] });
    await refuses(commands.configShow, { name: "exa" }, env, /looks like @scope\/name/);
    await refuses(commands.configSet, { name: "@thetis/exa", key: "api key", value: secret }, env, /a configuration key is a word/);
    await refuses(commands.configSet, { name: "@thetis/exa", key: "apiKey" }, env, /needs a value; config-unset removes one/);
    await refuses(commands.configSet, { name: "@thetis/exa", key: "apiKey", value: null }, env, /needs a value/);
    await refuses(commands.configSet, { name: "@thetis/exa", key: "apiKey", value: secret, user: "Alice" }, env, /user must be lowercase/);
    await refuses(commands.configUnset, { name: "@thetis/exa", key: "" }, env, /a configuration key is a word/);
  });
  assert.deepEqual(calls, [
    { method: "config.list", args: {} },
    { method: "config.list", args: { user: "alice" } },
    { method: "config.show", args: { name: "@thetis/exa" } },
    { method: "config.show", args: { name: "@thetis/exa" } },
    { method: "config.set", args: { name: "@thetis/exa", key: "apiKey", value: secret } },
    { method: "config.set", args: { name: "@thetis/exa", key: "defaults", value: { n: 1 }, user: "alice" } },
    { method: "config.set", args: { name: "@thetis/exa", key: "on", value: false } },
    { method: "config.unset", args: { name: "@thetis/exa", key: "apiKey", user: "alice" } },
    { method: "config.reload", args: {} },
  ]);
  assert.deepEqual(lines, [], "nothing is written to the console or stderr, so no value can be");
  const kept = fakeEnv({ "config.set": new Error("apiKey is declared for the system") });
  await refuses(commands.configSet, { name: "@thetis/exa", key: "apiKey", value: secret, user: "alice" }, kept.env, /declared for the system/);
  for (const fn of [() => commands.configSet({ name: "@thetis/exa", key: "bad key", value: secret }, env), () => commands.configSet({ name: "@thetis/exa", key: "apiKey", value: secret, user: "Alice" }, env)]) {
    const err = await fn().then(() => null, (e) => e);
    assert.ok(err && !String(err.message).includes(secret), "a refusal never echoes the value");
  }
});

test("the configuration form's pure helpers: the control per key, what counts as a change, the words for a source", async () => {
  const { kindOf, readValue, sourceText, missingText, brokenSentence, reloadSentence } = await import("../ui/config-form.js");
  const k = (extra) => ({ key: "k", state: "set", secret: false, declared: true, ...extra });
  assert.equal(kindOf(k({ secret: true, type: "string" })), "secret");
  assert.deepEqual(["string", "number", "boolean", "object", "array"].map((type) => kindOf(k({ type }))), ["text", "number", "checkbox", "json", "json"]);
  assert.deepEqual([kindOf(k({ declared: false, value: 3 })), kindOf(k({ declared: false, value: true })), kindOf(k({ declared: false, value: [1] })), kindOf(k({ declared: false, value: "x" })), kindOf(k({ declared: false }))], ["number", "checkbox", "json", "text", "text"], "an undeclared key is typed by its value");
  assert.deepEqual(readValue("secret", "", k()), { same: true }, "an empty password box writes nothing");
  assert.deepEqual(readValue("secret", "tok", k()), { value: "tok" });
  assert.deepEqual(readValue("text", "a", k({ value: "a" })), { same: true });
  assert.deepEqual(readValue("text", "", k({ state: "unset" })), { same: true });
  assert.deepEqual(readValue("text", "b", k({ value: "a" })), { value: "b" });
  assert.deepEqual(readValue("number", " 7 ", k({ value: 7 })), { same: true });
  assert.deepEqual(readValue("number", "7.5", k({ value: 7 })), { value: 7.5 });
  assert.match(readValue("number", "seven", k({ value: 7 })).error, /not a number/);
  assert.match(readValue("number", "", k({ value: 7 })).error, /Clear removes the value/);
  assert.deepEqual(readValue("number", "", k({ state: "unset" })), { same: true });
  assert.deepEqual(readValue("checkbox", false, k({ state: "unset" })), { same: true });
  assert.deepEqual(readValue("checkbox", true, k({ value: false })), { value: true });
  assert.deepEqual(readValue("json", '{"a": 1}', k({ type: "object", value: { a: 1 } })), { same: true });
  assert.deepEqual(readValue("json", '{"a": 2}', k({ type: "object", value: { a: 1 } })), { value: { a: 2 } });
  assert.match(readValue("json", "{a: 2}", k({ type: "object", value: { a: 1 } })).error, /^Not valid JSON/, "a parse error is said, and nothing is sent");
  assert.match(readValue("json", "[1]", k({ type: "object" })).error, /object is expected/);
  assert.match(readValue("json", "{}", k({ type: "array" })).error, /array is expected/);
  assert.match(readValue("json", "null", k({ type: "object" })).error, /null cannot be stored/);
  assert.equal(sourceText(k({ state: "unset" }), "system"), "not set");
  assert.equal(sourceText(k({ source: "file" }), "system"), "from the file");
  assert.equal(sourceText(k({ source: "default" }), "system"), "default");
  assert.equal(sourceText(k({ source: "system", inheritedFrom: "@bitmuse/notion" }), "system"), "set for everyone · inherited from @bitmuse/notion");
  assert.equal(sourceText(k({ source: "user" }), "user"), "set by you");
  assert.equal(sourceText(k({ source: "user" }), "user", "alice"), "set by alice");
  assert.equal(missingText(k({ state: "missing", missing: ["OPENROUTER_API_KEY"] })), "OPENROUTER_API_KEY is not in the environment");
  assert.equal(missingText(k({ missing: ["A", "B"] })), "A, B are not in the environment");
  assert.equal(missingText(k()), null);
  assert.equal(brokenSentence([{ broken: false }]), null);
  assert.equal(brokenSentence([{ broken: true }, { broken: false }]), "1 package is missing configuration");
  assert.equal(brokenSentence([{ broken: true }, { broken: true }]), "2 packages are missing configuration");
  assert.equal(reloadSentence({ changed: [], restarted: [] }), "Nothing changed.");
  assert.equal(reloadSentence(null), "Nothing changed.");
  assert.equal(reloadSentence({ changed: ["@thetis/exa", "@thetis/terminal"], restarted: [{ user: "alice", package: "@thetis/exa" }] }), "changed: @thetis/exa, @thetis/terminal; restarted: @thetis/exa for alice.");
});

test("a kernel refusal comes back as the error it threw", async () => {
  const { env } = fakeEnv({ "users.remove": new Error("unknown user: zed"), "fence.reload": new Error("user zed is suspended"), "restart.request": new Error("only an admin may restart the daemon") });
  await refuses(commands.userRemove, { id: "zed" }, env, /unknown user: zed/);
  await refuses(commands.fenceReload, { user: "zed" }, env, /user zed is suspended/);
  await refuses(commands.restartRequest, { reason: "new kernel" }, env, /only an admin may restart the daemon/);
});

test("the browser modules parse, and the entry defines install and nothing else", async () => {
  const ui = join(HERE, "..", "ui");
  for (const file of readdirSync(ui).filter((f) => f.endsWith(".js"))) {
    const out = spawnSync(process.execPath, ["--check", join(ui, file)], { encoding: "utf8" });
    assert.equal(out.status, 0, `${file}: ${out.stderr}`);
  }
  const mod = await import("../ui/index.js");
  assert.deepEqual(Object.keys(mod), ["default"]);
  assert.equal(typeof mod.default, "function");
  assert.equal(mod.default.name, "install");
});

test("install registers exactly the seven declared entries, each mounting through the seam; configuration also answers children", async () => {
  const { default: install } = await import("../ui/index.js");
  const panels = {};
  install({ panel: (id, impl) => (panels[id] = impl) });
  assert.deepEqual(Object.keys(panels), ["people", "models", "configuration", "mounts", "activity", "workspaces", "overview"]);
  for (const impl of Object.values(panels)) assert.equal(typeof impl.mount, "function");
  assert.equal(typeof panels.configuration.children, "function");
  for (const [id, impl] of Object.entries(panels)) if (id !== "configuration") assert.equal(impl.children, undefined);
});

test("configurationChildren lists the packages with keys, marks the broken ones, and hangs under packages in the manifest", async () => {
  const { configurationChildren } = await import("../ui/configuration.js");
  const reports = [
    { package: "@thetis/exa", summary: "apiKey is required and not set", broken: true, keys: [{ key: "apiKey" }] },
    { package: "@thetis/tools-files", summary: "every key is set", broken: false, keys: [] },
    { package: "@bitmuse/moo", summary: "every key is set", broken: false, keys: [{ key: "base_url" }, { key: "username" }] },
  ];
  const kids = await configurationChildren({ request: async (verb) => (verb === "config-list" ? { data: reports } : { data: null }) });
  assert.deepEqual(kids, [
    { id: "@thetis/exa", label: "@thetis/exa", note: "apiKey is required and not set", mark: "err" },
    { id: "@bitmuse/moo", label: "@bitmuse/moo", note: "every key is set", mark: null },
  ]);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const entry = manifest.thetis.ui.panel.find((e) => e.id === "configuration");
  assert.equal(entry.under, "packages");
});

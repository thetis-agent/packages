// The commands over a fake `env.kernel.operator.call`: which method each one sends with which arguments,
// what each refuses before the kernel is asked, and the own-account refusal. Then the browser modules:
// they parse, and the entry does nothing at import beyond defining `install`.
import { test } from "node:test";
import assert from "node:assert/strict";
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

test("install registers exactly the six declared sections, each mounting through the seam", async () => {
  const { default: install } = await import("../ui/index.js");
  const panels = {};
  install({ panel: (id, impl) => (panels[id] = impl) });
  assert.deepEqual(Object.keys(panels), ["people", "models", "mounts", "activity", "workspaces", "overview"]);
  for (const impl of Object.values(panels)) assert.equal(typeof impl.mount, "function");
});

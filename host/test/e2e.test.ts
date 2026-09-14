// End-to-end through the real process fence and userspace agent, with a deterministic
// provider fixture instead of the network. Exercises: seeding, prompt/tool steps, the tool
// loop, self-extension by installing a user package, RPC from inside the fence, and isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import type { TurnEvent } from "@thetis/contracts";
import { createControlHandler, createRpcHandler, defaultConfig } from "@thetis/kernel";
import type { ProcessFence } from "@thetis/sandbox";
import { ControlServer, createKernel, T, type Kernel } from "../src/index.js";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");
const SANDBOX = (process.env.THETIS_TEST_SANDBOX as "auto" | "none") ?? "auto";

let home: string;
let kernel: Kernel;

async function collect(events: AsyncIterable<TurnEvent>) {
  const all: TurnEvent[] = [];
  let text = "";
  for await (const e of events) {
    all.push(e);
    if (e.type === "text") text += e.delta;
  }
  const errors = all.filter((e) => e.type === "error").map((e) => (e as { message: string }).message);
  return { all, text, errors };
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "thetis-e2e-"));
  const sys = join(home, "system-packages");
  mkdirSync(sys);
  for (const name of ["harness-core", "tool-exec", "prompt-cache"]) symlinkSync(resolve(PROJECT, "packages", name), join(sys, name));
  symlinkSync(join(FIXTURES, "provider-echo"), join(sys, "provider-echo"));
  const config = defaultConfig(join(home, "data"), PROJECT);
  config.systemPackagesDir = sys;
  config.model = "echo";
  config.fence.sandbox = SANDBOX;
  config.fence.readOnly.push(sys, FIXTURES);
  config.systemPackages = { "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache"], _system: ["@thetis/provider-echo"] };
  config.packages = { "@thetis/provider-echo": { tag: "t1" }, "@thetis/prompt-cache": { explicitVendors: ["echo"], ttl: "1h" } };
  config.requestTimeoutMs = 60_000;
  kernel = createKernel(config, (c) => c.bind(T.log, () => (line: string) => process.env.THETIS_TEST_VERBOSE && console.error(line)));
  kernel.users.create("alice");
  kernel.users.create("bob");
});

after(async () => {
  await kernel.shutdown();
  rmSync(home, { recursive: true, force: true });
});

test("first turn seeds the userspace and round-trips through the provider", async () => {
  const s = kernel.sessions.create("alice");
  const r = await collect(kernel.sessions.send("alice", s.id, "hello"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, "echo: hello (t1)");
  const names = kernel.packages.installed(kernel.userspaces.pathFor("alice")).map((p) => p.name);
  assert.deepEqual(names, ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache"]);
  assert.equal(kernel.sessions.inspect("alice", s.id).conversation.length, 2);
});

test("the prompt-cache step hands the provider a policy hint and keeps diagnostics", async () => {
  const s = kernel.sessions.create("alice");
  const r = await collect(kernel.sessions.send("alice", s.id, "hints?"));
  assert.deepEqual(r.errors, []);
  const hints = JSON.parse(r.text) as { cache: { strategy?: string; ttl?: string; systemTtl?: string; affinity?: string } };
  assert.equal(hints.cache.strategy, "breakpoints", "echo is configured as an explicit vendor");
  assert.equal(hints.cache.ttl, "1h");
  assert.equal(hints.cache.systemTtl, undefined, "the hint names only what is configured");
  assert.match(hints.cache.affinity ?? "", /^thetis:[0-9a-f]{16}$/);
  await collect(kernel.sessions.send("alice", s.id, "hints?"));
  const diag = kernel.sessions.inspect("alice", s.id).harness["@thetis/prompt-cache"] as { turns: number; divergences: number };
  assert.equal(diag.turns, 2);
  assert.equal(diag.divergences, 0, "an append-only conversation never rewrites its prefix");
});

test("harness steps build the system prompt and attach tools", async () => {
  const s = kernel.sessions.create("alice");
  const sys = await collect(kernel.sessions.send("alice", s.id, "system?"));
  assert.match(sys.text, /You are Thetis/);
  assert.match(sys.text, /@thetis\/tool-exec@0\.1\.0 \(tool\): Tools for the model/);
  const tools = await collect(kernel.sessions.send("alice", s.id, "tools?"));
  for (const t of ["exec", "write_file", "install_package", "spawn_subagent"]) assert.ok(tools.text.split(",").includes(t), `missing tool ${t}`);
});

test("tool loop: the model runs a command inside the fence and sees the result", async () => {
  const s = kernel.sessions.create("alice");
  const r = await collect(kernel.sessions.send("alice", s.id, "run: echo hi-from-fence && pwd"));
  assert.deepEqual(r.errors, []);
  const call = r.all.find((e) => e.type === "tool.call");
  assert.ok(call, "tool.call event emitted");
  assert.match(r.text, /tool said: exit 0/);
  assert.match(r.text, /hi-from-fence/);
  assert.match(r.text, new RegExp(kernel.userspaces.pathFor("alice").home));
  const conv = kernel.sessions.inspect("alice", s.id).conversation;
  assert.deepEqual(conv.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
});

test("self-extension: a package written into the userspace is live on the next turn", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "hello");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "@alice/hello", version: "0.1.0", type: "module", main: "index.js",
    thetis: { type: "loader", steps: [{ id: "mark", phase: "prompt", export: "mark" }, { id: "count", phase: "after", export: "count" }],
      tools: [{ name: "greet", description: "greets", parameters: { type: "object", properties: {} }, export: "greet" }] },
  }));
  writeFileSync(join(dir, "index.js"), `
    export async function mark(ctx) { return { call: { ...ctx.call, system: ctx.call.system + "\\nMARKER-FROM-ALICE " + (ctx.harness.turns ?? 0) } }; }
    export async function count(ctx) { return { harness: { ...ctx.harness, turns: (ctx.harness.turns ?? 0) + 1 } }; }
    export async function greet() { return "hi"; }
  `);
  const s = kernel.sessions.create("alice");
  const viaRpc = await collect(kernel.sessions.send("alice", s.id, "install: packages/hello"));
  assert.deepEqual(viaRpc.errors, []);
  assert.match(viaRpc.text, /installed @alice\/hello@0.1.0/);
  const sys = await collect(kernel.sessions.send("alice", s.id, "system?"));
  assert.match(sys.text, /MARKER-FROM-ALICE 0/);
  assert.equal(kernel.sessions.inspect("alice", s.id).harness.turns, 1, "after-phase step persisted harness state");
  const again = await collect(kernel.sessions.send("alice", s.id, "system?"));
  assert.match(again.text, /MARKER-FROM-ALICE 1/);
  const tools = await collect(kernel.sessions.send("alice", s.id, "tools?"));
  assert.ok(tools.text.split(",").includes("greet"));
  assert.ok(existsSync(join(us.store, "node_modules", "@alice", "hello", "package.json")));
});

test("a user cannot install into another scope, and bob does not see alice's package", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "evil");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@bob/evil", version: "0.0.1", main: "index.js", thetis: { type: "tool" } }));
  writeFileSync(join(dir, "index.js"), "");
  await assert.rejects(kernel.packages.install(us, kernel.users.authorize("alice"), "packages/evil"), /may only install packages in scope @alice/);
  await assert.rejects(kernel.packages.install(us, kernel.users.authorize("alice"), "../../.."), /inside the userspace/);
  const s = kernel.sessions.create("bob");
  const tools = await collect(kernel.sessions.send("bob", s.id, "tools?"));
  assert.ok(!tools.text.split(",").includes("greet"));
  assert.throws(() => kernel.sessions.inspect("bob", kernel.sessions.list("alice")[0].id), /unknown session/);
});

test("promote: an admin makes a user package the default for everyone", async () => {
  const control = createControlHandler(kernel);
  const r = (await control("packages.promote", { user: "alice", name: "@alice/hello" })) as { name: string; userspaces: string[] };
  assert.equal(r.name, "@thetis/hello");
  assert.ok(r.userspaces.includes("alice") && r.userspaces.includes("bob"));
  const alice = kernel.packages.installed(kernel.userspaces.pathFor("alice")).map((p) => p.name);
  assert.ok(!alice.includes("@alice/hello"), "the owner's copy is gone");
  assert.ok(alice.includes("@thetis/hello"), "the owner runs the promoted one");
  assert.ok(existsSync(join(kernel.config.promotedPackagesDir, "hello", "package.json")));
  assert.ok(kernel.packages.promoted().includes("@thetis/hello"), "new userspaces get it too");
  assert.ok(!kernel.config.systemPackages["*"].includes("@thetis/hello"), "the configuration file is not written by the kernel");
  // Bob's steps and tools run inside bob's fence, which proves the promoted directory is readable there.
  const s = kernel.sessions.create("bob");
  const tools = await collect(kernel.sessions.send("bob", s.id, "tools?"));
  assert.deepEqual(tools.errors, []);
  assert.ok(tools.text.split(",").includes("greet"), `bob has the promoted tool: ${tools.text}`);
  const sys = await collect(kernel.sessions.send("bob", s.id, "system?"));
  assert.match(sys.text, /MARKER-FROM-ALICE/);
  await assert.rejects(control("packages.promote", { user: "alice", name: "@thetis/hello" }), /not a package of alice/);
});

test("git install: a package directory inside a repository, as url#dir", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const repo = join(us.home, "registry");
  mkdirSync(join(repo, "pkgs", "wave"), { recursive: true });
  writeFileSync(join(repo, "pkgs", "wave", "package.json"), JSON.stringify({ name: "@alice/wave", version: "0.0.1", type: "module", main: "index.js", thetis: { type: "tool", tools: [{ name: "wave", description: "waves", export: "wave" }] } }));
  writeFileSync(join(repo, "pkgs", "wave", "index.js"), "export async function wave() { return 'o/'; }");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -q -m init", { cwd: repo });
  const actor = kernel.users.authorize("alice");
  const info = await kernel.packages.install(us, actor, `file://${repo}#pkgs/wave`);
  assert.equal(info.name, "@alice/wave");
  assert.ok(existsSync(join(us.store, "node_modules", "@alice", "wave", "index.js")));
  await assert.rejects(kernel.packages.install(us, actor, `file://${repo}#../escape`), /inside the repository/);
  await kernel.packages.uninstall(us, "@alice/wave");
});

test("operator methods: an admin's fence may use them; a user's may not", async () => {
  const handler = (id: string) => createRpcHandler(kernel.userspaces.pathFor(id), kernel.users, kernel.packages, kernel.sessions, kernel.auth, createControlHandler(kernel));
  await assert.rejects(handler("alice")("operator.users.list", {}), /only an admin/);
  kernel.users.create("root", "admin");
  const root = handler("root");
  const users = (await root("operator.users.list", {})) as { id: string }[];
  assert.ok(users.some((u) => u.id === "alice"));
  assert.equal(await root("operator.ping", {}), "pong");
  const list = (await root("operator.packages.list", { user: "alice" })) as { name: string }[];
  assert.ok(list.some((p) => p.name === "@thetis/harness-core"), "an admin sees another person's packages");
  await assert.rejects(root("operator.nope", {}), /unknown control method/);
  const rows = (await root("operator.journal.tail", { limit: 50 })) as { kind: string; actor?: string }[];
  assert.ok(rows.some((r) => r.kind === "turn.end"), "turns are journaled");
  assert.ok(rows.some((r) => r.kind === "package.promote" && r.actor === "operator"), "the promotion was journaled");
});

test("cancel: a running turn stops mid-stream, keeps the partial text, and the session is idle again", async () => {
  const s = kernel.sessions.create("alice");
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const events = kernel.sessions.send("alice", s.id, `slow: ${words}`);
  assert.equal(kernel.sessions.cancel("alice", "s_000000000000"), false, "no turn on an unknown session");
  setTimeout(() => assert.equal(kernel.sessions.cancel("alice", s.id), true), 300);
  const r = await collect(events);
  const error = r.all.find((e) => e.type === "error") as { code?: string } | undefined;
  assert.equal(error?.code, "cancelled");
  assert.equal(r.all.at(-1)?.type, "turn.end");
  assert.ok(r.text.length > 0 && r.text.split(" ").length < 40, `stopped early: ${JSON.stringify(r.text)}`);
  const rec = kernel.sessions.inspect("alice", s.id);
  assert.equal(rec.status, "idle");
  assert.deepEqual(rec.conversation.map((m) => m.role), ["user", "assistant"]);
  assert.equal(rec.conversation[1].content, r.text);
  const again = await collect(kernel.sessions.send("alice", s.id, "hello"));
  assert.deepEqual(again.errors, []);
});

test("cancel: a running exec tool is killed and the turn ends", async () => {
  const s = kernel.sessions.create("alice");
  const events = kernel.sessions.send("alice", s.id, "run: sleep 30; echo late");
  setTimeout(() => kernel.sessions.cancel("alice", s.id), 500);
  const started = Date.now();
  const r = await collect(events);
  assert.ok(Date.now() - started < 10_000, "the turn did not wait for the sleep");
  assert.equal((r.all.find((e) => e.type === "error") as { code?: string })?.code, "cancelled");
  const again = await collect(kernel.sessions.send("alice", s.id, "run: echo alive"));
  assert.match(again.text, /alive/);
});

test("rpc: identity is the fence; only the system fence logs people in; a token resolves only for its own user", async () => {
  const handler = (id: string) => createRpcHandler(kernel.userspaces.pathFor(id), kernel.users, kernel.packages, kernel.sessions, kernel.auth);
  const forAlice = handler("alice");
  const forBob = handler("bob");
  const forSystem = handler("_system");
  await assert.rejects(forAlice("auth.login", { id: "alice", password: "x" }), /only the system userspace/);
  await kernel.auth.setPassword("alice", "wonderland1");
  const login = (await forSystem("auth.login", { id: "alice", password: "wonderland1" })) as { token: string };
  assert.deepEqual(await forAlice("auth.authenticate", { token: login.token }), { id: "alice", role: "user" });
  assert.equal(await forBob("auth.authenticate", { token: login.token }), null, "bob's fence cannot resolve alice's token");
  assert.deepEqual(await forSystem("auth.authenticate", { token: login.token }), { id: "alice", role: "user" });
  await forBob("auth.logout", { token: login.token });
  assert.ok(await forAlice("auth.authenticate", { token: login.token }), "bob's fence cannot revoke alice's token");
  await forAlice("auth.logout", { token: login.token });
  assert.equal(await forAlice("auth.authenticate", { token: login.token }), null);
  const own = (await forAlice("sessions.list", {})) as { user: string }[];
  assert.ok(own.length > 0 && own.every((s) => s.user === "alice"));
  const events: TurnEvent[] = [];
  const created = (await forAlice("sessions.create", {})) as { id: string };
  await forAlice("sessions.send", { session: created.id, input: "streamed" }, (e) => events.push(e as TurnEvent));
  assert.ok(events.some((e) => e.type === "turn.end"));
  assert.throws(() => kernel.sessions.inspect("bob", created.id), /unknown session/);
});

test("rpc: a fence lists the models its providers serve, and a turn may name one", async () => {
  const forAlice = createRpcHandler(kernel.userspaces.pathFor("alice"), kernel.users, kernel.packages, kernel.sessions, kernel.auth, undefined, async (us) => ({ model: kernel.config.model, models: await kernel.providers.listModels(us) }));
  const choices = (await forAlice("models", {})) as { model: string; models: { id: string; provider?: string }[] };
  assert.equal(choices.model, "echo");
  assert.ok(choices.models.some((m) => m.id === "echo" && m.provider === "@thetis/provider-echo"));
  const s = (await forAlice("sessions.create", {})) as { id: string };
  const said = (turn: TurnEvent[]) => turn.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
  const byDefault: TurnEvent[] = [];
  await forAlice("sessions.send", { session: s.id, input: "model?" }, (e) => byDefault.push(e as TurnEvent));
  assert.equal(said(byDefault), "echo");
  const named: TurnEvent[] = [];
  await forAlice("sessions.send", { session: s.id, input: "model?", model: "echo-2" }, (e) => named.push(e as TurnEvent));
  assert.ok(named.some((e) => e.type === "error" && /echo-2/.test(e.message)), "a model no provider serves is refused by name");
  const r = await collect(kernel.sessions.send("alice", s.id, "model?", { model: "echo" }));
  assert.equal(r.text, "echo");
});

test("control socket: an operator client lists users, installs into the system userspace, and streams a turn", async () => {
  const path = join(home, "thetis.sock");
  const control = new ControlServer(path, createControlHandler(kernel));
  await control.listen();
  try {
    const socket = createConnection(path);
    await new Promise<void>((done, fail) => socket.once("connect", done).once("error", fail));
    const lines: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    createInterface({ input: socket }).on("line", (line) => {
      lines.push(JSON.parse(line));
      waiters.splice(0).forEach((w) => w());
    });
    const call = async (id: string, method: string, args: unknown) => {
      socket.write(JSON.stringify({ id, method, args }) + "\n");
      for (;;) {
        const done = lines.find((l) => l.id === id && ("result" in l || "error" in l));
        if (done) return done;
        await new Promise<void>((w) => waiters.push(w));
      }
    };
    assert.equal((await call("1", "ping", {})).result, "pong");
    const users = (await call("2", "users.list", {})).result as { id: string }[];
    assert.ok(users.some((u) => u.id === "alice"));
    const s = (await call("3", "sessions.create", { user: "alice" })).result as { id: string };
    const done = await call("4", "sessions.send", { user: "alice", session: s.id, input: "over the socket" });
    assert.equal(done.result, null);
    const text = lines.filter((l) => l.id === "4" && "event" in l).map((l) => l.event as TurnEvent).filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    assert.equal(text, "echo: over the socket (t1)");
    const bad = await call("5", "sessions.inspect", { user: "alice", session: "s_000000000000" });
    assert.match(String(bad.error), /unknown session/);
    assert.equal(bad.code, "not-found");
    assert.equal((await call("6", "nope", {})).code, "rpc");
    socket.end();
  } finally {
    await control.close();
  }
  assert.ok(!existsSync(path), "the socket file is removed on close");
});

test("suspended users cannot start turns", async () => {
  kernel.users.setStatus("bob", "suspended");
  assert.throws(() => kernel.sessions.create("bob"), /suspended/);
  kernel.users.setStatus("bob", "active");
});

test("fence isolation: a userspace cannot read the service plane or another userspace", async (t) => {
  const fence = kernel.container.get(T.fence) as ProcessFence;
  if (fence.mode !== "bwrap") return t.skip("bwrap sandbox unavailable; running unfenced");
  const s = kernel.sessions.create("alice");
  const bob = kernel.userspaces.pathFor("bob").root;
  // The service plane's data dir must be invisible except for the mount-point path to alice's own userspace.
  const data = join(home, "data");
  const probe = [
    `cat ${join(data, "users.json")} && echo LEAK-USERS`,
    `ls ${bob} && echo LEAK-BOB`,
    `ls -A ${data} | grep -v '^userspaces$' | grep -v '^packages$' | grep -v '^shared$' | grep . && echo LEAK-DATA`,
    `touch ${join(data, "shared", "x")} 2>/dev/null && echo LEAK-SHARED-WRITE`,
    `ls ${join(data, "packages", "hello", "package.json")} >/dev/null || echo NO-PROMOTED`,
    `ls -A ${join(data, "userspaces")} | grep -v '^alice$' | grep . && echo LEAK-USERSPACES`,
    `echo probe-done`,
  ].join("; ");
  const r = await collect(kernel.sessions.send("alice", s.id, `run: ${probe}`));
  assert.match(r.text, /probe-done/);
  assert.doesNotMatch(r.text, /LEAK-/);
  assert.doesNotMatch(r.text, /NO-PROMOTED/, "the promoted packages directory is readable inside the fence");
});

// End-to-end through the real process fence and userspace agent, with a deterministic
// provider fixture instead of the network. Exercises: seeding, prompt/tool steps, the tool
// loop, self-extension by installing a user package, RPC from inside the fence, and isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, T, type Kernel, type TurnEvent } from "../src/index.js";
import { defaultConfig } from "../src/config.js";
import { ProcessFence } from "../src/fence/process-fence.js";

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
  for (const name of ["harness-core", "tool-exec"]) symlinkSync(resolve(PROJECT, "packages", name), join(sys, name));
  symlinkSync(join(FIXTURES, "provider-echo"), join(sys, "provider-echo"));
  const config = defaultConfig(join(home, "data"), PROJECT);
  config.systemPackagesDir = sys;
  config.model = "echo";
  config.fence.sandbox = SANDBOX;
  config.fence.readOnly.push(sys, FIXTURES);
  config.systemPackages = { "*": ["@thetis/harness-core", "@thetis/tool-exec"], _system: ["@thetis/provider-echo"] };
  config.packages = { "@thetis/provider-echo": { tag: "t1" } };
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
  assert.deepEqual(names, ["@thetis/harness-core", "@thetis/tool-exec"]);
  assert.equal(kernel.sessions.inspect("alice", s.id).conversation.length, 2);
});

test("harness steps build the system prompt and attach tools", async () => {
  const s = kernel.sessions.create("alice");
  const sys = await collect(kernel.sessions.send("alice", s.id, "system?"));
  assert.match(sys.text, /You are Thetis/);
  assert.match(sys.text, /@thetis\/tool-exec/);
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
    `ls -A ${data} | grep -v '^userspaces$' | grep . && echo LEAK-DATA`,
    `ls -A ${join(data, "userspaces")} | grep -v '^alice$' | grep . && echo LEAK-USERSPACES`,
    `echo probe-done`,
  ].join("; ");
  const r = await collect(kernel.sessions.send("alice", s.id, `run: ${probe}`));
  assert.match(r.text, /probe-done/);
  assert.doesNotMatch(r.text, /LEAK-/);
});

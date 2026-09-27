// The tool over a fake `env.kernel.operator.call`. The point of nearly every case is
// the same: the sentence the kernel sent comes back byte for byte. Those sentences are the contract with the
// model — they say what happened, why, and what to do instead, and each refusal ends by making clear nothing
// happened — so a test that allowed a paraphrase would allow a fork of this package to change what the kernel
// says about itself. The exceptions are the sentences this package owns, and they are pinned too: the
// instruction added on `armed`, the plain sentence for an account that is not an admin, the refusal while an
// update is installing, and the refusal for a call with no reason, which never reaches the kernel at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as commands from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

/** An env whose operator answers from `answers` by method name and records every call, as the kernel's does. */
function fakeEnv(answers = {}, user = "root") {
  const calls = [];
  const env = {
    user,
    role: "admin",
    kernel: {
      operator: {
        call: async (method, args) => {
          calls.push({ method, args });
          const answer = answers[method];
          if (answer instanceof Error) throw answer;
          return typeof answer === "function" ? answer(args) : (answer ?? null);
        },
      },
    },
  };
  return { env, calls };
}

/** A coded error as the fence's RPC client builds one from the kernel's reply. */
function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

const REASON = "the kernel's control.ts changed and only a new process reads it";

test("an armed restart comes back as the kernel's own sentence, with the instruction to say it now", async () => {
  const message = "Restart armed: something (asked by root). Running replies pause at their next safe point and continue by themselves when Thetis is back (about 20 s).";
  const { env, calls } = fakeEnv({ "restart.request": { state: "armed", message, pending: { reason: REASON, by: "root" } } });
  const answer = await commands.restartDaemon({ reason: REASON }, env);
  assert.deepEqual(calls, [{ method: "host.update.progress", args: {} }, { method: "restart.request", args: { reason: REASON } }]);
  assert.ok(answer.startsWith(message), "the library's sentence comes first and unaltered");
  assert.match(answer, /This reply is one of them\. Tell the person in this same message, before anything else, what is restarting and why\./);
  assert.match(answer, /do not ask the person to continue\.$/);
  assert.equal(answer.slice(0, message.length), message, "nothing is inserted before it or inside it");
  assert.equal(answer.slice(message.length, message.length + 2), "\n\n", "one blank line, and then this package's own instruction");
});

test("a restart already armed comes back verbatim, with nothing added", async () => {
  const message = "A restart is already armed: an earlier reason (asked by root). Asking again changed nothing — it neither delayed that restart nor armed a second one.";
  const { env } = fakeEnv({ "restart.request": { state: "again", message, pending: { reason: "an earlier reason", by: "root" } } });
  assert.equal(await commands.restartDaemon({ reason: REASON }, env), message, "contention is not something to dress up");
});

test("every refusal comes back verbatim, whatever the kernel refused for", async () => {
  for (const why of ["off", "unsupervised", "no-listener", "young", "policy"]) {
    const message = `Refused, and nothing was restarted: ${why} is why. Nothing was armed and nothing is going to happen.`;
    const { env } = fakeEnv({ "restart.request": { state: "refused", why, message } });
    assert.equal(await commands.restartDaemon({ reason: REASON }, env), message, `${why} is passed through`);
  }
});

test("an unknown state is still the kernel's sentence, not a guess at what it meant", async () => {
  const message = "Something new happened, and this is what it was.";
  const { env } = fakeEnv({ "restart.request": { state: "deferred", message } });
  assert.equal(await commands.restartDaemon({ reason: REASON }, env), message);
});

test("a kernel that answers without a sentence is said to have done so, not assumed either way", async () => {
  for (const answer of [{ state: "armed" }, { state: "refused", message: "   " }, null]) {
    const { env } = fakeEnv({ "restart.request": answer });
    const out = await commands.restartDaemon({ reason: REASON }, env);
    assert.match(out, /without a sentence of its own/);
    assert.match(out, /thetis restart status/);
    assert.doesNotMatch(out, /Tell the person/, "an armed answer with no sentence is not announced as armed");
  }
});

test("a reason is required, and a blank one never reaches the kernel", async () => {
  const { env, calls } = fakeEnv({ "restart.request": { state: "armed", message: "armed" } });
  for (const args of [{}, { reason: "" }, { reason: "   " }, { reason: 7 }, { reason: null }, undefined]) {
    await assert.rejects(commands.restartDaemon(args, env), /a restart needs a reason, and this call gave none/);
  }
  assert.equal(calls.length, 0, "not one refused call reached the kernel");
  await assert.rejects(commands.restartDaemon({}, env), /Nothing was armed and nothing is going to happen\.$/);
});

test("a reason is trimmed, and sent as the only argument", async () => {
  const { env, calls } = fakeEnv({ "restart.request": { state: "armed", message: "armed" } });
  await commands.restartDaemon({ reason: `  ${REASON}\n`, deadlineMs: 5, confirmed: true }, env);
  assert.deepEqual(calls.filter((c) => c.method === "restart.request"), [{ method: "restart.request", args: { reason: REASON } }], "the deadline is configuration and confirmation is not a parameter");
});

test("an unauthorized kernel becomes one plain sentence, and never an error row", async () => {
  const { env, calls } = fakeEnv({ "restart.request": coded("only an admin may restart the daemon", "unauthorized") });
  const answer = await commands.restartDaemon({ reason: REASON }, env);
  assert.equal(calls.filter((c) => c.method === "restart.request").length, 1, "the kernel is what refuses; the package does not pre-judge the role");
  assert.match(answer, /^Restarting Thetis is an operator action/);
  assert.match(answer, /this account is not an admin/);
  assert.match(answer, /nothing happened and nothing was armed/);
  assert.match(answer, /control panel/);
  assert.match(answer, /thetis restart/);
  assert.doesNotMatch(answer, /unauthorized|only an admin may restart/, "the kernel's terse code and message are not what the model reads");
});

test("any other failure is not swallowed: only the admin refusal has an answer of its own", async () => {
  const { env } = fakeEnv({ "restart.request": coded("the control socket is gone", "rpc") });
  await assert.rejects(commands.restartDaemon({ reason: REASON }, env), /the control socket is gone/);
});

test("while an update is installing the restart is refused here, and the kernel is never asked", async () => {
  for (const running of [{ state: "running", phase: "building" }, { last: { state: "running" } }]) {
    const { env, calls } = fakeEnv({ "host.update.progress": running, "restart.request": { state: "armed", message: "armed" } });
    const answer = await commands.restartDaemon({ reason: REASON }, env);
    assert.match(answer, /^An update is installing; Thetis restarts by itself when it is done\. /);
    assert.match(answer, /Nothing was armed by this call, so do not ask again\.$/);
    assert.deepEqual(calls.map((c) => c.method), ["host.update.progress"]);
  }
});

test("an update that is not running, or no update package at all, does not stand in the way", async () => {
  for (const progress of [null, { state: "done", phase: "restarting" }, { state: "rolledback" }, coded("no host package named update", "not-found"), coded("only an admin", "unauthorized")]) {
    const { env, calls } = fakeEnv({ "host.update.progress": progress, "restart.request": { state: "armed", message: "armed" } });
    assert.match(await commands.restartDaemon({ reason: REASON }, env), /^armed\n\n/);
    assert.deepEqual(calls.map((c) => c.method), ["host.update.progress", "restart.request"]);
  }
});

test("the manifest declares one tool, no page and no bench", () => {
  const t = MANIFEST.thetis;
  assert.equal(t.type, "tool");
  assert.equal(MANIFEST.main, "index.js");
  assert.equal(MANIFEST.dependencies, undefined, "no dependency, so nothing to build and nothing to resolve");
  assert.equal(t.bench, undefined, "an admin-only tool must never change anyone's benchmark numbers");
  assert.deepEqual(
    t.tools.map((tool) => tool.name),
    ["restart_daemon"]
  );
  const [tool] = t.tools;
  assert.deepEqual(Object.keys(tool.parameters.properties), ["reason"], "the deadline is configuration, not an argument");
  assert.deepEqual(tool.parameters.required, ["reason"]);
  assert.equal(typeof commands[tool.export], "function");
  // The description is the contract with the model, and each of these is load-bearing.
  for (const phrase of ["`door` and `storage`", "Extension updates apply by themselves", "this one included", "ask_user", "two minutes", "shell sessions", "continue by themselves", "update is installing", "A refusal means nothing happened"]) {
    assert.ok(tool.description.includes(phrase), `the description must say: ${phrase}`);
  }
  for (const phrase of ["reloading a workspace", "thetis.config.json", "Nothing restarts while you are talking"]) {
    assert.ok(!tool.description.includes(phrase), `the description must not say: ${phrase}`);
  }
  assert.equal(t.ui, undefined, "the restart countdown is gateway-web's, shown to everyone; this package draws nothing");
  assert.deepEqual(Object.keys(commands), ["restartDaemon"], "the one export is the tool");
});

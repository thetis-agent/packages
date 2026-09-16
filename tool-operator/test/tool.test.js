// The tool and the three commands over a fake `env.kernel.operator.call`. The point of nearly every case is
// the same: the sentence the kernel sent comes back byte for byte. Those sentences are the contract with the
// model — they say what happened, why, and what to do instead, and each refusal ends by making clear nothing
// happened — so a test that allowed a paraphrase would allow a fork of this package to change what the kernel
// says about itself. The exceptions are the three sentences this package owns, and they are pinned too: the
// instruction added on `armed`, the plain sentence for an account that is not an admin, and the refusal for a
// call with no reason, which never reaches the kernel at all.
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
  const message = "A restart is armed: something (asked by root). Nothing has happened yet, and nothing will until this turn is over.";
  const { env, calls } = fakeEnv({ "restart.request": { state: "armed", message, pending: { reason: REASON, by: "root" } } });
  const answer = await commands.restartDaemon({ reason: REASON }, env);
  assert.deepEqual(calls, [{ method: "restart.request", args: { reason: REASON } }]);
  assert.ok(answer.startsWith(message), "the library's sentence comes first and unaltered");
  assert.match(answer, /Tell the person now, in this reply/);
  assert.match(answer, /only warning they get\.$/);
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
    assert.doesNotMatch(out, /Tell the person now/, "an armed answer with no sentence is not announced as armed");
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
  assert.deepEqual(calls, [{ method: "restart.request", args: { reason: REASON } }], "the deadline is configuration and confirmation is not a parameter");
});

test("an unauthorized kernel becomes one plain sentence, and never an error row", async () => {
  const { env, calls } = fakeEnv({ "restart.request": coded("only an admin may restart the daemon", "unauthorized") });
  const answer = await commands.restartDaemon({ reason: REASON }, env);
  assert.equal(calls.length, 1, "the kernel is what refuses; the package does not pre-judge the role");
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

test("restart-status reads the latch, and says nothing of its own", async () => {
  const state = { startedAt: 1, uptimeSecs: 300, supervised: true, armable: true, pending: null };
  const { env, calls } = fakeEnv({ "restart.status": state });
  assert.deepEqual(await commands.uiStatus({}, env), { data: state });
  assert.deepEqual(calls, [{ method: "restart.status", args: {} }]);
});

test("restart-cancel says what it called off, and says plainly when there was nothing", async () => {
  const was = { reason: REASON, by: "root", at: 1, deadlineAt: 2 };
  const { env } = fakeEnv({ "restart.cancel": { cancelled: true, was } });
  const out = await commands.uiCancel({}, env);
  assert.deepEqual(out.data, { cancelled: true, was });
  assert.match(out.text, /Called off the restart root asked for: /);
  const { env: empty } = fakeEnv({ "restart.cancel": { cancelled: false, was: null } });
  const none = await commands.uiCancel({}, empty);
  assert.deepEqual(none.data, { cancelled: false, was: null });
  assert.match(none.text, /Nothing was armed, so nothing was called off and nothing changed\./, "an empty cancel is not a failure");
});

test("restart-now needs a reason too, and answers with the latch's sentence", async () => {
  const { env, calls } = fakeEnv({ "restart.request": (a) => ({ state: "armed", message: `armed: ${a.reason}` }) });
  const out = await commands.uiRestart({ reason: `  ${REASON} ` }, env);
  assert.deepEqual(out.data, { state: "armed", message: `armed: ${REASON}` });
  assert.equal(out.text, `armed: ${REASON}`, "the page reads the same words as the model and the host");
  await assert.rejects(commands.uiRestart({ reason: " " }, env), /A restart needs a reason/);
  assert.equal(calls.length, 1, "a page that sends no reason is refused before the kernel is asked");
});

test("the manifest declares one tool and three commands, and no bench", () => {
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
  for (const phrase of ["reloading a workspace", "ask_user", "two minutes", "shell sessions", "A refusal means nothing happened"]) {
    assert.ok(tool.description.includes(phrase), `the description must say: ${phrase}`);
  }
  assert.deepEqual(
    t.ui.commands.map((c) => c.verb),
    ["restart-status", "restart-cancel", "restart-now"]
  );
  for (const c of t.ui.commands) {
    assert.equal(typeof commands[c.export], "function", `${c.verb} names an export that exists`);
    assert.equal(c.role, undefined, "authority here is what is installed; there is no role plumbing");
  }
  assert.deepEqual(t.ui.statusbar, [{ id: "restart", order: 90 }]);
});

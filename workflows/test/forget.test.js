// The forget hook, with the service up (through its socket), down (the run files directly), and there but
// not answering (nothing is touched, and the receipt says what stayed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { forgetSession } from "../index.js";
import { startHost, SOCKET } from "../lib/host.js";
import { connect } from "../lib/client.js";
import { newRun, readRun, writeRun } from "../lib/runs.js";
import { fakeKernel, makeEnv } from "./helpers.js";

const definition = { id: "wf_1a2b3c4d", version: 1, name: "Fix bugs", start: "plan" };

/** A run that opened `conversations`, titled each, in `state`. */
function runOf(id, number, state, conversations) {
  const run = newRun({ definition, input: "x", number, costCapUsd: 40, id, now: `2026-10-19T10:00:0${number}.000Z` });
  run.state = state;
  run.conversations = conversations;
  run.titles = Object.fromEntries(conversations.map((s) => [s, `Title of ${s}`]));
  return run;
}

async function home(t, runs) {
  const f = await makeEnv({ kernel: fakeKernel() });
  for (const r of runs) await writeRun(f.home, r);
  t.after(f.done);
  return f;
}

async function withHost(t, f) {
  const host = await startHost(f.env, { user: "alice" });
  t.after(() => host.stop());
  await host.service.ready;
  return host;
}

const preview = (env, sessions) => forgetSession({ phase: "preview", session: sessions[0], sessions }, env);
const forget = (env, sessions, opts) => forgetSession({ phase: "forget", session: sessions[0], sessions }, env, opts);

test("preview blocks while a run that uses the conversation is active, from the files when no service listens", async (t) => {
  const f = await home(t, [runOf("r_0000000001", 1, "waiting", ["s_a"]), runOf("r_0000000002", 2, "done", ["s_b"])]);
  const blocked = await preview(f.env, ["s_a", "s_child"]);
  assert.match(blocked.block, /still going \(Fix bugs #1\)/);
  assert.deepEqual(await preview(f.env, ["s_b"]), {}, "a finished run never blocks");
  assert.deepEqual(await preview(f.env, ["s_none"]), {});
});

test("preview asks the service when it answers", async (t) => {
  const f = await home(t, [runOf("r_0000000001", 1, "waiting", ["s_a"])]);
  const host = await withHost(t, f);
  assert.match((await preview(f.env, ["s_a"])).block, /Fix bugs #1/);
  await host.service.ops.cancel({ id: "r_0000000001" });
  assert.deepEqual(await preview(f.env, ["s_a"]), {});
});

test("forget through the service removes the titles from memory and disk, keeps the runs, and is idempotent", async (t) => {
  const f = await home(t, [runOf("r_0000000001", 1, "done", ["s_a", "s_keep"]), runOf("r_0000000002", 2, "failed", ["s_child"]), runOf("r_0000000003", 3, "done", ["s_other"])]);
  await withHost(t, f);
  const out = await forget(f.env, ["s_a", "s_child"]);
  assert.deepEqual(out.removed, ["2 conversation titles that workflow runs kept."]);
  assert.deepEqual(out.kept, ["2 workflow runs (Fix bugs #1, Fix bugs #2) keep their own record of the steps that ran in it."]);
  const c = await connect(f.home);
  t.after(() => c.close());
  assert.deepEqual(Object.keys(await c.request("conversations")).sort(), ["s_keep", "s_other"], "the service no longer names them");
  assert.deepEqual((await readRun(f.home, "r_0000000001")).titles, { s_keep: "Title of s_keep" });
  assert.deepEqual((await readRun(f.home, "r_0000000002")).titles, {});
  assert.deepEqual((await readRun(f.home, "r_0000000001")).conversations, ["s_a", "s_keep"], "the run's record of its work stays");
  const again = await forget(f.env, ["s_a", "s_child"]);
  assert.deepEqual(again.removed, []);
});

test("forget with no service listening rewrites the run files, and is idempotent", async (t) => {
  const f = await home(t, [runOf("r_0000000001", 1, "done", ["s_a"]), runOf("r_0000000002", 2, "done", ["s_other"])]);
  const out = await forget(f.env, ["s_a"]);
  assert.deepEqual(out, { removed: ["1 conversation title that workflow runs kept."], kept: ["1 workflow run (Fix bugs #1) keeps its own record of the steps that ran in it."] });
  assert.deepEqual((await readRun(f.home, "r_0000000001")).titles, {});
  assert.deepEqual((await readRun(f.home, "r_0000000002")).titles, { s_other: "Title of s_other" });
  assert.deepEqual((await forget(f.env, ["s_a"])).removed, []);
  const bare = await makeEnv();
  t.after(bare.done);
  assert.deepEqual(await forget(bare.env, ["s_a"]), { removed: [] });
});

test("a service that is there but does not answer, or is too old to know the op, keeps the titles and says so", async (t) => {
  const f = await home(t, [runOf("r_0000000001", 1, "done", ["s_a"])]);
  await mkdir(resolve(f.home, "run"), { recursive: true });
  const path = resolve(f.home, "run", SOCKET);
  let mode = "silent";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line) => {
      if (mode === "old") socket.write(`${JSON.stringify({ i: JSON.parse(line).i, ok: false, error: 'There is no op named "forgetConversations"; the ops are list, runs.' })}\n`);
    });
  });
  await new Promise((done) => server.listen(path, done));
  t.after(() => new Promise((done) => server.close(done)).then(() => rm(path, { force: true })));
  const silent = await forget(f.env, ["s_a"], { timeoutMs: 100 });
  assert.deepEqual(silent.removed, []);
  assert.match(silent.kept[0], /stay in their records: the workflow service did not answer/);
  mode = "old";
  const old = await forget(f.env, ["s_a"], { timeoutMs: 1000 });
  assert.match(old.kept[0], /older than this version/);
  assert.deepEqual((await readRun(f.home, "r_0000000001")).titles, { s_a: "Title of s_a" }, "a file the service may hold is never rewritten");
});

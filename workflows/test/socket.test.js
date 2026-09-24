// The service over its socket, with a temporary directory as both root and home and the fake kernel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startHost, SOCKET } from "../lib/host.js";
import { connect } from "../lib/client.js";
import { startWorkflows, uiCall, uiWatch } from "../index.js";
import { newRun } from "../lib/runs.js";
import { fakeKernel, makeEnv, reply, text, until } from "./helpers.js";

const definition = (id) => ({
  id,
  name: "Fix bugs",
  description: "Plan and check.",
  project: "p_624f67bc",
  input: { kind: "lines", label: "Links" },
  start: "plan",
  steps: {
    plan: { type: "prompt", model: "fable", conversation: "new", title: "Fix {{input}}", prompt: "Plan it.", budget: { toolCalls: 20 }, next: "check" },
    check: { type: "parse", from: "plan", fields: { result: "RESULT: (\\w+)" }, next: "finish" },
    finish: { type: "done", summary: "{{check.result}}" },
  },
  layout: { plan: { x: 0, y: 0 } },
});

async function withHost(t, { script = () => reply("RESULT: PASS"), config = {}, before } = {}) {
  const kernel = fakeKernel(script, { packages: [{ name: "@thetis/notion", thetis: { tools: [{ name: "notion_fetch", export: "fetch", description: "Fetch a page" }] } }] });
  const f = await makeEnv({ kernel });
  f.env.config = config;
  if (before) await before(f);
  const host = await startHost(f.env, { user: "alice" });
  const client = await connect(f.home);
  t.after(async () => {
    client.close();
    await host.stop();
    await f.done();
  });
  return { ...f, host, client };
}

test("the socket is at run/workflows.sock with mode 0600", async (t) => {
  const { home, host } = await withHost(t);
  assert.equal(host.socket, resolve(home, "run", SOCKET));
  assert.equal((await stat(host.socket)).mode & 0o777, 0o600);
});

test("create, save, publish, enqueue, and watch the runs finish over the socket", async (t) => {
  const { client, home, kernel } = await withHost(t);
  const watcher = await connect(home);
  t.after(() => watcher.close());
  const events = [];
  const snap = await watcher.subscribe((e) => events.push(e));
  assert.deepEqual(snap, { runs: [] });

  const draft = await client.request("create", { name: "Fix bugs" });
  assert.match(draft.id, /^wf_[0-9a-f]{8}$/);
  assert.equal(draft.version, 1);

  await assert.rejects(client.request("enqueue", { id: draft.id, text: "a" }), /never been published/);

  const saved = await client.request("save", { id: draft.id, definition: { ...definition("wf_ignored"), version: 99 } });
  assert.equal(saved.draft.id, draft.id);
  assert.equal(saved.draft.version, 1);
  assert.equal(saved.validation.ok, true, JSON.stringify(saved.validation));

  const pub = await client.request("publish", { id: draft.id });
  assert.equal(pub.version, 1);
  const got = await client.request("get", { id: draft.id });
  assert.deepEqual(got.versions, [1]);
  assert.equal(got.published.version, 1);
  assert.equal(got.draft.version, 2);

  const { runs } = await client.request("enqueue", { id: draft.id, text: "bug-a\n\n  bug-b  \n" });
  assert.deepEqual(runs.map((r) => [r.input, r.number, r.state, r.version, r.costCapUsd]), [["bug-a", 1, "queued", 1, 40], ["bug-b", 2, "queued", 1, 40]]);
  assert.equal("vars" in runs[0], false);

  await until(async () => (await client.request("runs", {})).every((r) => r.state === "done"), 3000, "both runs to finish");
  const list = await client.request("runs", { workflow: draft.id });
  assert.deepEqual(list.map((r) => r.number), [2, 1]);
  assert.ok(list.every((r) => !("vars" in r)));
  const one = await client.request("run", { id: runs[0].id });
  assert.equal(one.vars.check.result, "PASS");
  assert.equal(one.reason, "PASS");
  // concurrency 1: the second conversation opened after the first run ended
  assert.equal(kernel.sends[0].input, "Fix bug-a\n\nPlan it.");
  assert.equal(kernel.sends[1].input, "Fix bug-b\n\nPlan it.");
  const assignments = JSON.parse(await readFile(resolve(home, "projects/sessions.json"), "utf8"));
  assert.equal(Object.keys(assignments).length, 2);

  // the record on disk is the whole run
  const onDisk = JSON.parse(await readFile(resolve(home, `workflows/runs/${runs[0].id}.json`), "utf8"));
  assert.equal(onDisk.state, "done");
  assert.equal(onDisk.vars.check.result, "PASS");

  await until(() => events.filter((e) => e.ev === "run" && e.run.state === "done").length >= 2, 1000, "done events");
  assert.ok(events.some((e) => e.ev === "workflow" && e.id === draft.id));
  assert.ok(events.some((e) => e.ev === "queue"));
  assert.ok(events.filter((e) => e.ev === "run").every((e) => !("vars" in e.run)));

  const all = await client.request("list");
  assert.equal(all.length, 1);
  assert.deepEqual({ ...all[0], updatedAt: null }, { id: draft.id, name: "Fix bugs", description: "Plan and check.", published: 1, draftVersion: 2, updatedAt: null, runs: { total: 2, active: 0, needs: 0, lastAt: all[0].runs.lastAt } });
});

test("publish refuses a definition with errors, naming the first", async (t) => {
  const { client } = await withHost(t);
  const draft = await client.request("create", { name: "Broken" });
  const saved = await client.request("save", { id: draft.id, definition: { ...definition(draft.id), start: "ghost" } });
  assert.equal(saved.validation.ok, false);
  await assert.rejects(client.request("publish", { id: draft.id }), /cannot be published until its errors are fixed: The start step "ghost" does not exist/);
  const v = await client.request("validate", { definition: definition(draft.id) });
  assert.equal(v.ok, true);
});

test("arguments are checked and refusals are sentences", async (t) => {
  const { client } = await withHost(t);
  await assert.rejects(client.request("get", { id: "nope" }), /is not a workflow id/);
  await assert.rejects(client.request("get", { id: "wf_00000000" }), /There is no workflow wf_00000000/);
  await assert.rejects(client.request("run", {}), /id is required/);
  await assert.rejects(client.request("create", {}), /name is required/);
  await assert.rejects(client.request("teleport"), /There is no op named "teleport"/);
  await assert.rejects(client.request("queue", { paused: "yes" }), /paused must be true or false/);
});

test("pause holds queued runs; cancel ends a running one and cancels its turn", async (t) => {
  const { client, kernel } = await withHost(t, { script: () => [{ hang: true }] });
  const draft = await client.request("create", { name: "Hang" });
  await client.request("save", { id: draft.id, definition: definition(draft.id) });
  await client.request("publish", { id: draft.id });
  assert.deepEqual(await client.request("queue", { paused: true }), { paused: true, running: [], queued: 0 });
  const { runs } = await client.request("enqueue", { id: draft.id, text: "one" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await client.request("run", { id: runs[0].id })).state, "queued");
  const q = await client.request("queue", { paused: false });
  assert.equal(q.paused, false);
  await until(() => kernel.sends.length === 1, 2000, "the turn to start");
  const cancelled = await client.request("cancel", { id: runs[0].id });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.history[0].status, "failed");
  assert.ok(kernel.cancels.includes(kernel.sends[0].session));
  await assert.rejects(client.request("cancel", { id: runs[0].id }), /already ended/);
  const again = await client.request("retry", { id: runs[0].id });
  assert.equal(again.state, "queued");
});

test("approve over the socket carries a waiting run on", async (t) => {
  const { client } = await withHost(t);
  const draft = await client.request("create", { name: "Ask" });
  await client.request("save", {
    id: draft.id,
    definition: { ...definition(draft.id), input: { kind: "text" }, start: "ask", steps: { ask: { type: "approval", message: "Go?", next: "finish" }, finish: { type: "done", summary: "went: {{ask.note}}" } } },
  });
  await client.request("publish", { id: draft.id });
  const { runs } = await client.request("enqueue", { id: draft.id, text: "line one\nline two" });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].input, "line one\nline two");
  await until(async () => (await client.request("run", { id: runs[0].id })).state === "waiting", 2000, "waiting");
  await client.request("approve", { id: runs[0].id, decision: "approved", note: "yes" });
  await until(async () => (await client.request("run", { id: runs[0].id })).state === "done", 2000, "done");
  assert.equal((await client.request("run", { id: runs[0].id })).reason, "went: yes");
});

test("catalog lists models, projects and tools", async (t) => {
  const { client, home } = await withHost(t);
  await mkdir(resolve(home, "projects"), { recursive: true });
  await writeFile(resolve(home, "projects/p_624f67bc.json"), JSON.stringify({ id: "p_624f67bc", name: "Nova Island" }));
  const c = await client.request("catalog");
  assert.deepEqual(c.models, [{ id: "fable", label: "FABLE" }, { id: "opus", label: "OPUS" }, { id: "sonnet", label: "SONNET" }]);
  assert.equal(c.defaultModel, "fable");
  assert.deepEqual(c.projects, [{ id: "p_624f67bc", name: "Nova Island" }]);
  assert.deepEqual(c.tools, [{ package: "@thetis/notion", export: "fetch", name: "notion_fetch", description: "Fetch a page" }]);
});

test("a run left running is resumed when the service starts", async (t) => {
  const def = { ...definition("wf_1a2b3c4d"), version: 1 };
  const { client, kernel } = await withHost(t, {
    before: async ({ home, kernel }) => {
      await mkdir(resolve(home, "workflows/defs/wf_1a2b3c4d"), { recursive: true });
      await writeFile(resolve(home, "workflows/defs/wf_1a2b3c4d/draft.json"), JSON.stringify({ ...def, version: 2 }));
      await writeFile(resolve(home, "workflows/defs/wf_1a2b3c4d/v1.json"), JSON.stringify(def));
      kernel.sessions._set("s_old001", { conversation: [{ role: "user", content: text("Fix a") }, { role: "assistant", content: text("RESULT: FAIL") }] });
      const run = newRun({ definition: def, input: "a", number: 1, costCapUsd: 40, id: "r_00000000bb" });
      run.state = "running";
      run.conversations = ["s_old001"];
      run.history.push({ step: "plan", type: "prompt", status: "running", startedAt: new Date().toISOString(), model: "fable", conversation: "s_old001", toolCalls: 0, tokens: 0, cost: 0, ms: 0, breaches: 0, activity: [] });
      await mkdir(resolve(home, "workflows/runs"), { recursive: true });
      await writeFile(resolve(home, "workflows/runs/r_00000000bb.json"), JSON.stringify(run));
    },
  });
  await until(async () => (await client.request("run", { id: "r_00000000bb" })).state === "done", 2000, "the resumed run to finish");
  const run = await client.request("run", { id: "r_00000000bb" });
  assert.equal(run.reason, "FAIL");
  assert.equal(kernel.sends.length, 0);
});

test("stop lets go of a running run without cancelling it; the next start resumes it", async (t) => {
  const kernel = fakeKernel(() => [{ hang: true }]);
  const f = await makeEnv({ kernel });
  t.after(f.done);
  const service = await startWorkflows(f.env);
  const draft = (await uiCall({ op: "create", name: "Long" }, { root: f.home })).data;
  await uiCall({ op: "save", id: draft.id, definition: definition(draft.id) }, { root: f.home });
  await uiCall({ op: "publish", id: draft.id }, { root: f.home });
  const { runs } = (await uiCall({ op: "enqueue", id: draft.id, text: "x" }, { root: f.home })).data;
  await until(() => kernel.sends.length === 1, 2000, "the turn to start");
  await service.stop();
  const onDisk = JSON.parse(await readFile(resolve(f.home, `workflows/runs/${runs[0].id}.json`), "utf8"));
  assert.equal(onDisk.state, "running");
  await assert.rejects(uiCall({ op: "list" }, { root: f.home }), /the workflow service is not running/);

  // the conversation is left with a user message last, so the restart sends the continue message
  const again = await startWorkflows(f.env);
  t.after(() => again.stop());
  await until(() => kernel.sends.length === 2, 2000, "the continue message");
  assert.match(kernel.sends[1].input, /interrupted by a restart/);
});

test("uiCall checks the op, and uiWatch yields the snapshot then events", async (t) => {
  const { home, client } = await withHost(t);
  await assert.rejects(uiCall({}, { root: home }), /op is required/);
  await assert.rejects(uiCall({ op: "subscribe" }, { root: home }), /There is no op named "subscribe"/);
  const abort = new AbortController();
  const it = uiWatch({}, { root: home, signal: abort.signal })[Symbol.asyncIterator]();
  const first = await it.next();
  assert.deepEqual(first.value, { ev: "snapshot", runs: [] });
  const next = it.next();
  await client.request("create", { name: "Watched" });
  const second = await next;
  assert.equal(second.value.ev, "workflow");
  abort.abort();
  const end = await it.next();
  assert.equal(end.done, true);
});

// The session table, the socket, and the limits. Every request here goes over the real socket through
// `client.js`, because the socket is the seam the package exists to have: a test that called the ops
// directly would be testing the half that is easy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startHost, capAnswer, ANSWER_CHARS, MAX_SESSIONS, IDLE_MINUTES, SOCKET } from "../lib/host.js";
import { connect } from "../lib/client.js";

async function withHost(t, config = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "thetis-host-"));
  const host = await startHost({ root, cwd: root, config, log: () => {} });
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.close();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  });
  const client = async () => {
    const c = await connect(root);
    clients.push(c);
    return c;
  };
  return { root, host, client };
}

test("the socket is where the package says it is, and only this person can open it", async (t) => {
  const { root, host } = await withHost(t);
  assert.equal(host.socket, resolve(root, "run", SOCKET));
  const st = await stat(host.socket);
  assert.equal(st.mode & 0o777, 0o600);
});

test("a command sent over the socket comes back with its status and its output", async (t) => {
  const { client } = await withHost(t);
  const c = await client();
  const answer = await c.request("run", { conversation: "conv-1", cmd: "echo over-the-socket", consumer: "conv-1" });
  assert.equal(answer.exit, 0);
  assert.equal(answer.output, "over-the-socket\n");
  assert.equal(answer.name, "main", "the first command opens the conversation's main session");
});

test("the session names are main, then 2, then 3", async (t) => {
  const { client } = await withHost(t, { sessions: 3 });
  const c = await client();
  await c.request("run", { conversation: "conv-1", cmd: "true", consumer: "conv-1" });
  assert.equal((await c.request("open", { conversation: "conv-1" })).name, "2");
  assert.equal((await c.request("open", { conversation: "conv-1" })).name, "3");
});

test("the session limit is the one the config names, and the refusal says how to free one", async (t) => {
  const { client } = await withHost(t, { sessions: 2 });
  const c = await client();
  await c.request("open", {});
  await c.request("open", {});
  await assert.rejects(() => c.request("open", {}), /already 2 shell sessions.*shell_sessions/s);
});

test("list is scoped to the conversation that asks for it", async (t) => {
  const { client } = await withHost(t, { sessions: 4 });
  const c = await client();
  await c.request("open", { conversation: "conv-a" });
  await c.request("open", { conversation: "conv-b" });
  assert.equal((await c.request("list", {})).length, 2);
  const mine = await c.request("list", { conversation: "conv-a" });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].conversation, "conv-a");
});

test("a request naming a session that does not exist is refused by name", async (t) => {
  const { client } = await withHost(t);
  const c = await client();
  await assert.rejects(() => c.request("read", { id: "not-a-session", consumer: "conv" }), /no session "not-a-session"/);
  await assert.rejects(() => c.request("close", { id: "not-a-session" }), /no session/);
});

test("an op the host does not have is refused by name", async (t) => {
  const { client } = await withHost(t);
  const c = await client();
  await assert.rejects(() => c.request("sudo", {}), /no op named "sudo"/);
});

test("two consumers hold independent cursors over one session", async (t) => {
  const { client } = await withHost(t);
  const c = await client();
  const opened = await c.request("open", { conversation: "conv-1" });
  await c.request("run", { id: opened.id, cmd: "echo alpha", consumer: "conv-1" });

  const browser = await c.request("read", { id: opened.id, consumer: "ui:one" });
  assert.match(browser.output, /alpha/, "a cursor that has never read is given what the ring still holds");

  await c.request("run", { id: opened.id, cmd: "echo beta", consumer: "conv-1" });
  const agentAgain = await c.request("read", { id: opened.id, consumer: "conv-1" });
  assert.doesNotMatch(agentAgain.output, /beta/, "the agent was already handed beta by run");

  const browserAgain = await c.request("read", { id: opened.id, consumer: "ui:one" });
  assert.match(browserAgain.output, /beta/, "the browser had not seen it, so it still gets it");
});

test("a subscriber is sent a snapshot, then the output and the state of what happens next", async (t) => {
  const { client } = await withHost(t);
  const watcher = await client();
  const worker = await client();
  const opened = await worker.request("open", { conversation: "conv-1", name: "one" });

  const events = [];
  const snapshot = await watcher.subscribe(undefined, (e) => events.push(e), { consumer: "ui:one" });
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].name, "one");

  await worker.request("run", { id: opened.id, cmd: "echo streamed", consumer: "conv-1" });
  await new Promise((r) => setTimeout(r, 150));

  const output = events.filter((e) => e.ev === "output");
  assert.ok(output.some((e) => e.text.includes("streamed")));
  assert.ok(output.every((e) => e.id === opened.id && typeof e.seq === "number"));
  assert.ok(events.some((e) => e.ev === "state" && e.session.id === opened.id));
  assert.ok(events.some((e) => e.ev === "state" && e.session.state === "busy"));

  await worker.request("close", { id: opened.id });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(events.some((e) => e.ev === "closed" && e.id === opened.id));
});

test("a subscriber that asks for a replay is given what the ring still holds", async (t) => {
  const { client } = await withHost(t);
  const worker = await client();
  const opened = await worker.request("open", { conversation: "conv-1" });
  await worker.request("run", { id: opened.id, cmd: "echo earlier", consumer: "conv-1" });

  const watcher = await client();
  const events = [];
  await watcher.subscribe(0, (e) => events.push(e), { consumer: "ui:two" });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(events.some((e) => e.ev === "output" && e.text.includes("earlier")));
});

test("an attached browser is counted as a watcher, and stops being one when it goes", async (t) => {
  const { client } = await withHost(t);
  const worker = await client();
  const opened = await worker.request("open", { conversation: "conv-1" });
  assert.equal((await worker.request("list", {}))[0].watchers, 0);

  const watcher = await client();
  await watcher.subscribe(undefined, () => {}, { consumer: "ui:one" });
  assert.equal((await worker.request("list", {}))[0].watchers, 1);

  watcher.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await worker.request("list", {}))[0].watchers, 0);
  assert.equal(opened.watchers, 0);
});

test("the idle reaper closes a session with no viewer and nothing running", async (t) => {
  const { client } = await withHost(t, { idleMinutes: 0.01 }); // 600 ms, so the test is a test and not a wait
  const c = await client();
  const opened = await c.request("open", { conversation: "conv-1" });
  await new Promise((r) => setTimeout(r, 1_800));
  const rows = await c.request("list", {});
  const row = rows.find((s) => s.id === opened.id);
  assert.equal(row.state, "closed");
  assert.ok(row.closedAt);
});

test("the idle reaper leaves a session alone while a browser is watching it", async (t) => {
  const { client } = await withHost(t, { idleMinutes: 0.01 });
  const worker = await client();
  const watcher = await client();
  const opened = await worker.request("open", { conversation: "conv-1" });
  await watcher.subscribe(undefined, () => {}, { consumer: "ui:one" });
  await new Promise((r) => setTimeout(r, 1_800));
  const row = (await worker.request("list", {})).find((s) => s.id === opened.id);
  assert.notEqual(row.state, "closed");
});

test("closing the host closes every session in it", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "thetis-host-"));
  const host = await startHost({ root, cwd: root, config: {}, log: () => {} });
  const c = await connect(root);
  await c.request("open", { conversation: "conv-1" });
  await c.request("open", { conversation: "conv-2" });
  assert.equal(host.sessions().length, 2);

  c.close();
  await host.stop();
  assert.equal(host.sessions().length, 0);
  await assert.rejects(() => connect(root), /terminal service is not running/);
  await rm(root, { recursive: true, force: true });
});

test("connecting where no host is listening says what a person can do about it", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "thetis-none-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => connect(root), /the terminal service is not running in this workspace/);
});

test("a session can be renamed, and the new name is what the list says", async (t) => {
  const { client } = await withHost(t);
  const c = await client();
  const opened = await c.request("open", { conversation: "conv-1" });
  assert.equal((await c.request("rename", { id: opened.id, name: "build" })).name, "build");
  assert.equal((await c.request("list", {}))[0].name, "build");
  await assert.rejects(() => c.request("rename", { id: opened.id, name: "  " }), /name is required/);
});

test("who typed is read from the cursor key, not claimed by the caller", async (t) => {
  const { client } = await withHost(t);
  const c = await client();
  const opened = await c.request("open", { conversation: "conv-1" });
  await c.request("run", { id: opened.id, cmd: "true", consumer: "conv-1" });

  const typed = await c.request("write", { id: opened.id, text: "sleep 2", submit: true, consumer: "ui:one" });
  assert.equal(typed.session.state, "person");
  assert.equal(typed.session.holder, "person");

  const stopped = await c.request("interrupt", { id: opened.id });
  assert.equal(stopped.session.state, "idle");
});

test("a resize while a command is running is applied over the socket, and the row carries the tty", async (t) => {
  const { client } = await withHost(t);
  const c = await client();
  const opened = await c.request("open", { conversation: "conv-1" });
  await c.request("run", { id: opened.id, cmd: "true", consumer: "conv-1" });
  assert.match((await c.request("list", {}))[0].tty, /^\/dev\/pts\/\d+$/);
  await c.request("run", { id: opened.id, cmd: "sleep 1", timeoutMs: 200, consumer: "conv-1" });
  const applied = await c.request("resize", { id: opened.id, rows: 40, cols: 100 });
  assert.equal(applied.applied, true);
  assert.equal(applied.deferred, false);
  assert.equal(applied.id, opened.id);
  await c.request("interrupt", { id: opened.id });
});

test("a resize while a command is running in a shell without the rc answers that it was deferred", async (t) => {
  const { client } = await withHost(t, { shell: "/bin/sh" });
  const c = await client();
  const opened = await c.request("open", { conversation: "conv-1" });
  assert.equal(opened.tty, null);
  await c.request("run", { id: opened.id, cmd: "sleep 1", timeoutMs: 200, consumer: "conv-1" });
  const deferred = await c.request("resize", { id: opened.id, rows: 40, cols: 100 });
  assert.equal(deferred.applied, false);
  assert.equal(deferred.deferred, true);
  assert.match(deferred.reason, /a command is running/);
});

test("an answer longer than the cap keeps the head and the tail and says what is missing", () => {
  const text = "x".repeat(100_000);
  const capped = capAnswer(text);
  assert.ok(capped.length <= ANSWER_CHARS);
  assert.match(capped, /characters not shown; the middle of the output/);
  assert.ok(capped.startsWith("xxxx"));
  assert.ok(capped.endsWith("xxxx"));
  assert.equal(capAnswer("short"), "short", "text under the cap is not touched");
});

test("an agent's answer is capped and a browser's is not", async (t) => {
  const { client } = await withHost(t);
  const c = await client();
  const opened = await c.request("open", { conversation: "conv-1" });
  const big = await c.request("run", { id: opened.id, cmd: "seq 1 12000", timeoutMs: 20_000, consumer: "conv-1" });
  assert.ok(big.output.length <= ANSWER_CHARS);
  assert.match(big.output, /characters not shown/);

  const browser = await c.request("read", { id: opened.id, consumer: "ui:one" });
  assert.ok(browser.output.length > ANSWER_CHARS, "the browser is streaming it anyway, so nothing is hidden from it");
});

test("the documented defaults are the ones the code uses", () => {
  assert.equal(MAX_SESSIONS, 8);
  assert.equal(IDLE_MINUTES, 30);
  assert.equal(ANSWER_CHARS, 30_000);
});

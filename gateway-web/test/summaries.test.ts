import { textContent } from "@thetis/runtime/lib/content";
// The gateway over a fake kernel: the session list is built from summaries without reading a record, the
// hub picks up a turn the kernel replays on watch, the store keeps one file per conversation and migrates
// the old single file, and the models answer is trimmed and served from a cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { KernelClient, SessionSummaryRef, WatchedTurnEvent } from "@thetis/runtime/contracts";
import { createGateway } from "../src/server.js";
import { GatewayStore } from "../src/store.js";
import { TurnHub } from "../src/turns.js";

type Summary = SessionSummaryRef & { first?: string; last?: string; running?: boolean };
const COOKIE = "thetis_web=" + "a".repeat(64);

/** A kernel that answers the calls these tests make and counts them; anything else throws. */
function fakeKernel(summaries: Summary[], models = { model: "echo", models: [{ id: "echo", name: "Echo", provider: "@thetis/provider-echo", pricing: { prompt: 0 }, context_length: 1 }] }) {
  const calls: Record<string, number> = {};
  const count = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);
  const kernel = {
    auth: { authenticate: async () => ({ id: "alice", role: "user" as const }) },
    sessions: {
      list: async () => (count("list"), summaries),
      inspect: async (id: string) => {
        count("inspect");
        throw new Error(`the list must not read a record (${id})`);
      },
      watch: async () => new Promise<void>(() => {}),
    },
    models: async () => (count("models"), models),
    packages: { list: async () => [] },
  } as unknown as KernelClient;
  return { kernel, calls };
}

async function serve(kernel: KernelClient, store: GatewayStore) {
  const assets = mkdtempSync(join(tmpdir(), "gw-assets-"));
  writeFileSync(join(assets, "index.html"), "<title>app</title>");
  const server = createGateway(kernel, store, { assets, user: "alice", base: "/alice", log: () => {} });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => (await fetch(`${origin}/alice${path}`, { headers: { cookie: COOKIE } })).json();
  const close = () => new Promise<void>((done) => server.close(() => done()));
  return { get, close };
}

test("the session list comes from the summaries: titles, previews and running from the kernel's fields, no record read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-store-"));
  const store = new GatewayStore(dir);
  const summaries: Summary[] = [
    { id: "s_1", user: "alice", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", turns: 1, first: "# Hello **there**", last: "Done.", running: false },
    { id: "s_2", user: "alice", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", turns: 0, first: "Working on it", last: "Working on it", running: true },
    { id: "s_3", user: "alice", parent: "s_1", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", turns: 1, first: "child", last: "child", running: false },
  ];
  store.setTitle("alice", "s_2", "Named");
  store.setUsage("alice", "s_3", { 1: { cost: 0.5 } });
  store.setUsage("alice", "s_1", { 1: { cost: 0.25 } });
  const { kernel, calls } = fakeKernel(summaries);
  const { get, close } = await serve(kernel, store);
  try {
    const list = (await get("/api/sessions")) as { id: string; title: string; named: boolean; preview: string; status: string; cost?: number }[];
    assert.deepEqual(list.map((s) => s.id), ["s_2", "s_1"], "newest first, subagents left out");
    const [running, done] = list;
    assert.equal(done.title, "Hello there", "markdown markers dropped");
    assert.equal(done.preview, "Done.");
    assert.equal(done.status, "idle");
    assert.equal(done.cost, 0.75, "a subagent's cost is part of its conversation's");
    assert.equal(running.title, "Named");
    assert.equal(running.named, true);
    assert.equal(running.status, "running", "the kernel's flag counts when the hub knows nothing");
    assert.equal(calls.inspect ?? 0, 0);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the models answer carries only what the picker draws, and one kernel answer serves repeated requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-store-"));
  const { kernel, calls } = fakeKernel([]);
  const { get, close } = await serve(kernel, new GatewayStore(dir));
  try {
    const first = (await get("/api/models")) as { model: string; models: Record<string, unknown>[] };
    assert.equal(first.model, "echo");
    assert.deepEqual(first.models, [{ id: "echo", name: "Echo", provider: "@thetis/provider-echo" }]);
    await get("/api/models");
    await get("/api/models");
    assert.equal(calls.models, 1);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hub carries a turn the kernel replays on watch: started when the kernel says, in the snapshot, and its usage recorded at the end", async () => {
  let deliver: ((m: WatchedTurnEvent & { startedAt?: string }) => void) | undefined;
  const kernel = {
    sessions: {
      watch: async (fn: (m: WatchedTurnEvent) => void) => {
        deliver = fn;
        return new Promise<void>(() => {});
      },
    },
  } as unknown as KernelClient;
  const ended: string[] = [];
  const hub = new TurnHub(kernel, () => {}, (_user, run) => { ended.push(`${run.session}:${run.events.length}:${run.startedAt}`); }, "alice");
  await new Promise((r) => setImmediate(r));
  assert.ok(deliver, "the hub watches as soon as it is made");
  const seen: string[] = [];
  hub.subscribe("alice", (m) => seen.push(`${m.seq}:${m.event.type}`));
  // What the kernel replays: the turn started before this hub existed.
  deliver!({ session: "s_9", input: "hello", startedAt: "2026-01-01T00:00:00.000Z", event: { type: "turn.start", turn: "t_1", session: "s_9" } });
  deliver!({ session: "s_9", event: { type: "text", delta: "hi" } });
  const running = hub.snapshot("alice");
  assert.equal(running.length, 1);
  assert.equal(running[0].startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(running[0].input, "hello");
  assert.equal(running[0].events.length, 2);
  deliver!({ session: "s_9", event: { type: "message", message: { role: "assistant", content: textContent("hi") }, usage: { cost: 1 } } });
  deliver!({ session: "s_9", event: { type: "turn.end", turn: "t_1", session: "s_9" } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["1:turn.start", "2:text", "3:message", "4:turn.end"]);
  assert.deepEqual(ended, ["s_9:4:2026-01-01T00:00:00.000Z"]);
  assert.equal(hub.snapshot("alice").length, 0);
});

test("the store keeps one file per conversation, rewrites only that one, and migrates the old state.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-store-"));
  try {
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ archived: { alice: ["s_old"] }, usage: { "alice/s_old": { 1: { cost: 0.1 } } }, models: { "alice/s_m": "echo" }, titles: { "alice/s_old": "Old one" } }),
    );
    let store = new GatewayStore(dir);
    assert.ok(existsSync(join(dir, "state.json.migrated")), "the old file is kept aside");
    assert.ok(!existsSync(join(dir, "state.json")));
    assert.deepEqual([...store.archived("alice")], ["s_old"]);
    assert.equal(store.title("alice", "s_old"), "Old one");
    assert.equal(store.model("alice", "s_m"), "echo");
    assert.deepEqual(store.usage("alice", "s_old"), { 1: { cost: 0.1 } });
    assert.deepEqual(readdirSync(join(dir, "sessions", "alice")).sort(), ["s_m.json", "s_old.json"]);

    const before = statSync(join(dir, "sessions", "alice", "s_old.json")).mtimeMs;
    store.setTitle("alice", "s_new", "New");
    assert.equal(statSync(join(dir, "sessions", "alice", "s_old.json")).mtimeMs, before, "another conversation's file is not touched");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "sessions", "alice", "s_new.json"), "utf8")), { title: "New" });
    store.setTitle("alice", "s_new", "");
    assert.ok(!existsSync(join(dir, "sessions", "alice", "s_new.json")), "an entry with nothing left is removed");

    store.setArchived("alice", "s_m", true);
    store.forget("alice", "s_old");
    assert.ok(!existsSync(join(dir, "sessions", "alice", "s_old.json")), "forget leaves no file: the conversation it was about is being removed");
    store = new GatewayStore(dir); // read back from the files
    assert.deepEqual([...store.archived("alice")], ["s_m"], "forget takes the archive mark with the rest; another conversation's is untouched");
    assert.equal(store.title("alice", "s_old"), undefined);
    assert.equal(store.model("alice", "s_m"), "echo");
    assert.equal(store.archived("bob").size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

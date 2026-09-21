// The `watch` stream the page holds, over a real host: what a subscription carries with and without the
// screens. The point under test is the byte budget of a page whose drawer is closed — the rows and
// nothing else, on connect and on every reconnect — and that a drawer opening is given the last
// screenful, marked `replace`, so it can drop what it has already drawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startHost } from "../lib/host.js";
import { connect } from "../lib/client.js";
import { uiWatch } from "../index.js";

const SILENCE_MS = 400; // longer than a frame tick and the host's settle, shorter than the heartbeat

async function withHost(t) {
  const root = await mkdtemp(resolve(tmpdir(), "thetis-watch-"));
  const host = await startHost({ root, cwd: root, config: {}, log: () => {} });
  const worker = await connect(root);
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort.abort();
    worker.close();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  });
  /** One subscription as the gateway would open it: the export's iterator, and the signal that ends it. */
  const watch = (args) => {
    const abort = new AbortController();
    const it = uiWatch(args, { root, signal: abort.signal })[Symbol.asyncIterator]();
    const stream = { it, abort };
    streams.push(stream);
    return stream;
  };
  return { worker, watch };
}

/** Every value until the stream has said nothing for `ms`. A `next` left pending resolves when the stream is aborted. */
async function drain({ it }, ms = SILENCE_MS) {
  const items = [];
  for (;;) {
    let timer;
    const next = await Promise.race([it.next(), new Promise((r) => (timer = setTimeout(() => r(null), ms)))]);
    clearTimeout(timer);
    if (!next || next.done) return items;
    items.push(next.value);
  }
}

test("without the screens, a subscription carries the rows and never a screenful", async (t) => {
  const { worker, watch } = await withHost(t);
  const opened = await worker.request("open", { conversation: "conv-1", name: "one" });
  await worker.request("run", { id: opened.id, cmd: "echo before-the-page", consumer: "conv-1" });

  const stream = watch({ screens: false });
  const first = await drain(stream);
  assert.equal(first[0]?.ev, "sessions", "the rows come first");
  assert.equal(first[0].sessions.length, 1);
  assert.ok(!first.some((v) => v.ev === "output"), "the ring buffer is not replayed to a closed drawer");

  await worker.request("run", { id: opened.id, cmd: "echo while-closed", consumer: "conv-1" });
  const later = await drain(stream);
  assert.ok(later.some((v) => v.ev === "state" && v.session.id === opened.id), "the row's state still moves");
  assert.ok(!later.some((v) => v.ev === "output"), "what the shell prints is not sent to a closed drawer");
  // The whole subscription, in bytes: what a page with the drawer closed pays to connect and to watch a command run.
  const bytes = Buffer.byteLength([...first, ...later].map((v) => JSON.stringify(v)).join(""));
  assert.ok(bytes < 4096, `the rows of one session cost ${bytes} bytes, which is more than a row should`);
});

test("the flag left out means the rows alone: the cheap subscription is the default", async (t) => {
  const { worker, watch } = await withHost(t);
  const opened = await worker.request("open", { conversation: "conv-1" });
  await worker.request("run", { id: opened.id, cmd: "echo quiet", consumer: "conv-1" });
  const items = await drain(watch({}));
  assert.ok(items.some((v) => v.ev === "sessions"));
  assert.ok(!items.some((v) => v.ev === "output"));
});

test("with the screens, the last screenful arrives first with replace, then the output as it happens", async (t) => {
  const { worker, watch } = await withHost(t);
  const opened = await worker.request("open", { conversation: "conv-1" });
  await worker.request("run", { id: opened.id, cmd: "echo before-the-drawer", consumer: "conv-1" });

  const stream = watch({ screens: true });
  const first = await drain(stream);
  assert.equal(first[0]?.ev, "sessions", "the rows before any output, so the page has somewhere to put it");
  const replay = first.find((v) => v.ev === "output");
  assert.ok(replay, "the ring buffer is replayed to a drawer that opens");
  assert.equal(replay.id, opened.id);
  assert.equal(replay.replace, true);
  assert.match(replay.text, /before-the-drawer/);
  assert.equal(typeof replay.seq, "number");

  await worker.request("run", { id: opened.id, cmd: "echo while-open", consumer: "conv-1" });
  const later = await drain(stream);
  const live = later.filter((v) => v.ev === "output");
  assert.ok(live.some((v) => v.text.includes("while-open")), "what the shell prints reaches an open drawer");
  assert.ok(live.every((v) => !v.replace && v.seq > replay.seq), "live output counts on from the replay, and is not a replay");
});

test("a second subscription without the screens, as a reconnect of a closed drawer, is as small as the first", async (t) => {
  const { worker, watch } = await withHost(t);
  const opened = await worker.request("open", { conversation: "conv-1" });
  await worker.request("run", { id: opened.id, cmd: "seq 1 2000", consumer: "conv-1" });

  const before = await drain(watch({ screens: true }));
  const screenful = before.find((v) => v.ev === "output");
  assert.ok(screenful && screenful.text.length > 8000, "the ring holds a screenful worth not sending");

  const again = await drain(watch({ screens: false }));
  assert.ok(!again.some((v) => v.ev === "output"), "a reconnect of a closed drawer does not re-send it");
});

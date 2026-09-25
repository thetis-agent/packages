import { textContent } from "@thetis/runtime/lib/content";
// The two bounds on a request, against a real server that behaves the way the wedged one did: it accepts the
// connection and then says nothing. Node's fetch has no timeout of its own, so before these bounds existed
// this file's server would have held a turn open until something else killed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { ProviderCall, ProviderEvent } from "@thetis/runtime/contracts";
import { createProvider } from "../src/index.js";

type Behaviour = "silent" | "headers-then-silence" | "stream";

/** A server that answers the way the argument says, and hands back its base URL. */
async function serving(how: Behaviour): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const open: import("node:net").Socket[] = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      // /models is only ever asked for by the models test, which wants the silent case too.
      if (how === "silent") return;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "vendor/model" }] }));
    }
    req.resume();
    if (how === "silent") return; // the incident: connected, and nothing ever comes back
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`);
    if (how === "stream") {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " there" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
    // "headers-then-silence": the stream is open, one chunk arrived, and it never says anything again.
  });
  server.on("connection", (socket) => open.push(socket));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((done) => {
        for (const s of open) s.destroy();
        server.close(() => done());
      }),
  };
}

const CALL: ProviderCall = { model: "vendor/model", messages: [{ role: "user", content: textContent("hi") }], tools: [], params: {} };

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test("a request that never gets a response is abandoned at its deadline, retries and their waits included", async () => {
  const site = await serving("silent");
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, requestTimeoutMs: 300, retries: 3, cache: { enabled: false } });
    const started = Date.now();
    const events = await collect(provider.call(CALL));
    const took = Date.now() - started;
    assert.ok(took < 3_000, `it gave up rather than waiting for ever (${took}ms)`);
    assert.deepEqual(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.match((events[0] as { message: string }).message, /no response from openrouter within 0s|no response from openrouter within/);
    assert.match((events[0] as { message: string }).message, /retries and the waits between them included/);
  } finally {
    await site.close();
  }
});

test("a stream that opens, sends something and then goes silent is abandoned at the stall bound, not at a deadline on the reply", async () => {
  const site = await serving("headers-then-silence");
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, requestTimeoutMs: 10_000, streamStallMs: 300, cache: { enabled: false } });
    const started = Date.now();
    const events = await collect(provider.call(CALL));
    const took = Date.now() - started;
    assert.ok(took < 3_000, `the open-and-silent stream ended (${took}ms)`);
    assert.ok(took >= 250, "and it was the silence that ended it, not a limit on the reply");
    assert.deepEqual(events.map((e) => e.type), ["text", "error"], "what did arrive is delivered first: nothing is thrown away");
    assert.equal((events[0] as { delta: string }).delta, "hello");
    assert.match((events[1] as { message: string }).message, /was open but sent nothing for 0s|was open but sent nothing/);
  } finally {
    await site.close();
  }
});

test("the caller's signal ends the request itself, not only the reading of it", async () => {
  const site = await serving("silent");
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, requestTimeoutMs: 60_000, cache: { enabled: false } });
    const control = new AbortController();
    setTimeout(() => control.abort(), 150);
    const started = Date.now();
    // No error event and no throw: the caller cancelled, so it is not waiting to be told anything.
    const events = await collect(provider.call(CALL, control.signal));
    assert.ok(Date.now() - started < 3_000, "a request nobody wants any more does not outlive the wanting");
    assert.deepEqual(events, []);
  } finally {
    await site.close();
  }
});

test("a stream that answers normally is untouched by either bound", async () => {
  const site = await serving("stream");
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, requestTimeoutMs: 5_000, streamStallMs: 5_000, cache: { enabled: false } });
    const events = await collect(provider.call(CALL));
    assert.deepEqual(events.map((e) => e.type), ["text", "text"]);
    assert.equal(events.map((e) => (e as { delta: string }).delta).join(""), "hello there");
  } finally {
    await site.close();
  }
});

test("the model list is bounded too: it is on the path of every call that has to resolve a model", async () => {
  const site = await serving("silent");
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, requestTimeoutMs: 250 });
    await assert.rejects(provider.models(), (err: Error) => /abort|timeout/i.test(err.message + String((err as { cause?: unknown }).cause ?? "")));
  } finally {
    await site.close();
  }
});

// ---- a stream cut under the reply ----
//
// The incident: a turn on production stopped mid-work, twice, with an empty assistant message and no error.
// The upstream connection had closed with no finish_reason, the adapter ended quietly, and the harness took
// the empty message as the model finishing. A cut before anything arrived is made again; a cut after part of
// the reply is reported; a reply that finishes empty is reported.
async function cutting(plan: ((n: number) => string[])): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let n = 0;
  const open: import("node:net").Socket[] = [];
  const server = createServer((req, res) => {
    req.resume();
    n += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const line of plan(n)) res.write(line);
    res.end();
  });
  server.on("connection", (socket) => open.push(socket));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests: () => n, close: () => new Promise<void>((done) => { for (const s of open) s.destroy(); server.close(() => done()); }) };
}

const chunk = (delta: Record<string, unknown>, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;

test("a stream cut before any of the reply arrived is made again, and the reply that then comes is the reply", async () => {
  const site = await cutting((n) => (n === 1 ? [] : [chunk({ content: "hello" }, "stop"), "data: [DONE]\n\n"]));
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, retries: 2, requestTimeoutMs: 5_000, streamStallMs: 5_000, cache: { enabled: false } });
    const events = await collect(provider.call(CALL));
    assert.deepEqual(events.map((e) => e.type), ["text"]);
    assert.equal(site.requests(), 2, "one cut, one answer");
  } finally {
    await site.close();
  }
});

test("a stream cut every time is an error that says how many times, not an empty reply", async () => {
  const site = await cutting(() => []);
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, retries: 2, requestTimeoutMs: 5_000, streamStallMs: 5_000, cache: { enabled: false } });
    const events = await collect(provider.call(CALL));
    assert.deepEqual(events.map((e) => e.type), ["error"]);
    assert.match((events[0] as { message: string }).message, /closed before the reply finished, before any of it arrived, 3 times/);
    assert.equal(site.requests(), 3);
  } finally {
    await site.close();
  }
});

test("a stream cut part-way through the reply is not made again: what arrived is kept and the error says it was cut", async () => {
  const site = await cutting(() => [chunk({ content: "half an ans" })]);
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, retries: 2, requestTimeoutMs: 5_000, streamStallMs: 5_000, cache: { enabled: false } });
    const events = await collect(provider.call(CALL));
    assert.deepEqual(events.map((e) => e.type), ["text", "error"]);
    assert.match((events[1] as { message: string }).message, /closed before the reply finished, part-way through it/);
    assert.equal(site.requests(), 1, "a retry would duplicate what the consumer already has");
  } finally {
    await site.close();
  }
});

test("a reply that finishes with no text and no tool call is an error naming the finish reason", async () => {
  const site = await cutting(() => [chunk({ reasoning: "hmm" }, "stop"), "data: [DONE]\n\n"]);
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, requestTimeoutMs: 5_000, streamStallMs: 5_000, cache: { enabled: false } });
    const events = await collect(provider.call(CALL));
    assert.deepEqual(events.map((e) => e.type), ["reasoning", "error"]);
    assert.match((events[1] as { message: string }).message, /empty reply \(finish_reason: stop, reasoning only\)/);
  } finally {
    await site.close();
  }
});

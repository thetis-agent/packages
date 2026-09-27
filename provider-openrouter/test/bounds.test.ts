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
    assert.deepEqual(info(events[0]), { retryable: true, kind: "timeout" }, "a deadline is worth another try: the harness decides");
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
    assert.deepEqual(info(events[1]), { retryable: true, kind: "timeout" });
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

// ---- a stream cut under the reply, and how every failure is labelled ----
//
// The incident: a turn on production stopped mid-work, twice, with an empty assistant message and no error.
// The upstream connection had closed with no finish_reason, the adapter ended quietly, and the harness took
// the empty message as the model finishing. Every cut is now reported, never made again here: the harness
// owns the round, can throw its half away, and waits before it asks again. What this adapter owes it is a
// label on every error: whether the same request could succeed, and what kind of failure it was.

/** What an error event says besides its message. */
function info(e: ProviderEvent): Record<string, unknown> {
  const { type: _type, message: _message, ...rest } = e as Record<string, unknown>;
  return rest;
}

/** A server that answers the n-th request with `plan(n)`: a status, headers and body lines, or `"drop"` to close the socket before any header. */
type Plan = { status?: number; headers?: Record<string, string>; lines: string[] } | "drop";

async function cutting(plan: (n: number) => Plan | string[]): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let n = 0;
  const open: import("node:net").Socket[] = [];
  const server = createServer((req, res) => {
    req.resume();
    n += 1;
    const raw = plan(n);
    const step = Array.isArray(raw) ? { lines: raw } : raw;
    if (step === "drop") return req.socket.destroy();
    res.writeHead(step.status ?? 200, { "Content-Type": "text/event-stream", ...(step.headers ?? {}) });
    for (const line of step.lines) res.write(line);
    res.end();
  });
  server.on("connection", (socket) => open.push(socket));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests: () => n, close: () => new Promise<void>((done) => { for (const s of open) s.destroy(); server.close(() => done()); }) };
}

const chunk = (delta: Record<string, unknown>, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;

async function run(plan: (n: number) => Plan | string[], opts: Record<string, unknown> = {}, call: ProviderCall = CALL) {
  const site = await cutting(plan);
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: site.url, retries: 2, requestTimeoutMs: 5_000, streamStallMs: 5_000, cache: { enabled: false }, ...opts });
    const events = await collect(provider.call(call));
    return { events, requests: site.requests() };
  } finally {
    await site.close();
  }
}

test("a stream cut before any of the reply arrived is reported as worth another try, and is not asked again here", async () => {
  const { events, requests } = await run(() => []);
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  assert.match((events[0] as { message: string }).message, /closed before the reply finished, before any of it arrived/);
  assert.deepEqual(info(events[0]), { retryable: true, kind: "connection" });
  assert.equal(requests, 1, "one request: the old instant re-request with no wait is gone");
});

test("a stream cut part-way through the reply keeps what arrived and says it was cut, as worth another try", async () => {
  const { events, requests } = await run(() => [chunk({ content: "half an ans" })]);
  assert.deepEqual(events.map((e) => e.type), ["text", "error"]);
  assert.match((events[1] as { message: string }).message, /closed before the reply finished, part-way through it/);
  assert.deepEqual(info(events[1]), { retryable: true, kind: "connection" });
  assert.equal(requests, 1);
});

test("a reply that finishes with no text and no tool call is an error naming the finish reason, worth one more sample", async () => {
  const { events } = await run(() => [chunk({ reasoning: "hmm" }, "stop"), "data: [DONE]\n\n"]);
  assert.deepEqual(events.map((e) => e.type), ["reasoning", "error"]);
  assert.match((events[1] as { message: string }).message, /empty reply \(finish_reason: stop, reasoning only\)/);
  assert.deepEqual(info(events[1]), { retryable: true, kind: "other" });
});

test("the output limit and the content filter are reported as not worth the same request again", async () => {
  const length = await run(() => [chunk({ content: "a very long" }, "length"), "data: [DONE]\n\n"], { defaults: { max_tokens: 64 } });
  assert.match((length.events.at(-1) as { message: string }).message, /output limit of 64 tokens/);
  assert.deepEqual(info(length.events.at(-1)!), { retryable: false, kind: "output-limit" });
  const filter = await run(() => [chunk({ content: "no" }, "content_filter"), "data: [DONE]\n\n"]);
  assert.deepEqual(info(filter.events.at(-1)!), { retryable: false, kind: "filter" });
});

test("tool arguments that are not JSON are worth one more sample: they are nearly always a reply cut short", async () => {
  const { events } = await run(() => [`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write", arguments: '{"path": "a' } }] }, finish_reason: "tool_calls" }] })}\n\n`, "data: [DONE]\n\n"]);
  const error = events.find((e) => e.type === "error")!;
  assert.match((error as { message: string }).message, /valid JSON/);
  assert.deepEqual(info(error), { retryable: true, kind: "other" });
});

test("an error inside an open stream is labelled by its code and its words", async () => {
  const upstream = (error: Record<string, unknown>) => () => [chunk({ content: "so" }), `data: ${JSON.stringify({ error })}\n\n`];
  const bad = await run(upstream({ code: 502, message: "Upstream error from Anthropic" }));
  assert.deepEqual(info(bad.events.at(-1)!), { retryable: true, kind: "overloaded", status: 502 });
  const busy = await run(upstream({ message: "Overloaded" }));
  assert.deepEqual(info(busy.events.at(-1)!), { retryable: true, kind: "overloaded" });
  const limited = await run(upstream({ code: 429, message: "Rate limit exceeded" }));
  assert.deepEqual(info(limited.events.at(-1)!), { retryable: true, kind: "rate-limit", status: 429 });
  const invalid = await run(upstream({ code: 400, message: "This endpoint's maximum context length is 200000 tokens" }));
  assert.deepEqual(info(invalid.events.at(-1)!), { retryable: false, kind: "context", status: 400 });
});

test("a refusal says whether it is final, and a transient one still refused after the retries carries the wait it asked for", async () => {
  const body = (message: string) => JSON.stringify({ error: { message } });
  const refused = (status: number, message: string, headers: Record<string, string> = {}) => run(() => ({ status, headers: { "Content-Type": "application/json", ...headers }, lines: [body(message)] }), { retries: 0 });
  assert.deepEqual(info((await refused(400, "prompt is too long: 250000 tokens > 200000 maximum")).events[0]), { retryable: false, kind: "context", status: 400 });
  assert.deepEqual(info((await refused(401, "No auth credentials found")).events[0]), { retryable: false, kind: "auth", status: 401 });
  assert.deepEqual(info((await refused(402, "Insufficient credits")).events[0]), { retryable: false, kind: "credits", status: 402 });
  assert.deepEqual(info((await refused(404, "No such model")).events[0]), { retryable: false, kind: "other", status: 404 });
  assert.deepEqual(info((await refused(429, "slow down", { "Retry-After": "7" })).events[0]), { retryable: true, kind: "rate-limit", status: 429, retryAfterMs: 7000 });
  assert.deepEqual(info((await refused(503, "busy")).events[0]), { retryable: true, kind: "overloaded", status: 503 });
  assert.deepEqual(info((await refused(529, "overloaded")).events[0]), { retryable: true, kind: "overloaded", status: 529 });
});

test("a refusal that asks for a long wait is not waited out here, where the page cannot see it: it goes back at once with the wait", async () => {
  const body = JSON.stringify({ error: { message: "slow down" } });
  const started = Date.now();
  const { events, requests } = await run(() => ({ status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" }, lines: [body] }), { retries: 3 });
  assert.equal(requests, 1, "no quiet retry for a 30 s wait");
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(info(events[0]), { retryable: true, kind: "rate-limit", status: 429, retryAfterMs: 30_000 });
});

test("no response at all (the socket closes before a header) is tried again like a refusal, and reported as a connection failure when it never comes", async () => {
  const recovered = await run((n) => (n === 1 ? "drop" : [chunk({ content: "hello" }, "stop"), "data: [DONE]\n\n"]), { retries: 2 });
  assert.deepEqual(recovered.events.map((e) => e.type), ["text"]);
  assert.equal(recovered.requests, 2, "one dropped, one answered");
  const never = await run(() => "drop", { retries: 1 });
  assert.deepEqual(never.events.map((e) => e.type), ["error"]);
  assert.match((never.events[0] as { message: string }).message, /openrouter request failed/);
  assert.deepEqual(info(never.events[0]), { retryable: true, kind: "connection" });
  assert.equal(never.requests, 2, "the retries were used");
});

test("a last line sent without its newline is still read: a final finish_reason is not a cut", async () => {
  const { events } = await run(() => [chunk({ content: "hello" }), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`]);
  assert.deepEqual(events.map((e) => e.type), ["text"]);
  const done = await run(() => [chunk({ content: "hi" }, "stop"), "data: [DONE]"]);
  assert.deepEqual(done.events.map((e) => e.type), ["text"]);
});

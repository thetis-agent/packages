import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolEnv } from "@thetis/kernel";
import { checkPath, createClient, createTools, formatResults, formatRun, type FetchLike, type RequestInitLike } from "../src/index.js";

interface Call {
  url: string;
  init: RequestInitLike;
  body?: Record<string, unknown>;
}

/** A fake fetch that records every call and answers from a queue. */
function fakeFetch(replies: Array<{ status?: number; body: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = replies.shift() ?? { status: 500, body: { error: "no reply queued" } };
    const status = next.status ?? 200;
    return { ok: status < 400, status, text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)) };
  };
  return { fetch, calls };
}

function envWith(config: Record<string, unknown>): ToolEnv {
  return { config } as unknown as ToolEnv;
}

const KEY = "test-key";

test("a missing key is one clear sentence", async () => {
  const { fetch, calls } = fakeFetch([]);
  const tools = createTools({ fetch });
  await assert.rejects(tools.search({ query: "x" }, envWith({})), /apiKey is not configured/);
  await assert.rejects(tools.search({ query: "x" }, envWith({ apiKey: "  " })), /apiKey is not configured/);
  assert.equal(calls.length, 0);
});

test("search sends the key, the query, the filters, and highlights by default", async () => {
  const { fetch, calls } = fakeFetch([
    {
      body: {
        results: [
          { title: "Thetis", url: "https://example.com/thetis", publishedDate: "2026-09-01T00:00:00.000Z", author: "Ann", score: 0.91, highlights: ["A recursive service.", "It runs packages."] },
          { title: "", url: "https://example.com/blank" },
        ],
        searchType: "neural",
        costDollars: { total: 0.005 },
      },
    },
  ]);
  const tools = createTools({ fetch });
  const out = await tools.search({ query: "thetis agent", numResults: 2, includeDomains: ["example.com"], startPublishedDate: "2026-01-01", type: "fast" }, envWith({ apiKey: KEY }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.exa.ai/search");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-api-key"], KEY);
  assert.deepEqual(calls[0].body, { query: "thetis agent", type: "fast", numResults: 2, includeDomains: ["example.com"], startPublishedDate: "2026-01-01", contents: { highlights: true } });
  const text = String(out);
  assert.match(text, /1\. Thetis\n {3}https:\/\/example\.com\/thetis\n {3}published 2026-09-01 · by Ann · score 0\.910/);
  assert.match(text, /- A recursive service\./);
  assert.match(text, /2\. \(untitled\)/);
  assert.match(text, /search type: neural/);
  assert.match(text, /cost: \$0\.0050/);
});

test("search: text asks for page text and the configured cap applies", async () => {
  const { fetch, calls } = fakeFetch([{ body: { results: [{ title: "T", url: "u", text: "x".repeat(50) }] } }]);
  const tools = createTools({ fetch });
  const out = await tools.search({ query: "q", text: true, summary: "what is it" }, envWith({ apiKey: KEY, defaults: { numResults: 3, maxCharacters: 20 } }));
  assert.deepEqual(calls[0].body!.contents, { text: { maxCharacters: 20 }, summary: { query: "what is it" } });
  assert.equal(calls[0].body!.numResults, 3);
  assert.match(String(out), /x{20}… \[cut at 20 characters\]/);
});

test("contents fetches text by default and reports pages that failed", async () => {
  const { fetch, calls } = fakeFetch([{ body: { results: [{ title: "Page", url: "https://a.example", text: "hello" }], statuses: [{ id: "https://a.example", status: "success" }, { id: "https://b.example", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } }] } }]);
  const tools = createTools({ fetch });
  const out = await tools.contents({ urls: ["https://a.example", "https://b.example"], subpages: 2, links: 5 }, envWith({ apiKey: KEY }));
  assert.equal(calls[0].url, "https://api.exa.ai/contents");
  assert.deepEqual(calls[0].body, { urls: ["https://a.example", "https://b.example"], text: true, subpages: 2, extras: { links: 5 } });
  assert.match(String(out), /text:\n {3}hello/);
  assert.match(String(out), /not fetched:\n- https:\/\/b\.example: CRAWL_NOT_FOUND \(http 404\)/);
  await assert.rejects(tools.contents({}, envWith({ apiKey: KEY })), /urls is required/);
});

test("summarize asks for a summary only", async () => {
  const { fetch, calls } = fakeFetch([{ body: { results: [{ title: "Doc", url: "https://d.example", summary: "It explains things.\nIn two lines." }] } }, { body: { results: [] } }]);
  const tools = createTools({ fetch });
  const out = await tools.summarize({ urls: ["https://d.example"], query: "what does it explain?" }, envWith({ apiKey: KEY }));
  assert.deepEqual(calls[0].body, { urls: ["https://d.example"], summary: { query: "what does it explain?" }, text: false });
  assert.match(String(out), /summary: It explains things\.\n {3}In two lines\./);
  await tools.summarize({ url: "https://d.example" }, envWith({ apiKey: KEY }));
  assert.match(String((calls[1].body!.summary as { query: string }).query), /Summarize the page/);
});

test("find_similar maps its fields", async () => {
  const { fetch, calls } = fakeFetch([{ body: { results: [] } }]);
  const tools = createTools({ fetch });
  const out = await tools.findSimilar({ url: "https://x.example", excludeSourceDomain: true, numResults: 4, highlights: false, text: 100 }, envWith({ apiKey: KEY }));
  assert.equal(calls[0].url, "https://api.exa.ai/findSimilar");
  assert.deepEqual(calls[0].body, { url: "https://x.example", numResults: 4, excludeSourceDomain: true, contents: { text: { maxCharacters: 100 }, highlights: false } });
  assert.equal(out, "no results");
});

test("answer returns the answer and its sources", async () => {
  const { fetch, calls } = fakeFetch([{ body: { answer: "Forty-two.", citations: [{ title: "Guide", url: "https://g.example", publishedDate: "1979-10-12", author: "Adams" }], costDollars: { total: 0.01 } } }]);
  const tools = createTools({ fetch });
  const out = await tools.answer({ query: "the answer?", model: "exa-pro", outputSchema: { type: "object" } }, envWith({ apiKey: KEY }));
  assert.deepEqual(calls[0].body, { query: "the answer?", model: "exa-pro", outputSchema: { type: "object" } });
  assert.equal(out, "answer:\nForty-two.\n\nsources:\n1. Guide — https://g.example (1979-10-12, Adams)\n\ncost: $0.0100");
});

test("research creates a run and polls until it completes", async () => {
  const running = { id: "agent_run_1", status: "running", request: { query: "why" } };
  const done = { ...running, status: "completed", output: { text: "Because.", grounding: [{ field: "text", citations: [{ url: "https://s.example", title: "Source" }, { url: "https://s.example", title: "dup" }] }] }, costDollars: { total: 0.5 } };
  const { fetch, calls } = fakeFetch([{ body: { id: "agent_run_1", status: "queued" } }, { body: running }, { body: done }]);
  const slept: number[] = [];
  let clock = 0;
  const tools = createTools({ fetch, sleep: async (ms) => { slept.push(ms); clock += ms; }, now: () => clock });
  const out = await tools.research({ query: "why", effort: "low" }, envWith({ apiKey: KEY }));
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].url, "https://api.exa.ai/agent/runs");
  assert.deepEqual(calls[0].body, { query: "why", effort: "low" });
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].url, "https://api.exa.ai/agent/runs/agent_run_1");
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [5000, 5000]);
  assert.equal(out, "research run agent_run_1: completed\nquery: why\n\nresult:\nBecause.\n\nsources:\n1. Source — https://s.example\n\ncost: $0.5000");
});

test("research gives up after waitSeconds and says how to continue", async () => {
  const { fetch, calls } = fakeFetch([{ body: { id: "r2", status: "queued" } }, { body: { id: "r2", status: "running" } }, { body: { id: "r2", status: "running" } }]);
  let clock = 0;
  const tools = createTools({ fetch, sleep: async (ms) => { clock += ms; }, now: () => clock });
  const out = await tools.research({ query: "slow", waitSeconds: 8 }, envWith({ apiKey: KEY }));
  assert.equal(calls.length, 3);
  assert.match(String(out), /still running after 8 seconds: call exa_research_get/);
  const { fetch: f2, calls: c2 } = fakeFetch([{ body: { id: "r3", status: "queued" } }]);
  const noWait = await createTools({ fetch: f2 }).research({ query: "later", wait: false }, envWith({ apiKey: KEY }));
  assert.equal(c2.length, 1);
  assert.equal(noWait, "research run r3: queued");
});

test("research_get and research_list", async () => {
  const { fetch, calls } = fakeFetch([{ body: { id: "r9", status: "failed", error: { message: "budget" } } }, { body: { data: [{ id: "r9", status: "failed", createdAt: "2026-09-14T10:00:00Z", request: { query: "q" } }], hasMore: true, nextCursor: "r8" } }]);
  const tools = createTools({ fetch });
  const one = await tools.researchGet({ id: "r9" }, envWith({ apiKey: KEY }));
  assert.equal(one, "research run r9: failed\n\nerror: budget");
  const many = await tools.researchList({ limit: 1 }, envWith({ apiKey: KEY }));
  assert.equal(calls[1].url, "https://api.exa.ai/agent/runs?limit=1");
  assert.equal(many, "- r9 failed 2026-09-14T10:00:00: q\nmore: cursor=r8");
});

test("research_cancel posts to the cancel path", async () => {
  const { fetch, calls } = fakeFetch([{ body: { id: "r5", status: "cancelled", stopReason: "cancelled" } }]);
  const out = await createTools({ fetch }).researchCancel({ id: "r5" }, envWith({ apiKey: KEY }));
  assert.equal(calls[0].url, "https://api.exa.ai/agent/runs/r5/cancel");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(out, "research run r5: cancelled (cancelled)");
});

test("request reaches any endpoint and refuses paths that leave the API", async () => {
  const { fetch, calls } = fakeFetch([{ body: { data: [] } }, { body: { id: "ws_1" } }]);
  const tools = createTools({ fetch });
  const listed = await tools.request({ path: "/websets/v0/websets", query: { limit: 2 } }, envWith({ apiKey: KEY, baseUrl: "https://proxy.example/exa/" }));
  assert.equal(calls[0].url, "https://proxy.example/exa/websets/v0/websets?limit=2");
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(listed, { data: [] });
  await tools.request({ path: "/websets/v0/websets", body: { search: { query: "x" } } }, envWith({ apiKey: KEY }));
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers["content-type"], "application/json");
  for (const bad of ["websets", "//evil", "/a/../b", "https://evil.example/x"]) {
    await assert.rejects(tools.request({ path: bad }, envWith({ apiKey: KEY })), /invalid Exa API path/);
    assert.throws(() => checkPath(bad));
  }
  await assert.rejects(tools.request({ path: "/x", method: "TRACE" }, envWith({ apiKey: KEY })), /unsupported method/);
  assert.equal(calls.length, 2);
});

test("an error reply becomes one sentence with the status", async () => {
  const { fetch } = fakeFetch([{ status: 401, body: { error: "Invalid API key" } }, { status: 502, body: "<html>bad gateway</html>" }]);
  const client = createClient({ apiKey: KEY }, fetch);
  await assert.rejects(client.post("/search", { query: "q" }), /^ExaError: Exa 401 on POST \/search: Invalid API key$/);
  await assert.rejects(client.get("/agent/runs"), /Exa 502 on GET \/agent\/runs: <html>bad gateway<\/html>/);
  const detailed = fakeFetch([{ status: 400, body: { statusCode: 400, error: { type: "INVALID_REQUEST", message: "Request body does not match Agent run schema.", detail: "[\n  { \"path\": [\"budget\"] }\n]" } } }]);
  await assert.rejects(createClient({ apiKey: KEY }, detailed.fetch).post("/agent/runs", {}), /Exa 400 on POST \/agent\/runs: Request body does not match Agent run schema\. \[ \{ "path": \["budget"\] \} \]/);
  const failing: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(createClient({ apiKey: KEY }, failing).get("/x"), /Exa request failed \(GET \/x\): ECONNREFUSED/);
});

test("formatting handles subpages and empty input", () => {
  assert.equal(formatResults([]), "no results");
  const text = formatResults([{ title: "Top", url: "https://t.example", subpages: [{ title: "Sub", url: "https://t.example/sub", highlights: ["deep"] }] }]);
  assert.equal(text, "1. Top\n   https://t.example\n   subpages:\n   1. Sub\n      https://t.example/sub\n      highlights:\n      - deep");
  assert.equal(formatRun({}), "research run ?: unknown");
});

const liveKey = process.env.EXA_API_KEY;
test("live: search reaches the real API", { skip: liveKey ? false : "set EXA_API_KEY to run" }, async () => {
  const tools = createTools();
  const out = String(await tools.search({ query: "Exa AI web search API documentation", numResults: 2, type: "fast" }, envWith({ apiKey: liveKey })));
  assert.match(out, /^1\. .+\n {3}https?:\/\//);
  assert.match(out, /cost: \$/);
});

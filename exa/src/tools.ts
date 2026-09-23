// The tools. Each one maps the arguments the model sent onto one Exa request and formats the
// reply for the model. `createTools` takes the HTTP and clock dependencies so tests can fake them.
import type { Tool, ToolEnv } from "@thetis/runtime/contracts";
import { createClient, ExaError, type ExaClient, type FetchLike, type Query } from "./client.js";
import { formatAnswer, formatCost, formatResults, formatRun, formatRunList, formatStatuses, join, type AgentRun, type ExaResult, type ExaStatus } from "./format.js";

export interface ToolDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Args = Record<string, unknown>;

const DEFAULT_RESULTS = 8;
const DEFAULT_WAIT_SECONDS = 240;
const MAX_WAIT_SECONDS = 540;
const POLL_MS = 5_000;

export function createTools(deps: ToolDeps = {}): Record<string, Tool> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = deps.now ?? (() => Date.now());
  const client = (env: ToolEnv): ExaClient => createClient(env.config, deps.fetch);
  const defaults = (env: ToolEnv) => (client(env).config.defaults ?? {}) as { numResults?: number; maxCharacters?: number; researchWaitSeconds?: number };

  const search: Tool = async (args, env) => {
    const d = defaults(env);
    const body: Args = {
      query: need(args, "query"),
      type: str(args.type),
      category: str(args.category),
      numResults: num(args.numResults) ?? d.numResults ?? DEFAULT_RESULTS,
      includeDomains: list(args.includeDomains),
      excludeDomains: list(args.excludeDomains),
      startPublishedDate: str(args.startPublishedDate),
      endPublishedDate: str(args.endPublishedDate),
      startCrawlDate: str(args.startCrawlDate),
      endCrawlDate: str(args.endCrawlDate),
      includeText: list(args.includeText),
      excludeText: list(args.excludeText),
      userLocation: str(args.userLocation),
      additionalQueries: list(args.additionalQueries),
      contents: contentsOf(args, d, { highlights: true }),
    };
    const res = (await client(env).post("/search", clean(body))) as { results?: ExaResult[]; searchType?: string; costDollars?: { total?: number } };
    return join([formatResults(res.results, { maxCharacters: num(args.maxCharacters) ?? d.maxCharacters }), res.searchType ? `search type: ${res.searchType}` : "", formatCost(res)]);
  };

  const contents: Tool = async (args, env) => {
    const d = defaults(env);
    const urls = list(args.urls) ?? (args.url ? [String(args.url)] : undefined);
    if (!urls?.length) throw new ExaError("urls is required");
    const body: Args = {
      urls,
      ...contentsOf(args, d, { text: true }),
      maxAgeHours: num(args.maxAgeHours),
      livecrawlTimeout: num(args.livecrawlTimeout),
      subpages: num(args.subpages),
      subpageTarget: list(args.subpageTarget) ?? str(args.subpageTarget),
      extras: num(args.links) ? { links: num(args.links) } : undefined,
    };
    const res = (await client(env).post("/contents", clean(body))) as { results?: ExaResult[]; statuses?: ExaStatus[]; costDollars?: { total?: number } };
    return join([formatResults(res.results, { maxCharacters: num(args.maxCharacters) ?? d.maxCharacters }), formatStatuses(res.statuses), formatCost(res)]);
  };

  const summarize: Tool = async (args, env) => {
    const urls = list(args.urls) ?? (args.url ? [String(args.url)] : undefined);
    if (!urls?.length) throw new ExaError("urls is required");
    const summary: Args = { query: str(args.query) ?? "Summarize the page: its purpose, its main points, and any key facts, numbers, or dates." };
    if (args.schema && typeof args.schema === "object") summary.schema = args.schema;
    const body: Args = { urls, summary, text: false, maxAgeHours: num(args.maxAgeHours) };
    const res = (await client(env).post("/contents", clean(body))) as { results?: ExaResult[]; statuses?: ExaStatus[]; costDollars?: { total?: number } };
    return join([formatResults(res.results), formatStatuses(res.statuses), formatCost(res)]);
  };

  const findSimilar: Tool = async (args, env) => {
    const d = defaults(env);
    const body: Args = {
      url: need(args, "url"),
      numResults: num(args.numResults) ?? d.numResults ?? DEFAULT_RESULTS,
      excludeSourceDomain: bool(args.excludeSourceDomain),
      includeDomains: list(args.includeDomains),
      excludeDomains: list(args.excludeDomains),
      startPublishedDate: str(args.startPublishedDate),
      endPublishedDate: str(args.endPublishedDate),
      includeText: list(args.includeText),
      excludeText: list(args.excludeText),
      contents: contentsOf(args, d, { highlights: true }),
    };
    const res = (await client(env).post("/findSimilar", clean(body))) as { results?: ExaResult[]; costDollars?: { total?: number } };
    return join([formatResults(res.results, { maxCharacters: num(args.maxCharacters) ?? d.maxCharacters }), formatCost(res)]);
  };

  const answer: Tool = async (args, env) => {
    const d = defaults(env);
    const body: Args = {
      query: need(args, "query"),
      text: bool(args.text),
      model: str(args.model),
      systemPrompt: str(args.systemPrompt),
      userLocation: str(args.userLocation),
      outputSchema: args.outputSchema && typeof args.outputSchema === "object" ? args.outputSchema : undefined,
    };
    const res = (await client(env).post("/answer", clean(body))) as Parameters<typeof formatAnswer>[0];
    return formatAnswer(res, { maxCharacters: num(args.maxCharacters) ?? d.maxCharacters });
  };

  const research: Tool = async (args, env) => {
    const d = defaults(env);
    const body: Args = {
      query: need(args, "query"),
      systemPrompt: str(args.systemPrompt),
      effort: str(args.effort),
      outputSchema: args.outputSchema && typeof args.outputSchema === "object" ? args.outputSchema : undefined,
      previousRunId: str(args.previousRunId),
      budget: num(args.maxCostDollars) !== undefined ? { maxCostDollars: num(args.maxCostDollars) } : undefined,
    };
    const c = client(env);
    let run = (await c.post("/agent/runs", clean(body))) as AgentRun;
    const wait = bool(args.wait) ?? true;
    if (!wait || !run.id) return formatRun(run);
    const id = run.id;
    const limit = Math.min(MAX_WAIT_SECONDS, num(args.waitSeconds) ?? d.researchWaitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
    const started = now();
    while (isPending(run.status) && now() - started < limit) {
      await sleep(POLL_MS);
      run = (await c.get(`/agent/runs/${encodeURIComponent(id)}`)) as AgentRun;
    }
    const text = formatRun(run);
    return isPending(run.status) ? `${text}\n\nstill running after ${Math.round(limit / 1000)} seconds: call exa_research_get with this id later.` : text;
  };

  const researchGet: Tool = async (args, env) => {
    const id = need(args, "id");
    return formatRun((await client(env).get(`/agent/runs/${encodeURIComponent(id)}`)) as AgentRun);
  };

  const researchCancel: Tool = async (args, env) => {
    const id = need(args, "id");
    return formatRun((await client(env).post(`/agent/runs/${encodeURIComponent(id)}/cancel`, {})) as AgentRun);
  };

  const researchList: Tool = async (args, env) => {
    const query: Query = { limit: num(args.limit), cursor: str(args.cursor) };
    return formatRunList((await client(env).get("/agent/runs", query)) as Parameters<typeof formatRunList>[0]);
  };

  const request: Tool = async (args, env) => {
    const method = str(args.method) ?? (args.body ? "POST" : "GET");
    const path = need(args, "path");
    const body = args.body && typeof args.body === "object" ? (args.body as Args) : undefined;
    const query = args.query && typeof args.query === "object" ? (args.query as Query) : undefined;
    const res = await client(env).request(method, path, body, query);
    return typeof res === "string" ? res : (res as object) ?? "ok";
  };

  return { search, contents, summarize, findSimilar, answer, research, researchGet, researchCancel, researchList, request };
}

function isPending(status: string | undefined): boolean {
  return status === undefined || status === "queued" || status === "running";
}

/** The `contents` object of search, findSimilar and contents. `text: <number>` means text cut at that many characters. */
function contentsOf(args: Args, d: { maxCharacters?: number }, fallback: Args): Args {
  const out: Args = {};
  const max = num(args.maxCharacters) ?? d.maxCharacters;
  const text = args.text;
  if (typeof text === "number") out.text = { maxCharacters: text };
  else if (bool(text)) out.text = max ? { maxCharacters: max } : true;
  else if (text === false) out.text = false;
  if (bool(args.highlights) !== undefined) out.highlights = bool(args.highlights);
  if (typeof args.highlightsQuery === "string") out.highlights = { query: args.highlightsQuery };
  if (typeof args.summary === "string") out.summary = { query: args.summary };
  else if (bool(args.summary)) out.summary = args.summaryQuery ? { query: String(args.summaryQuery) } : {};
  if (num(args.maxAgeHours) !== undefined) out.maxAgeHours = num(args.maxAgeHours);
  const asked = ["text", "highlights", "summary"].some((k) => out[k] !== undefined && out[k] !== false);
  return asked ? out : { ...fallback, ...out };
}

function need(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ExaError(`${key} is required`);
  return v.trim();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function list(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  return undefined;
}

/** Drop undefined fields so the request carries only what was asked. */
function clean(body: Args): Args {
  const out: Args = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined) out[k] = v;
  return out;
}

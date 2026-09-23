// Turn Exa responses into compact text for a model. The shapes here follow the Exa API
// reference; every field is optional because the API returns only what was asked for.

import type { AgentRun, Citation, Cost, ExaResult, ExaStatus } from "./schemas.js";
export type { AgentRun, Citation, Cost, ExaResult, ExaStatus } from "./schemas.js";

export interface FormatOptions {
  /** Cut `text` fields at this many characters. */
  maxCharacters?: number;
}

const BLANK = "(untitled)";

export function formatResults(results: ExaResult[] | undefined, opts: FormatOptions = {}, indent = ""): string {
  if (!results || results.length === 0) return `${indent}no results`;
  return results.map((r, i) => formatResult(r, i + 1, opts, indent)).join("\n\n");
}

export function formatResult(r: ExaResult, n: number, opts: FormatOptions = {}, indent = ""): string {
  const pad = `${indent}   `;
  const lines = [`${indent}${n}. ${(r.title ?? "").trim() || BLANK}`, `${pad}${r.url ?? r.id ?? ""}`.trimEnd()];
  const meta: string[] = [];
  if (r.publishedDate) meta.push(`published ${String(r.publishedDate).slice(0, 10)}`);
  if (r.author) meta.push(`by ${r.author}`);
  if (typeof r.score === "number") meta.push(`score ${r.score.toFixed(3)}`);
  if (meta.length) lines.push(`${pad}${meta.join(" · ")}`);
  if (r.summary) lines.push(`${pad}summary: ${oneBlock(r.summary, pad)}`);
  if (r.highlights?.length) {
    lines.push(`${pad}highlights:`);
    for (const h of r.highlights) lines.push(`${pad}- ${oneBlock(h, `${pad}  `)}`);
  }
  if (r.text) {
    lines.push(`${pad}text:`);
    lines.push(cut(r.text, opts.maxCharacters).split("\n").map((l) => `${pad}${l}`).join("\n"));
  }
  if (r.extras?.links?.length) lines.push(`${pad}links: ${r.extras.links.join(", ")}`);
  if (r.subpages?.length) {
    lines.push(`${pad}subpages:`);
    lines.push(formatResults(r.subpages, opts, pad));
  }
  return lines.join("\n");
}

export function formatStatuses(statuses: ExaStatus[] | undefined): string {
  const failed = (statuses ?? []).filter((s) => s.status && s.status !== "success");
  if (!failed.length) return "";
  return `not fetched:\n${failed.map((s) => `- ${s.id ?? "?"}: ${describeError(s.error)}`).join("\n")}`;
}

export function formatCost(res: Cost | undefined): string {
  const total = res?.costDollars?.total;
  return typeof total === "number" ? `cost: $${total.toFixed(4)}` : "";
}

export function formatCitations(citations: Citation[] | undefined, opts: FormatOptions = {}): string {
  if (!citations?.length) return "";
  const lines = ["sources:"];
  citations.forEach((c, i) => {
    const meta = [c.publishedDate ? String(c.publishedDate).slice(0, 10) : "", c.author ?? ""].filter(Boolean).join(", ");
    lines.push(`${i + 1}. ${(c.title ?? "").trim() || BLANK} — ${c.url ?? ""}${meta ? ` (${meta})` : ""}`);
    if (c.text) lines.push(cut(c.text, opts.maxCharacters).split("\n").map((l) => `   ${l}`).join("\n"));
  });
  return lines.join("\n");
}

export function formatAnswer(res: { answer?: unknown; citations?: Citation[] } & Cost, opts: FormatOptions = {}): string {
  const answer = typeof res.answer === "string" ? res.answer : JSON.stringify(res.answer ?? null, null, 2);
  return join([`answer:\n${answer}`, formatCitations(res.citations, opts), formatCost(res)]);
}

export function formatRun(run: AgentRun, opts: FormatOptions = {}): string {
  const head = [`research run ${run.id ?? "?"}: ${run.status ?? "unknown"}${run.stopReason ? ` (${run.stopReason})` : ""}`];
  if (run.request?.query) head.push(`query: ${run.request.query}`);
  const parts = [head.join("\n")];
  const out = run.output;
  if (out?.text) parts.push(`result:\n${cut(out.text, opts.maxCharacters)}`);
  if (out?.structured !== undefined && out.structured !== null) parts.push(`structured:\n${JSON.stringify(out.structured, null, 2)}`);
  const cites = new Map<string, string>();
  for (const g of out?.grounding ?? []) for (const c of g.citations ?? []) if (c.url && !cites.has(c.url)) cites.set(c.url, c.title ?? "");
  if (cites.size) parts.push(`sources:\n${[...cites].map(([url, title], i) => `${i + 1}. ${title.trim() || BLANK} — ${url}`).join("\n")}`);
  if (run.error) parts.push(`error: ${describeError(run.error)}`);
  parts.push(formatCost(run));
  return join(parts);
}

export function formatRunList(res: { data?: AgentRun[]; hasMore?: boolean; nextCursor?: string | null }): string {
  const rows = (res.data ?? []).map((r) => `- ${r.id ?? "?"} ${r.status ?? ""} ${r.createdAt ? String(r.createdAt).slice(0, 19) : ""}${r.request?.query ? `: ${cut(r.request.query, 100)}` : ""}`);
  const lines = [rows.length ? rows.join("\n") : "no runs"];
  if (res.hasMore && res.nextCursor) lines.push(`more: cursor=${res.nextCursor}`);
  return lines.join("\n");
}

export function cut(text: string, max?: number): string {
  const s = String(text);
  if (!max || max <= 0 || s.length <= max) return s;
  return `${s.slice(0, max)}… [cut at ${max} characters]`;
}

export function join(parts: string[]): string {
  return parts.filter((p) => p && p.trim()).join("\n\n");
}

function oneBlock(s: string, pad: string): string {
  return String(s).trim().split("\n").join(`\n${pad}`);
}

function describeError(e: unknown): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  const o = e as Record<string, unknown>;
  const tag = typeof o.tag === "string" ? o.tag : typeof o.message === "string" ? o.message : JSON.stringify(e);
  return typeof o.httpStatusCode === "number" ? `${tag} (http ${o.httpStatusCode})` : tag;
}

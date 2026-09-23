// A small HTTP client for the Exa API. It knows the base URL, the key header, the timeout,
// and how to turn an error body into one sentence. Nothing else.

import { parseSchema } from "@thetis/runtime/lib/validation";
import { ExaConfigSchema, type ExaConfig } from "./schemas.js";
export type { ExaConfig } from "./schemas.js";

export interface ResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

export type Query = Record<string, string | number | boolean | undefined>;

export interface ExaClient {
  readonly config: Required<Pick<ExaConfig, "baseUrl" | "timeoutMs">> & ExaConfig;
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
  get(path: string, query?: Query): Promise<unknown>;
  request(method: string, path: string, body?: Record<string, unknown>, query?: Query): Promise<unknown>;
}

export class ExaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ExaError";
  }
}

export const DEFAULT_BASE_URL = "https://api.exa.ai";
export const DEFAULT_TIMEOUT_MS = 60_000;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** A path the model or a tool asked for: one absolute path inside the API, no host, no parent segments. */
export function checkPath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("://") || path.split("/").includes("..")) {
    throw new ExaError(`invalid Exa API path: ${JSON.stringify(path)}`);
  }
  return path;
}

export function createClient(raw: Record<string, unknown> | undefined, fetchImpl: FetchLike = globalThis.fetch): ExaClient {
  const cfg = parseSchema(ExaConfigSchema, raw ?? {}, "Exa configuration");
  const config = { ...cfg, baseUrl: String(cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""), timeoutMs: Number(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) };

  async function request(method: string, path: string, body?: Record<string, unknown>, query?: Query): Promise<unknown> {
    const key = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    if (!key) throw new ExaError('Exa apiKey is not configured: set packages["@thetis/exa"].apiKey in thetis.config.json');
    const m = String(method).toUpperCase();
    if (!METHODS.has(m)) throw new ExaError(`unsupported method: ${method}`);
    const url = new URL(config.baseUrl + checkPath(path));
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { "x-api-key": key, accept: "application/json" };
    const init: RequestInitLike = { method: m, headers, signal: AbortSignal.timeout(config.timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res: ResponseLike;
    try {
      res = await fetchImpl(url.toString(), init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ExaError(`Exa request failed (${m} ${path}): ${reason}`);
    }
    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) throw new ExaError(`Exa ${res.status} on ${m} ${path}: ${errorMessage(parsed)}`, res.status);
    return parsed;
  }

  return {
    config,
    request,
    post: (path, body) => request("POST", path, body),
    get: (path, query) => request("GET", path, undefined, query),
  };
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["error", "message", "detail"]) if (typeof o[k] === "string") return o[k] as string;
    if (o.error && typeof o.error === "object") {
      const e = o.error as Record<string, unknown>;
      if (typeof e.message === "string") return typeof e.detail === "string" ? `${e.message} ${e.detail.replace(/\s+/g, " ").trim()}` : e.message;
    }
    return JSON.stringify(body).slice(0, 500);
  }
  return String(body || "no body").slice(0, 500);
}

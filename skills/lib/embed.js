// The vector source every retriever shares: an OpenAI-compatible embeddings endpoint, batched, a cache under
// the home keyed by model, dimensions and a content hash, the cosine, and the bench's vector file by corpus
// digest. Nothing here decides what to embed: a loader hands in texts and hashes, and says where its cache
// file lives. The key comes from the caller's own configuration and never appears in an error, a note or a
// file; a failure is thrown with the status and the caller falls back to lexical.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const DEFAULTS = Object.freeze({ baseUrl: "https://openrouter.ai/api/v1", model: "openai/text-embedding-3-small", dimensions: 1536 });
export const BATCH = 64;
export const TIMEOUT_MS = 20_000;
export const QUERY_CLIP = 2000;

/** `config.embeddings` over the defaults. A key the kernel did not interpolate (`${...}`) counts as no key. */
export function embeddingConfig(config) {
  const e = config?.embeddings && typeof config.embeddings === "object" ? config.embeddings : {};
  const key = typeof e.apiKey === "string" ? e.apiKey.trim() : "";
  const dims = Number(e.dimensions);
  return {
    baseUrl: (typeof e.baseUrl === "string" && e.baseUrl.trim() ? e.baseUrl.trim() : DEFAULTS.baseUrl).replace(/\/+$/, ""),
    apiKey: key.includes("${") ? "" : key,
    model: typeof e.model === "string" && e.model.trim() ? e.model.trim() : DEFAULTS.model,
    dimensions: Number.isInteger(dims) && dims > 0 ? dims : DEFAULTS.dimensions,
  };
}

/** The cache key of one vector. */
export const keyOf = (model, dimensions, contentHash) => `${model}|${dimensions}|${contentHash}`;
export const hashOfKey = (key) => key.slice(key.lastIndexOf("|") + 1);

/** The harness ends an input with a [Turn context: ...] line; it is not part of what the person asked. */
const TURN_CONTEXT = /\n\n\[Turn context: [^\n\]]*\]$/;
/** The query as it is ranked and hashed: the text without the turn context line, clipped to `QUERY_CLIP` characters. */
export const queryTextOf = (text) => String(text ?? "").replace(TURN_CONTEXT, "").slice(0, QUERY_CLIP);
export const queryHashOf = (text) => createHash("sha256").update(queryTextOf(text)).digest("hex");

export const round6 = (vector) => vector.map((x) => Math.round(Number(x) * 1e6) / 1e6);

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The cache at `path` under the home as an object of key to vector, or empty when the file is missing or unreadable. */
export async function readCache(env, path) {
  let text;
  try {
    text = await env.readFile(path);
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v) && v.every((x) => typeof x === "number")) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Writes the cache with every key whose content hash is still live. Keys are sorted, so the file is stable. */
export async function writeCache(env, cache, liveHashes, path) {
  const live = liveHashes instanceof Set ? liveHashes : new Set(liveHashes ?? []);
  const kept = Object.keys(cache)
    .filter((k) => live.has(hashOfKey(k)))
    .sort();
  const out = {};
  for (const k of kept) out[k] = cache[k];
  await env.writeFile(path, `${JSON.stringify(out)}\n`);
  return out;
}

/**
 * Embeds `texts` in batches of `BATCH`, each request under `TIMEOUT_MS`. Returns one rounded vector per text,
 * in order. Throws on any refusal, timeout or malformed answer; the message names the status, never the key.
 */
export async function embed(texts, cfg, fetchImpl = globalThis.fetch) {
  if (!cfg.apiKey) throw new Error("no embeddings key");
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");
  const out = [];
  for (let at = 0; at < texts.length; at += BATCH) {
    const input = texts.slice(at, at + BATCH);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}`, "HTTP-Referer": "https://github.com/thetis", "X-Title": "Thetis" },
        body: JSON.stringify({ model: cfg.model, input, dimensions: cfg.dimensions }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new Error(e?.name === "AbortError" ? `embeddings request timed out after ${TIMEOUT_MS} ms` : `embeddings request failed: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {}
      throw new Error(`embeddings ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = await res.json();
    const data = Array.isArray(body?.data) ? [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : null;
    if (!data || data.length !== input.length) throw new Error(`embeddings answered ${data?.length ?? 0} vectors for ${input.length} inputs`);
    for (const item of data) {
      if (!Array.isArray(item.embedding) || !item.embedding.length) throw new Error("embeddings answered without a vector");
      out.push(round6(item.embedding));
    }
  }
  return out;
}

// --- the bench's vector file -------------------------------------------------------------------------------
//
// One file per corpus, `<dir>/<corpus sha256>.json`, written once by a package's scripts/embed-corpus.mjs, so a
// bench run ranks densely without a key, a network or a difference between machines. `vectors` maps a content
// hash to a vector; `queries` maps a query hash to one. A file written by skills-hybrid before this library
// existed calls the first map `skills`, and is read the same.

const files = new Map();

/** `sha256:abc…` or `abc…` to the hex the file is named after. */
export const hexOf = (sha) => String(sha ?? "").replace(/^sha256:/, "");

export const benchVectorsPath = (sha, dir) => `${dir}${hexOf(sha)}.json`;

/** The file for a corpus digest as `{ model, dimensions, corpus, vectors, queries }`, or null when there is none. */
export function benchVectorsFor(sha, dir) {
  const hex = hexOf(sha);
  if (!/^[0-9a-f]{64}$/.test(hex) || typeof dir !== "string") return null;
  const path = benchVectorsPath(hex, dir);
  if (files.has(path)) return files.get(path);
  let parsed = null;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const vectors = raw?.vectors ?? raw?.skills;
      if (raw && typeof raw === "object" && vectors && typeof vectors === "object") {
        parsed = { model: String(raw.model ?? ""), dimensions: Number(raw.dimensions) || 0, corpus: raw.corpus ?? {}, vectors, queries: raw.queries ?? {} };
      }
    } catch {
      parsed = null;
    }
  }
  files.set(path, parsed);
  return parsed;
}

/** Forgets every vector file read. Tests use it. */
export function clearVectorCache() {
  files.clear();
}

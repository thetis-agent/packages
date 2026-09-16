// The vector source: an OpenAI-compatible embeddings endpoint, batched, with a cache under the home keyed by
// model, dimensions and the skill's content hash. The key is read from the package's own configuration and
// never appears in an error, a note or a file; a failure leaves the loader lexical for the turn.
import { createHash } from "node:crypto";

export const DEFAULTS = Object.freeze({ baseUrl: "https://openrouter.ai/api/v1", model: "openai/text-embedding-3-small", dimensions: 1536 });
export const CACHE_PATH = "skills-hybrid/vectors.json";
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

/** The cache key of one skill's vector. */
export const keyOf = (model, dimensions, contentHash) => `${model}|${dimensions}|${contentHash}`;
export const hashOfKey = (key) => key.slice(key.lastIndexOf("|") + 1);

/** What is embedded for a skill: the same fields retrieval indexes, and nothing from the body. */
export const indexTextOf = (skill) => [skill.name ?? "", skill.description ?? "", (skill.tags ?? []).join(" ")].filter(Boolean).join("\n");

/** The query as it is ranked and hashed: the text clipped to `QUERY_CLIP` characters. */
export const queryTextOf = (text) => String(text ?? "").slice(0, QUERY_CLIP);
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

/** The cache as an object of key to vector, or empty when the file is missing or unreadable. */
export async function readCache(env) {
  let text;
  try {
    text = await env.readFile(CACHE_PATH);
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

/** Writes the cache with every key whose content hash no live skill has removed. Keys are sorted, so the file is stable. */
export async function writeCache(env, cache, liveHashes) {
  const live = liveHashes instanceof Set ? liveHashes : new Set(liveHashes ?? []);
  const kept = Object.keys(cache)
    .filter((k) => live.has(hashOfKey(k)))
    .sort();
  const out = {};
  for (const k of kept) out[k] = cache[k];
  await env.writeFile(CACHE_PATH, `${JSON.stringify(out)}\n`);
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

// The bench's vectors: one file per corpus under this package, written once by scripts/embed-corpus.mjs, so a
// bench run ranks densely without a key, a network or a difference between machines.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VECTORS_DIR = fileURLToPath(new URL("../bench/vectors/", import.meta.url));

const cache = new Map();

/** `sha256:abc…` or `abc…` to the file name the corpus's vectors live under. */
export const hexOf = (sha) => String(sha ?? "").replace(/^sha256:/, "");

export const benchVectorsPath = (sha, dir = VECTORS_DIR) => `${dir}${hexOf(sha)}.json`;

/** The file for a corpus digest as `{ model, dimensions, corpus, skills, queries }`, or null when there is none. */
export function benchVectorsFor(sha, dir = VECTORS_DIR) {
  const hex = hexOf(sha);
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const path = benchVectorsPath(hex, dir);
  if (cache.has(path)) return cache.get(path);
  let parsed = null;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (raw && typeof raw === "object" && raw.skills && typeof raw.skills === "object") {
        parsed = { model: String(raw.model ?? ""), dimensions: Number(raw.dimensions) || 0, corpus: raw.corpus ?? {}, skills: raw.skills, queries: raw.queries ?? {} };
      }
    } catch {
      parsed = null;
    }
  }
  cache.set(path, parsed);
  return parsed;
}

/** Forgets every file read. Tests use it. */
export function clearVectorCache() {
  cache.clear();
}

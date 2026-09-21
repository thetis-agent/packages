// The bench's vectors: one file per corpus under this package, written once by scripts/embed-corpus.mjs, so a
// bench run ranks densely without a key, a network or a difference between machines. The reader is the
// shared one in @thetis/skills; this binds it to this package's directory and keeps the `skills` name the
// file has always used for its vector map.
import { fileURLToPath } from "node:url";
import { benchVectorsFor as readVectors, benchVectorsPath as pathOf, clearVectorCache, hexOf } from "@thetis/skills";

export const VECTORS_DIR = fileURLToPath(new URL("../bench/vectors/", import.meta.url));

export { clearVectorCache, hexOf };

export const benchVectorsPath = (sha, dir = VECTORS_DIR) => pathOf(sha, dir);

/** The file for a corpus digest as `{ model, dimensions, corpus, skills, queries }`, or null when there is none. */
export function benchVectorsFor(sha, dir = VECTORS_DIR) {
  const file = readVectors(sha, dir);
  return file ? { model: file.model, dimensions: file.dimensions, corpus: file.corpus, skills: file.vectors, queries: file.queries } : null;
}

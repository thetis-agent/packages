// What a person changed in their copy of an extension, file by file. A copy records its origin's files when it
// is made (`.thetis-fork-base.json` beside its package.json: `{ <relative path>: <sha256> }`, written by the
// runtime's `forkPackage`), so the files whose hash differs from that record now -- or that the record does not
// have, or that are gone -- are the person's changes. This is what the page of a copy the official version has
// moved past says before "Use Thetis's version" replaces them: "You changed 1 file since 0.3.3: dist/src/index.js".
//
// The hashing is the runtime's own rule (`fileHashes` in lib/pkg-fs), repeated here because that function is not
// exported: every file under the package with `node_modules`, `.git` and the base file left out, a symbolic
// link hashed by its target, and package.json with the fields a fork rewrites taken out.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const FORK_BASE = ".thetis-fork-base.json";
const SKIP = new Set(["node_modules", ".git"]);
const FORK_FIELDS = ["name", "version", "scripts", "dependencies", "devDependencies"];
/** Bounds the walk, so a package with a large tree cannot make a page slow. */
const LIMIT = 5000;

/** package.json as the base recorded it: without what a fork rewrites. */
function neutralManifest(file) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  for (const field of FORK_FIELDS) delete manifest[field];
  if (manifest.thetis && typeof manifest.thetis === "object") {
    const { forkedFrom: _, ...rest } = manifest.thetis;
    manifest.thetis = rest;
  }
  return JSON.stringify(manifest);
}

/** Every file of a package tree with its sha256, in the runtime's shape. */
export function fileHashes(root) {
  const out = {};
  let seen = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++seen > LIMIT) throw new Error("too many files to compare");
      if (SKIP.has(entry.name) || (dir === root && entry.name === FORK_BASE)) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const bytes = entry.isSymbolicLink() ? `L${readlinkSync(path)}` : path === resolve(root, "package.json") ? neutralManifest(path) : readFileSync(path);
        out[relative(root, path).split(sep).join("/")] = createHash("sha256").update(bytes).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

/**
 * The files a copy changed since it was made, sorted, or null when that cannot be known: no base recorded (a
 * copy made before bases were), or a side that cannot be read. An empty list is a copy that changed nothing.
 */
export function changedFiles(root) {
  try {
    if (!root) return null;
    const file = resolve(root, FORK_BASE);
    if (!existsSync(file)) return null;
    const base = JSON.parse(readFileSync(file, "utf8"));
    const now = fileHashes(root);
    return [...new Set([...Object.keys(base), ...Object.keys(now)])].filter((p) => base[p] !== now[p]).sort();
  } catch {
    return null;
  }
}

// What a person changed in their copy of an extension: the files, and the change itself as a unified diff of
// the text files, cut at 200 lines. A copy records its origin's files when it is made (`.thetis-fork-base.json`
// beside its package.json: `{ <relative path>: <sha256> }`, written by the runtime's `forkPackage`), so the files
// whose hash differs from that record now -- or that the record does not have, or that are gone -- are the
// person's changes. The same rule as `@thetis/ui-marketplace`'s `lib/fork-diff.js`, restated because a package
// imports only its own files; the hashing is the runtime's (`fileHashes` in lib/pkg-fs, not exported).
//
// Only hashes of the base are recorded, not its text, so a changed file is compared with the origin's file on
// disk now. When that file still hashes to the base, the diff is exactly what the person changed; when the
// origin moved on too, the diff also holds the origin's own changes, and the answer says so (`moved`).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const FORK_BASE = ".thetis-fork-base.json";
const SKIP = new Set(["node_modules", ".git"]);
const FORK_FIELDS = ["name", "version", "scripts", "dependencies", "devDependencies"];
/** Bounds the walk, so a package with a large tree cannot make a page slow. */
const LIMIT = 5000;
/** The diff's length, in lines, and the largest file compared line by line. */
export const DIFF_LINES = 200;
const FILE_LINES = 3000;
const FILE_BYTES = 512 * 1024;

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

const hashOf = (root, path, isLink) => createHash("sha256").update(isLink ? `L${readlinkSync(path)}` : path === resolve(root, "package.json") ? neutralManifest(path) : readFileSync(path)).digest("hex");

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
      else out[relative(root, path).split(sep).join("/")] = hashOf(root, path, entry.isSymbolicLink());
    }
  };
  walk(root);
  return out;
}

/** The base a copy recorded, or null when it has none (a copy made before bases were) or it cannot be read. */
export function baseOf(root) {
  try {
    const file = resolve(root, FORK_BASE);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

/** A file's text when it is a small text file, else null. */
function textOf(path) {
  try {
    if (!existsSync(path)) return "";
    const st = statSync(path);
    if (!st.isFile() || st.size > FILE_BYTES) return null;
    const buf = readFileSync(path);
    if (buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The lines of a unified diff between two texts, three lines of context around each change. A plain longest
 * common subsequence: the files compared are small, and a readable answer matters more than the fastest one.
 */
export function unifiedLines(a, b, context = 3) {
  // A last newline ends the last line; it is not a line of its own.
  const x = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const y = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = []; // [kind, text, i, j]: " " same, "-" only in a, "+" only in b
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push([" ", x[i], i++, j++]);
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(["-", x[i], i++, j]);
    else ops.push(["+", y[j], i, j++]);
  }
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === " ") {
      k++;
      continue;
    }
    // A hunk: the change, with context before and after, merged with the next change when their contexts touch.
    const start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end][0] !== " ") {
        end++;
        continue;
      }
      let run = end;
      while (run < ops.length && ops[run][0] === " ") run++;
      if (run === ops.length || run - end > context * 2) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end = run;
    }
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((o) => o[0] !== "+").length;
    const newCount = hunk.filter((o) => o[0] !== "-").length;
    out.push(`@@ -${hunk[0][2] + 1},${oldCount} +${hunk[0][3] + 1},${newCount} @@`);
    for (const [kind, text] of hunk) out.push(`${kind}${text}`);
    k = end;
  }
  return out;
}

/**
 * The files a copy changed since it was made and, for the text ones, the change against its origin's file on
 * disk, cut at `DIFF_LINES` lines: `{ files, diff, cut, moved }`, or `{ files: null }` when the copy has no base
 * to compare with. `originRoot` may be null (the origin is not on disk): the files are then listed alone.
 */
export function copyChanges(root, originRoot) {
  const base = root ? baseOf(root) : null;
  if (!base) return { files: null, diff: [], cut: false, moved: false };
  let now;
  try {
    now = fileHashes(root);
  } catch {
    return { files: null, diff: [], cut: false, moved: false };
  }
  const files = [...new Set([...Object.keys(base), ...Object.keys(now)])].filter((p) => base[p] !== now[p]).sort();
  const diff = [];
  let moved = false;
  let cut = false;
  if (originRoot) {
    for (const file of files) {
      if (diff.length >= DIFF_LINES) {
        cut = true;
        break;
      }
      const theirs = resolve(originRoot, file);
      const mine = resolve(root, file);
      // package.json differs in the fields a fork rewrites; those are not the person's change.
      const a = file === "package.json" ? null : textOf(theirs);
      const b = file === "package.json" ? null : textOf(mine);
      if (a === null || b === null) {
        diff.push(`--- ${file}`, file === "package.json" ? "(the manifest: compared without the fields a copy rewrites)" : "(not a text file, or too large to show)");
        continue;
      }
      if (existsSync(theirs) && base[file]) {
        try {
          if (hashOf(originRoot, theirs, false) !== base[file]) moved = true;
        } catch {
          /* unreadable: the diff below says what it can */
        }
      }
      if (a.split("\n").length > FILE_LINES || b.split("\n").length > FILE_LINES) {
        diff.push(`--- ${file}`, "(too long to compare line by line)");
        continue;
      }
      diff.push(`--- a/${file}`, `+++ b/${file}`, ...unifiedLines(a, b));
    }
  }
  if (diff.length > DIFF_LINES) {
    diff.length = DIFF_LINES;
    cut = true;
  }
  return { files, diff, cut, moved };
}

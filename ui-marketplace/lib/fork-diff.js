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

/** At most this many diff lines go to the page, across every file. */
export const DIFF_LINES = 200;
/** A file larger than this, or with a NUL byte near its start, is not compared as text. */
const TEXT_LIMIT = 512 * 1024;

/** The text of a file for the diff, or null when it is not text or cannot be read. package.json reads as the base recorded it, pretty. */
function textOf(root, path) {
  try {
    const at = resolve(root, path);
    if (!existsSync(at)) return "";
    if (path === "package.json") return `${JSON.stringify(JSON.parse(neutralManifest(at)), null, 2)}\n`;
    const bytes = readFileSync(at);
    if (bytes.length > TEXT_LIMIT || bytes.subarray(0, 8000).includes(0)) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

/** The hash a file of an origin has now, the same rule as `fileHashes`, or null when it is not there. */
function hashNow(root, path) {
  try {
    const at = resolve(root, path);
    if (!existsSync(at)) return null;
    return createHash("sha256").update(path === "package.json" ? neutralManifest(at) : readFileSync(at)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * The edit script between two lists of lines, by Myers' algorithm on what is left once the common start and end
 * are taken off: `[["=", line] | ["-", line] | ["+", line]]`, or null when the two differ too much to be worth
 * showing.
 */
export function lineDiff(a, b, maxEdits = 2000) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const n = x.length;
  const m = y.length;
  const max = Math.min(n + m, maxEdits);
  const v = new Map([[1, 0]]);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v.set(k, i);
      if (i >= n && j >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return null;
  // Back through the trace, from the end to the start.
  const middle = [];
  let i = n;
  let j = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = i - j;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevI = vd.get(prevK) ?? 0;
    const prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) middle.push(["=", x[--i], j--]);
    if (d > 0) {
      if (i === prevI) middle.push(["+", y[--j]]);
      else middle.push(["-", x[--i]]);
    }
  }
  middle.reverse();
  return [...a.slice(0, start).map((l) => ["=", l]), ...middle.map(([op, l]) => [op, l]), ...a.slice(endA).map((l) => ["=", l])];
}

/** A unified diff of one file from an edit script, three lines of context around each change. */
export function unified(path, script, context = 3) {
  const out = [];
  const keep = script.map(([op]) => op !== "=");
  const near = script.map((_, i) => keep.slice(Math.max(0, i - context), i + context + 1).some(Boolean));
  let aLine = 1;
  let bLine = 1;
  let hunk = null;
  const flush = () => {
    if (!hunk) return;
    out.push(`@@ -${hunk.a},${hunk.aN} +${hunk.b},${hunk.bN} @@`, ...hunk.lines);
    hunk = null;
  };
  script.forEach(([op, line], i) => {
    if (near[i]) {
      hunk ??= { a: aLine, b: bLine, aN: 0, bN: 0, lines: [] };
      hunk.lines.push(`${op === "=" ? " " : op}${line}`);
      if (op !== "+") hunk.aN++;
      if (op !== "-") hunk.bN++;
    } else flush();
    if (op !== "+") aLine++;
    if (op !== "-") bLine++;
  });
  flush();
  return out.length ? [`--- ${path} (as copied)`, `+++ ${path} (yours)`, ...out] : [];
}

/**
 * What a copy changed, for the page's Show changes: `{ files, diff, cut }`. `files` is `changedFiles`; `diff` the
 * unified diff of each changed text file whose original is still in `originRoot` exactly as the copy's base
 * recorded it (so the diff is the person's change and nothing the original did since), at most `DIFF_LINES`
 * lines, with `cut` true when there was more.
 */
export function changesOf(root, originRoot, limit = DIFF_LINES) {
  const files = changedFiles(root);
  if (!files || !files.length || !originRoot) return { files, diff: "", cut: false, compared: 0 };
  let base;
  try {
    base = JSON.parse(readFileSync(resolve(root, FORK_BASE), "utf8"));
  } catch {
    return { files, diff: "", cut: false, compared: 0 };
  }
  const lines = [];
  let cut = false;
  let compared = 0;
  for (const path of files) {
    if (lines.length >= limit) {
      cut = true;
      break;
    }
    // The original's file as it was when the copy was made: the same hash as the base, or absent in both.
    const was = base[path] ?? null;
    if (hashNow(originRoot, path) !== was) continue;
    const before = was ? textOf(originRoot, path) : "";
    const after = textOf(root, path);
    if (before === null || after === null) continue;
    const split = (t) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
    const script = lineDiff(split(before), split(after));
    if (!script) continue;
    compared += 1;
    for (const l of unified(path, script)) {
      if (lines.length >= limit) {
        cut = true;
        break;
      }
      lines.push(l);
    }
  }
  return { files, diff: lines.join("\n"), cut, compared };
}

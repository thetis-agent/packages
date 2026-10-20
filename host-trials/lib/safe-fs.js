// File access below a directory a person can write to, done as a user who can write much more. Every path
// is relative to `root`, checked segment by segment, and no segment may be a symbolic link: a link the
// person planted (`trials -> /opt/zero/data/store`) would otherwise turn a write the host makes for them
// into a write anywhere the daemon's user may write, and a read into a way to see its secrets. The final
// file is opened with O_NOFOLLOW as well. This is the inner check; the outer one is the jail (jail.js),
// which makes even a link swapped in between the check and the write lead nowhere.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { posix, resolve } from "node:path";
import { assert, fail } from "./error.js";

const SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9._@-]{0,127}$/;
/** The most one read hands back: a trial's files are records and snapshots, never this large. */
export const READ_CAP = 16 * 1024 * 1024;

/** A relative path made only of plain segments: no `..`, no `.`, no empty segment, no leading slash. */
export function checkRelative(rel) {
  assert(typeof rel === "string" && rel.length > 0 && rel.length <= 1024, `a path must be a non-empty string: ${String(rel)}`);
  assert(!rel.startsWith("/") && posix.normalize(rel) === rel, `a path must be relative and normalized: ${rel}`);
  const segments = rel.split("/");
  for (const s of segments) assert(SEGMENT.test(s) && s !== "." && s !== "..", `a path segment may hold letters, digits, ., _, @ and - only: ${rel}`);
  return segments;
}

/** The directory of `rel` under `root`, every segment a real directory and none a link, made when `create`. */
function parentOf(root, rel, create) {
  const segments = checkRelative(rel);
  let dir = root;
  assertDir(dir, root);
  for (const s of segments.slice(0, -1)) {
    dir = resolve(dir, s);
    let st;
    try {
      st = lstatSync(dir);
    } catch (e) {
      if (e?.code !== "ENOENT" || !create) throw e;
      mkdirSync(dir);
      st = lstatSync(dir);
    }
    assert(!st.isSymbolicLink(), `refusing ${rel}: ${s} is a link`, "unauthorized");
    assert(st.isDirectory(), `refusing ${rel}: ${s} is not a directory`);
  }
  return { dir, name: segments[segments.length - 1], path: resolve(dir, segments[segments.length - 1]) };
}

function assertDir(dir, label) {
  const st = lstatSync(dir);
  assert(!st.isSymbolicLink() && st.isDirectory(), `refusing ${label}: not a plain directory`, "unauthorized");
}

/** Writes `content` to `rel` as a whole file: a fresh temporary beside it, then a rename. */
export function safeWrite(root, rel, content) {
  const { dir, name, path } = parentOf(root, rel, true);
  try {
    const st = lstatSync(path);
    assert(st.isFile(), `refusing ${rel}: it is not a plain file`, "unauthorized");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const tmp = resolve(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, String(content));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Appends `content` to `rel`, creating it. */
export function safeAppend(root, rel, content) {
  const { path } = parentOf(root, rel, true);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try {
    assert(fstatSync(fd).isFile(), `refusing ${rel}: it is not a plain file`, "unauthorized");
    writeSync(fd, String(content));
  } finally {
    closeSync(fd);
  }
}

/** The text of `rel`, or null when it is not there. A link, or anything but a plain file, is refused. */
export function safeRead(root, rel, cap = READ_CAP) {
  let path;
  try {
    path = parentOf(root, rel, false).path;
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    if (e?.code === "ELOOP") fail(`refusing ${rel}: it is a link`, "unauthorized");
    throw e;
  }
  try {
    const st = fstatSync(fd);
    assert(st.isFile(), `refusing ${rel}: it is not a plain file`, "unauthorized");
    assert(st.size <= cap, `${rel} is larger than ${cap} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The plain files and plain directories directly in `rel` (links and others left out), or [] when it is not there. */
export function safeList(root, rel) {
  let dir;
  try {
    dir = rel === "." ? root : parentOf(root, rel, false).path;
    assertDir(dir, rel);
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() || e.isDirectory())
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Removes `rel` and everything under it. The walk to it follows no link; rm itself never follows one. */
export function safeRemove(root, rel) {
  let path;
  try {
    path = parentOf(root, rel, false).path;
  } catch (e) {
    if (e?.code === "ENOENT") return;
    throw e;
  }
  rmSync(path, { recursive: true, force: true });
}

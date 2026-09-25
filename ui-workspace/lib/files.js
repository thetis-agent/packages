// One file at a time: the facts about a path, reading and writing text, making and renaming and deleting,
// and counting a tree. Every path goes through `resolveContained` first, so this module never decides
// what is reachable; it only decides what is sensible once the path is known to be. The sizes here are
// set by the gateway: a JSON answer is capped at 256 KiB and a body at 1 MiB, which is why text over
// `INLINE_LIMIT` is fetched raw and text over `WRITE_INLINE_LIMIT` goes through `upload`.
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir as mkdirFs, open, readdir, readFile, realpath, rename as renameFs, rm, stat as statFs, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { mountsFromEnv, resolveContained, writeRefusal } from "@thetis/tools-files/lib/paths.js";
import { SKIP_DIRS } from "@thetis/tools-files/lib/walk.js";
import { contentTypeOf, kindOf as fileKind } from "./language.js";

/** Text at or under this many bytes rides in the JSON answer of `read`; over it the browser fetches raw. */
export const INLINE_LIMIT = 200_000;
/** Text over this many bytes cannot arrive in a JSON body; it goes through `upload`. */
export const WRITE_INLINE_LIMIT = 800_000;
/** A file over this is `tooLarge`: the editor shows a 4 MiB window of it, never the whole. */
export const MAX_TEXT = 4 * 1024 * 1024;
/** The window `part: "head" | "tail"` shows of a tooLarge file. */
export const PART_BYTES = 4 * 1024 * 1024;
/** One upload body, enforced here as well as by the gateway. */
export const MAX_UPLOAD = 64 * 1024 * 1024;
/** Where a count, a delete's dry run and a zip stop. */
export const MAX_ENTRIES = 20_000;
export const MAX_BYTES = 512 * 1024 * 1024;

export function fail(message) {
  throw new Error(message);
}

/** The mount list this fence announced, as tools-files read it. */
const MOUNTS = mountsFromEnv(process.env.THETIS_MOUNTS);

export const etagOf = (st) => `${Math.round(st.mtimeMs)}-${st.size}`;
const mtimeOf = (st) => new Date(st.mtimeMs).toISOString();
const modeOf = (resolved) => (resolved.writable ? "rw" : "ro");

/** `resolveContained` with its message passed on as the person's sentence, unchanged. */
export async function contained(env, path, { write = false } = {}) {
  return resolveContained(env, path, { write });
}

/** A stat that says "does not exist" in a sentence instead of an errno. */
export async function statOrFail(absolute, display) {
  try {
    return await statFs(absolute);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") fail(`${display} does not exist.`);
    throw e;
  }
}

/** A NUL in the first 8 KiB marks a file binary, the rule tools-files applies. */
export async function sniffBinary(absolute) {
  const fh = await open(absolute, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
    return false;
  } finally {
    await fh.close();
  }
}

const kindOfStat = (st) => (st.isDirectory() ? "dir" : st.isFile() ? "file" : "other");

/** The facts about one path: what it is, how big, when, and how the place should show it. */
export async function stat(args, env) {
  const resolved = await contained(env, args.path);
  const { absolute, display, root } = resolved;
  const st = await statOrFail(absolute, display);
  const kind = kindOfStat(st);
  const named = kind === "file" ? fileKind(absolute) : { language: null, preview: "none" };
  const textish = named.preview === "text" || named.preview === "markdown";
  const binary = kind === "file" && textish ? await sniffBinary(absolute) : false;
  return {
    path: absolute,
    display,
    root,
    mode: modeOf(resolved),
    writable: resolved.writable,
    ...(resolved.mount ? { mount: { path: resolved.mount.path, mode: resolved.mount.mode } } : {}),
    kind,
    size: st.size,
    mtime: mtimeOf(st),
    etag: etagOf(st),
    language: binary ? null : named.language,
    preview: binary ? "none" : named.preview,
    tooLarge: kind === "file" && st.size > MAX_TEXT,
    binary,
  };
}

/** A file that `read` and the editor may open as text, or a sentence saying why not. */
async function textFile(env, path) {
  const resolved = await contained(env, path);
  const st = await statOrFail(resolved.absolute, resolved.display);
  if (st.isDirectory()) fail(`${resolved.display} is a directory, not a file; open it in the explorer instead.`);
  if (!st.isFile()) fail(`${resolved.display} is not a regular file and cannot be read as text.`);
  const named = fileKind(resolved.absolute);
  if (named.preview !== "text" && named.preview !== "markdown") fail(`${resolved.display} is not a text file (${named.preview === "none" ? "a binary" : `${named.preview} content`}); download it instead.`);
  if (await sniffBinary(resolved.absolute)) fail(`${resolved.display} looks like a binary file (a NUL byte in the first 8 KiB); download it instead of opening it as text.`);
  return { resolved, st, named };
}

/** The window of a tooLarge file that `part` names: the first or the last `PART_BYTES`. */
export function windowOf(size, part) {
  if (size <= PART_BYTES) return { start: 0, end: size, part: null };
  return part === "tail" ? { start: size - PART_BYTES, end: size, part: "tail" } : { start: 0, end: PART_BYTES, part: "head" };
}

/** The text of a file when it fits in a JSON answer; otherwise the facts, and the browser fetches raw. */
export async function read(args, env) {
  const { resolved, st, named } = await textFile(env, args.path);
  const tooLarge = st.size > MAX_TEXT;
  const window = tooLarge ? windowOf(st.size, args.part) : { part: null };
  const out = { path: resolved.absolute, etag: etagOf(st), size: st.size, mtime: mtimeOf(st), language: named.language, inline: st.size <= INLINE_LIMIT, truncated: tooLarge, part: window.part };
  if (out.inline) out.text = await readFile(resolved.absolute, "utf8");
  return out;
}

/** tmp file beside the target, then rename, so a reader never sees half a file. Keeps the mode of the old file. */
export async function atomicWrite(absolute, content, mode) {
  await mkdirFs(dirname(absolute), { recursive: true });
  const tmp = resolve(dirname(absolute), `.${basename(absolute)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await writeFile(tmp, content, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await chmod(tmp, mode);
    await renameFs(tmp, absolute);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** A write the containment check allowed and the filesystem refused: tools-files' sentence for EROFS, else the error. */
export async function guarded(resolved, fn) {
  try {
    return await fn();
  } catch (e) {
    throw writeRefusal(e, resolved) ?? e;
  }
}

/**
 * Writes text, creating the file when it is new. With an `etag`, the write is refused when the file on disk
 * no longer matches it, and the answer carries what is there now so the editor can show the difference;
 * `force` writes anyway. The text must fit a JSON body: over the limit the browser uploads instead.
 */
export async function write(args, env) {
  if (typeof args.text !== "string") fail("write needs text.");
  const bytes = Buffer.byteLength(args.text, "utf8");
  if (bytes > WRITE_INLINE_LIMIT) fail(`The text is ${bytes} bytes, over the ${WRITE_INLINE_LIMIT}-byte limit of a write; upload the file instead.`);
  const resolved = await contained(env, args.path, { write: true });
  const { absolute, display } = resolved;
  let st = null;
  try {
    st = await statFs(absolute);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (st?.isDirectory()) fail(`${display} is a directory, not a file.`);
  if (st && !st.isFile()) fail(`${display} is not a regular file.`);
  if (st && typeof args.etag === "string" && args.etag !== etagOf(st) && args.force !== true) {
    const current = { etag: etagOf(st), size: st.size, mtime: mtimeOf(st) };
    if (st.size <= INLINE_LIMIT) current.text = await readFile(absolute, "utf8").catch(() => undefined);
    return { ok: false, conflict: true, current };
  }
  await guarded(resolved, () => atomicWrite(absolute, args.text, st ? st.mode & 0o777 : undefined));
  const after = await statFs(absolute);
  // `path` is the absolute path the write landed on: a relative request resolves against home, and the
  // browser opens the file by this name, never by the relative one.
  return { ok: true, path: absolute, etag: etagOf(after), size: after.size, mtime: mtimeOf(after) };
}

/** Makes a directory, and its parents. Refuses when something is already there. */
export async function mkdir(args, env) {
  const resolved = await contained(env, args.path, { write: true });
  const { absolute, display } = resolved;
  const existing = await lstat(absolute).catch(() => null);
  if (existing) fail(`${display} already exists${existing.isDirectory() ? "" : " and is not a directory"}.`);
  await guarded(resolved, () => mkdirFs(absolute, { recursive: true }));
  return { path: absolute };
}

/** One path segment: no separator, not `.` or `..`, no NUL, not empty. */
export function checkName(name, what = "name") {
  if (typeof name !== "string" || !name) fail(`${what} is required.`);
  if (name.includes("/") || name.includes(sep)) fail(`${what} must be a single name, not a path: ${name} contains a slash.`);
  if (name === "." || name === "..") fail(`${what} cannot be ${name}.`);
  if (name.includes("\u0000")) fail(`${what} contains a NUL byte and is refused.`);
  if (name.length > 255) fail(`${what} is over 255 characters.`);
  return name;
}

/** The real paths of every root (home, shared, each mount), so a root itself is never renamed or deleted. */
async function rootPaths(env) {
  const out = [];
  for (const p of [env.cwd, env.shared, ...MOUNTS.map((m) => m.path)]) {
    if (!p) continue;
    const real = await realpath(p).catch(() => null);
    if (real) out.push(real);
  }
  return out;
}

/** Renames within the same directory. The new name must be free. */
export async function rename(args, env) {
  const resolved = await contained(env, args.path, { write: true });
  const name = checkName(args.name, "The new name");
  const { absolute, display } = resolved;
  if ((await rootPaths(env)).includes(absolute)) fail(`${display} is a root of your workspace and cannot be renamed.`);
  if (!(await lstat(absolute).catch(() => null))) fail(`${display} does not exist.`);
  const target = join(dirname(absolute), name);
  if (target === absolute) return { path: absolute };
  const targetResolved = await contained(env, target, { write: true });
  if (await lstat(targetResolved.absolute).catch(() => null)) fail(`${name} already exists in ${dirname(absolute)}; pick another name.`);
  await guarded(resolved, () => renameFs(absolute, targetResolved.absolute));
  return { path: targetResolved.absolute };
}

/**
 * Walks a tree without following symlinks, tallying files, directories and bytes, stopping at the caps.
 * `skip` names directories left out of the tally (their subtree still counts toward `skipped`), and
 * `onGit` is told the first `.git` met, so a delete can refuse before it starts. Entries in `skip`
 * directories are not descended.
 */
export async function countTree(absolute, { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES, skip = new Set(), onGit = null } = {}) {
  const tally = { files: 0, dirs: 0, bytes: 0, capped: false, skipped: { files: 0, dirs: 0, bytes: 0 }, git: null };
  const st = await lstat(absolute);
  if (!st.isDirectory()) {
    tally.files = 1;
    tally.bytes = st.size;
    return tally;
  }
  const stack = [absolute];
  let entries = 0;
  while (stack.length) {
    const dir = stack.pop();
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of list) {
      const full = join(dir, ent.name);
      if (ent.name === ".git" && !tally.git) {
        tally.git = full;
        if (onGit) onGit(full);
      }
      if (++entries > maxEntries || tally.bytes >= maxBytes) {
        tally.capped = true;
        return tally;
      }
      if (ent.isDirectory()) {
        if (skip.has(ent.name)) {
          const sub = await countTree(full, { maxEntries: maxEntries - entries, maxBytes, skip });
          tally.skipped.dirs += sub.dirs + 1;
          tally.skipped.files += sub.files;
          tally.skipped.bytes += sub.bytes;
          entries += sub.dirs + sub.files;
          if (sub.capped) {
            tally.capped = true;
            return tally;
          }
          continue;
        }
        tally.dirs++;
        stack.push(full);
      } else {
        tally.files++;
        if (ent.isFile()) {
          const s = await lstat(full).catch(() => null);
          if (s) tally.bytes += s.size;
        }
      }
    }
  }
  return tally;
}

/** The files, directories and bytes under a path, with what a zip would leave out, stopping at the caps. */
export async function count(args, env) {
  const { absolute, display } = await contained(env, args.path);
  await statOrFail(absolute, display);
  const t = await countTree(absolute, { skip: new Set([".git", "node_modules"]) });
  const files = t.files + t.skipped.files;
  const dirs = t.dirs + t.skipped.dirs;
  const bytes = t.bytes + t.skipped.bytes;
  return { files, dirs, bytes, capped: t.capped, zip: { files: t.files, dirs: t.dirs, bytes: t.bytes }, skipped: t.skipped };
}

/**
 * Deletes a file or a whole tree. A root, and anything with `.git` inside it, is refused whole, in
 * tools-files' words; `dryRun` counts what would go instead. The count is what the person is told was
 * removed, because once `rm` has run there is nothing left to count.
 */
export async function del(args, env) {
  const resolved = await contained(env, args.path, { write: true });
  const { absolute, display } = resolved;
  const roots = await rootPaths(env);
  if (roots.includes(absolute)) fail(`${display} is a root of your workspace (home, shared, or a mount) and cannot be deleted; delete what is inside it instead.`);
  const st = await lstat(absolute).catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  if (!st) fail(`${display} does not exist.`);
  const t = await countTree(absolute);
  // The path itself was checked by resolveContained; this is the tree under it, in the same words.
  if (t.git) fail(`${t.git} names a .git path, which is protected from write and delete.`);
  if (args.dryRun) return { files: t.files, dirs: t.dirs, bytes: t.bytes, capped: t.capped };
  if (t.capped) fail(`${display} holds more than ${MAX_ENTRIES} entries or ${MAX_BYTES} bytes (the count stopped at ${t.files} files and ${t.dirs} directories); delete its parts one at a time.`);
  await guarded(resolved, () => rm(absolute, { recursive: true, force: false }));
  return { removed: { files: t.files, dirs: t.dirs } };
}

// ---- raw routes ----

/** RFC 6266 / 5987: an ASCII fallback plus the UTF-8 form, so a name in any script survives the download. */
export function dispositionOf(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

const INLINE_PREVIEWS = new Set(["image", "svg", "pdf", "audio", "text", "markdown"]);

/**
 * The file itself: `{ status, headers, body }` for the gateway's raw seam. Previews are served inline;
 * anything else, or `download: true`, as an attachment. SVG and HTML are text/plain unless downloaded,
 * because the page shows them in its own frame and must not run their scripts. `part` windows a tooLarge
 * text file the way `read` describes.
 */
export async function raw(args, env) {
  const resolved = await contained(env, args.path);
  const { absolute, display } = resolved;
  const st = await statOrFail(absolute, display);
  if (st.isDirectory()) fail(`${display} is a directory; download it as a zip instead.`);
  if (!st.isFile()) fail(`${display} is not a regular file.`);
  const name = basename(absolute);
  const named = fileKind(name);
  const download = args.download === true || args.download === "true" || args.download === "1";
  const textish = named.preview === "text" || named.preview === "markdown";
  const binary = textish && (await sniffBinary(absolute));
  let type = binary ? "application/octet-stream" : contentTypeOf(name);
  if (!download && (named.type === "image/svg+xml" || named.type === "text/html")) type = "text/plain; charset=utf-8";
  const inline = !download && !binary && INLINE_PREVIEWS.has(named.preview);
  const window = textish && !binary && st.size > MAX_TEXT ? windowOf(st.size, args.part) : { start: 0, end: st.size, part: null };
  const headers = {
    "content-type": type,
    "content-length": String(window.end - window.start),
    "content-disposition": dispositionOf(inline ? "inline" : "attachment", name),
    etag: etagOf(st),
    "cache-control": "no-store",
  };
  // `end` is inclusive; an empty file reads as nothing either way.
  const body = createReadStream(absolute, { start: window.start, end: Math.max(window.start, window.end - 1) });
  return { status: 200, headers, body };
}

/**
 * Puts one uploaded body in a directory under a single-segment name. A name already in use answers
 * `{ exists: true }` unless `replace` is set, so the browser asks before overwriting. Atomic, like `write`.
 */
export async function upload(args, env, { body } = {}) {
  const dir = await contained(env, args.dir, { write: true });
  const name = checkName(args.name, "The file name");
  if (!(body instanceof Uint8Array)) fail("upload needs the file's bytes as its body.");
  if (body.length > MAX_UPLOAD) fail(`${name} is ${body.length} bytes, over the ${MAX_UPLOAD}-byte upload limit.`);
  const dst = await statOrFail(dir.absolute, dir.display);
  if (!dst.isDirectory()) fail(`${dir.display} is not a directory.`);
  const target = await contained(env, join(dir.absolute, name), { write: true });
  const existing = await lstat(target.absolute).catch(() => null);
  if (existing?.isDirectory()) fail(`${name} is a directory in ${dir.display}; pick another name.`);
  if (existing && args.replace !== true) return { exists: true, path: target.absolute };
  await guarded(target, () => atomicWrite(target.absolute, body, existing ? existing.mode & 0o777 : undefined));
  const st = await statFs(target.absolute);
  return { path: target.absolute, size: st.size, etag: etagOf(st), replaced: Boolean(existing) };
}

export { SKIP_DIRS };

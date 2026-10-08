// The files of one sheet, all under `sheets/<id>/` in the person's home: `sheet.json` is the workbook (the
// tabs, their cells and styles, the revision and the last forty changes) and `.lock/` is a directory that
// exists while one writer holds the sheet. Plain files, so the tools in the fence and the commands in the
// gateway read and write the same thing, the Files place shows them, and a person can read one by hand.
//
// Every read-modify-write goes through `mutate`, which takes the lock, reads the workbook fresh, lets the
// caller change it, checks it, bumps the revision, records who changed which ranges, and writes it as a
// temporary dot-file renamed into place, so a reader (the watcher, a `get`) never sees half a file. The
// lock is what lets the agent and the person write the same sheet at the same moment without one losing
// the other's cells: the second writer waits and applies its change on top of the first.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { boundingBox, parseRange, rangeText } from "../ui/core/address.js";
import { cellCount, checkWorkbook, completeWorkbook, isSheetId, LIMITS } from "../ui/core/workbook.js";

export const DIR = "sheets";
export { isSheetId, LIMITS };
export const MAX_SHEETS = LIMITS.sheets;
export const MAX_BYTES = LIMITS.fileBytes;
const MAX_CHANGES = LIMITS.changes;
const MAX_RANGES = LIMITS.changeRanges;

const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

export const newId = () => `sh_${randomBytes(4).toString("hex")}`;

export const fail = (message) => {
  throw new Error(message);
};

// ---- paths ----

export function sheetDir(env, id) {
  if (!isSheetId(id)) fail(`${JSON.stringify(id)} is not a sheet id; one looks like sh_1a2b3c4d.`);
  return resolve(env.cwd, DIR, id);
}

export const sheetPath = (env, id) => resolve(sheetDir(env, id), "sheet.json");
const lockPath = (env, id) => resolve(sheetDir(env, id), ".lock");

// ---- writes ----

/** A temporary file beside the target, then a rename, so nothing ever reads half a file. */
export async function atomicWrite(absolute, content, { parents = true } = {}) {
  if (parents) await mkdir(dirname(absolute), { recursive: true });
  const tmp = resolve(dirname(absolute), `.${basename(absolute)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await writeFile(tmp, content);
    await rename(tmp, absolute);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

const serialize = (workbook) => {
  const text = JSON.stringify(workbook, null, 2) + "\n";
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_BYTES) fail(`The sheet would be ${Math.round(bytes / 1024 / 1024)} MB; at most ${Math.round(MAX_BYTES / 1024 / 1024)} MB. Move some tabs to a sheet of their own, or clear what is not needed.`);
  return text;
};

// ---- the lock ----

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Runs `fn` while holding the sheet's lock: `mkdir sheets/<id>/.lock`, which only one process can win. A
 * lock already there is waited for in 20 ms steps for up to five seconds, and taken over when it is older
 * than ten (its holder died). The sheet's directory must exist; a sheet removed while waiting is refused.
 */
export async function withLock(env, id, fn) {
  const lock = lockPath(env, id);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e?.code === "ENOENT") fail(`No sheet ${id}.`);
      if (e?.code !== "EEXIST") throw e;
    }
    const held = await stat(lock).catch(() => null);
    if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
      // Moved aside before removal, so a second waiter that saw the same stale lock cannot remove a fresh one.
      const aside = `${lock}-stale-${randomBytes(4).toString("hex")}`;
      if (await rename(lock, aside).then(() => true, () => false)) await rm(aside, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started >= LOCK_WAIT_MS) fail("The sheet is busy; try again.");
    await pause(LOCK_RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

// ---- the workbook ----

/** The workbook of one sheet, completed, or null: no such directory, a file that does not parse, or an id that disagrees. */
export async function readSheet(env, id) {
  if (!isSheetId(id)) return null;
  let text;
  try {
    text = await readFile(sheetPath(env, id), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  return record && typeof record === "object" && record.id === id ? completeWorkbook(record) : null;
}

/** A range as the change log keeps it: a tab id and an A1 range text. */
function rangeEntry(entry) {
  const tab = String(entry?.tab ?? "");
  const range = typeof entry?.range === "string" ? parseRange(entry.range) : entry?.range;
  if (!tab || !range || !Number.isInteger(range.r1)) return null;
  return { tab, range };
}

/** At most twenty ranges per change: beyond that, one bounding box per tab. */
export function capRanges(ranges) {
  const entries = (Array.isArray(ranges) ? ranges : []).map(rangeEntry).filter(Boolean);
  if (entries.length <= MAX_RANGES) return entries.map((e) => ({ tab: e.tab, range: rangeText(e.range) }));
  const byTab = new Map();
  for (const e of entries) byTab.set(e.tab, [...(byTab.get(e.tab) ?? []), e.range]);
  return [...byTab].slice(0, MAX_RANGES).map(([tab, list]) => ({ tab, range: rangeText(boundingBox(list)) }));
}

/** One Change, for the log the person and the agent read each other's edits from. */
export function changeEntry({ rev, by, session, ranges, what, at = new Date().toISOString() }) {
  return { rev, by: by === "person" ? "person" : "agent", ...(typeof session === "string" && session ? { session } : {}), at, ranges: capRanges(ranges), what: String(what || "changed the sheet").slice(0, 200) };
}

const appendChange = (changes, change) => [...(Array.isArray(changes) ? changes : []), change].slice(-MAX_CHANGES);

/**
 * A new sheet, written at revision 1 with its first Change. The id is fresh, so nothing else can be
 * writing it; the directory is made here and nowhere else, so a write never brings a deleted sheet back.
 */
export async function createSheet(env, workbook, { by, session, ranges = [], what = "created the sheet" } = {}) {
  const now = new Date().toISOString();
  const first = completeWorkbook({ ...workbook, rev: 1, createdAt: workbook.createdAt ?? now, updatedAt: now, changes: [] });
  const next = { ...first, changes: [changeEntry({ rev: 1, by, session, ranges, what, at: now })] };
  checkWorkbook(next);
  const text = serialize(next);
  await mkdir(sheetDir(env, next.id), { recursive: true });
  await atomicWrite(sheetPath(env, next.id), text, { parents: false });
  return next;
}

/**
 * The one way to change a sheet that exists: under the lock, read it fresh, call `fn(workbook)` for
 * `{ workbook, ranges, what }`, check the result, bump the revision, append the Change by `by`
 * ("agent" | "person") and `session`, write, and answer what was written. `fn` may throw a sentence;
 * nothing is written then.
 */
export async function mutate(env, id, fn, { by = "agent", session } = {}) {
  sheetDir(env, id);
  return withLock(env, id, async () => {
    const current = await readSheet(env, id);
    if (!current) fail(`No sheet ${id}.`);
    const result = await fn(current);
    if (!result?.workbook) fail("Nothing changed.");
    const now = new Date().toISOString();
    const rev = current.rev + 1;
    const next = {
      ...result.workbook,
      id: current.id,
      createdAt: current.createdAt,
      rev,
      updatedAt: now,
      changes: appendChange(current.changes, changeEntry({ rev, by, session, ranges: result.ranges, what: result.what, at: now })),
    };
    checkWorkbook(next);
    await atomicWrite(sheetPath(env, id), serialize(next), { parents: false });
    return next;
  });
}

/** Every sheet, newest change first. Directories that are not `sh_<8 hex>` with a readable workbook are ignored. */
export async function listSheets(env) {
  let names;
  try {
    names = await readdir(resolve(env.cwd, DIR));
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const records = await Promise.all(names.filter(isSheetId).map((id) => readSheet(env, id).catch(() => null)));
  return records.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** Removes a sheet's directory, under its lock, so a writer that was waiting finds no sheet rather than bringing it back. */
export async function removeSheet(env, id) {
  const dir = sheetDir(env, id);
  try {
    await withLock(env, id, () => rm(dir, { recursive: true, force: true }));
  } catch (e) {
    if (!/^No sheet /.test(e?.message ?? "")) throw e;
  }
}

/** How many non-empty cells a workbook holds. */
export const cellsOf = cellCount;

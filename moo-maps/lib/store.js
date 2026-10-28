// The files of one map, all under `maps/<id>/` in the person's home:
//
//   map.json    the record: { id, rev, createdAt, updatedAt, doc, link, changes }
//   focus.json  what the person has selected in the tab, so the agent can be told "this room"
//   .lock/      a directory that exists while one writer holds the map
//
// `doc` is the mudmap document (ui/core/doc.js). `link` is what ties it to the MOO:
//
//   { areas: { a1: "#0A52…" }, rooms: { r3: "#0A52…" }, exits: { e9: "#…" }, edges: { j4: "#…" },
//     published: <the doc as it was last published or pulled, or null>,
//     publishedRev, publishedAt, character, external: [ exits from linked rooms to rooms off the map ] }
//
// Plain files, so the tools in the fence and the commands in the gateway (which do not share
// `env.storage()`) read and write the same thing, and a person can read one by hand. Every
// read-modify-write goes through `mutate`, under the lock, written as a temporary file renamed into place.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { checkDoc, completeDoc, countsOf, diffDocs, isEmptyPatch } from "../ui/core/doc.js";

export const DIR = "maps";
const MAX_MAPS = 500;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_CHANGES = 40;
const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 8_000;
const LOCK_STALE_MS = 15_000;

export const isMapId = (v) => typeof v === "string" && /^m_[0-9a-f]{8}$/.test(v);
export const newId = () => `m_${randomBytes(4).toString("hex")}`;
export const fail = (message) => {
  throw new Error(message);
};

export function mapDir(env, id) {
  if (!isMapId(id)) fail(`${JSON.stringify(id)} is not a map id; one looks like m_1a2b3c4d. map_list names them.`);
  return resolve(env.cwd, DIR, id);
}
export const mapPath = (env, id) => resolve(mapDir(env, id), "map.json");
export const focusPath = (env, id) => resolve(mapDir(env, id), "focus.json");
const lockPath = (env, id) => resolve(mapDir(env, id), ".lock");

export async function atomicWrite(absolute, content) {
  await mkdir(dirname(absolute), { recursive: true });
  const tmp = resolve(dirname(absolute), `.${basename(absolute)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await writeFile(tmp, content);
    await rename(tmp, absolute);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function withLock(env, id, fn) {
  const lock = lockPath(env, id);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e?.code === "ENOENT") fail(`No map ${id}.`);
      if (e?.code !== "EEXIST") throw e;
    }
    const held = await stat(lock).catch(() => null);
    if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
      const aside = `${lock}-stale-${randomBytes(4).toString("hex")}`;
      if (await rename(lock, aside).then(() => true, () => false)) await rm(aside, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started >= LOCK_WAIT_MS) fail("The map is busy (another write holds it); try again.");
    await pause(LOCK_RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

export function emptyLink() {
  return { areas: {}, rooms: {}, exits: {}, edges: {}, elevators: {}, published: null, publishedRev: 0, publishedAt: null, character: null, external: [] };
}

function completeLink(l) {
  const src = l && typeof l === "object" ? l : {};
  const ids = (m) => Object.fromEntries(Object.entries(m && typeof m === "object" ? m : {}).filter(([k, v]) => typeof k === "string" && typeof v === "string" && /^#/.test(v)));
  return {
    areas: ids(src.areas), rooms: ids(src.rooms), exits: ids(src.exits), edges: ids(src.edges), elevators: ids(src.elevators),
    published: src.published ? completeDoc(src.published) : null,
    publishedRev: Number.isInteger(src.publishedRev) ? src.publishedRev : 0,
    publishedAt: typeof src.publishedAt === "string" ? src.publishedAt : null,
    character: typeof src.character === "string" ? src.character : null,
    external: Array.isArray(src.external) ? src.external.slice(0, 2000) : [],
  };
}

export function completeRecord(r) {
  return {
    id: r.id,
    project: typeof r.project === "string" && r.project ? r.project : null,
    rev: Number.isInteger(r.rev) ? r.rev : 1,
    createdAt: r.createdAt ?? new Date().toISOString(),
    updatedAt: r.updatedAt ?? new Date().toISOString(),
    doc: completeDoc(r.doc),
    link: completeLink(r.link),
    changes: Array.isArray(r.changes) ? r.changes.slice(-MAX_CHANGES) : [],
  };
}

export async function readMap(env, id) {
  if (!isMapId(id)) return null;
  let text;
  try {
    text = await readFile(mapPath(env, id), "utf8");
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
  return record && typeof record === "object" && record.id === id ? completeRecord(record) : null;
}

/** A map that must exist, or a sentence. */
export async function needMap(env, id) {
  mapDir(env, id);
  const m = await readMap(env, id);
  if (!m) fail(`No map ${id}. map_list names the maps there are.`);
  return m;
}

function serialize(record) {
  const text = JSON.stringify(record, null, 1) + "\n";
  if (Buffer.byteLength(text) > MAX_BYTES) fail(`The map would be over ${MAX_BYTES / 1024 / 1024} MB. Split it into two maps.`);
  return text;
}

function changeEntry({ rev, by, session, what, at }) {
  return { rev, by: by === "person" ? "person" : "agent", ...(typeof session === "string" && session ? { session } : {}), at, what: String(what || "changed the map").slice(0, 240) };
}

export async function createMap(env, { doc, link, project = null, by = "agent", session, what = "created the map" }) {
  let names = [];
  try {
    names = (await readdir(resolve(env.cwd, DIR))).filter(isMapId);
  } catch {
    /* none yet */
  }
  if (names.length >= MAX_MAPS) fail(`There are ${names.length} maps; at most ${MAX_MAPS}. Delete some with map_delete.`);
  const id = newId();
  const now = new Date().toISOString();
  const record = completeRecord({ id, project, rev: 1, createdAt: now, updatedAt: now, doc, link: link ?? emptyLink(), changes: [] });
  const problems = checkDoc(record.doc);
  if (problems.length) fail(`The map is not consistent: ${problems.slice(0, 5).join(" ")}`);
  record.changes = [changeEntry({ rev: 1, by, session, what, at: now })];
  await mkdir(mapDir(env, id), { recursive: true });
  await atomicWrite(mapPath(env, id), serialize(record));
  return record;
}

/**
 * The one way to change a map that exists: under the lock, read it fresh, `fn(record)` answers
 * `{ doc?, link?, what }` (or throws a sentence, and nothing is written), the document is checked, the
 * revision bumped, the change logged. A result with neither a changed doc nor a link writes nothing and
 * answers the record as it was, with `unchanged: true`.
 */
export async function mutate(env, id, fn, { by = "agent", session } = {}) {
  mapDir(env, id);
  return withLock(env, id, async () => {
    const current = await readMap(env, id);
    if (!current) fail(`No map ${id}.`);
    const result = await fn(current);
    const doc = result?.doc ? completeDoc({ ...result.doc, nextId: Math.max(result.doc.nextId ?? 1, current.doc.nextId) }) : current.doc;
    const docChanged = Boolean(result?.doc) && !isEmptyPatch(diffDocs(current.doc, doc));
    if (!docChanged && !result?.link) return { ...current, unchanged: true };
    const problems = checkDoc(doc);
    if (problems.length) fail(`That would leave the map inconsistent, so nothing was written: ${problems.slice(0, 5).join(" ")}`);
    const now = new Date().toISOString();
    const rev = current.rev + 1;
    const next = {
      ...current,
      rev,
      updatedAt: now,
      doc,
      link: result.link ? completeLink(result.link) : current.link,
      changes: [...current.changes, changeEntry({ rev, by, session, what: result.what, at: now })].slice(-MAX_CHANGES),
    };
    await atomicWrite(mapPath(env, id), serialize(next));
    return next;
  });
}

export async function listMaps(env) {
  let names;
  try {
    names = await readdir(resolve(env.cwd, DIR));
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const records = await Promise.all(names.filter(isMapId).map((id) => readMap(env, id).catch(() => null)));
  return records.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export async function removeMap(env, id) {
  const dir = mapDir(env, id);
  try {
    await withLock(env, id, () => rm(dir, { recursive: true, force: true }));
  } catch (e) {
    if (!/^No map /.test(e?.message ?? "")) throw e;
  }
}

/** Whether the doc differs from what was last published, and how. */
export function publishState(record) {
  const { link, doc } = record;
  const linkedAreas = Object.keys(link.areas).length;
  if (!link.published) {
    return linkedAreas
      ? { state: "linked", pending: null, label: "linked to the world, never published from here" }
      : { state: "draft", pending: null, label: "draft: nothing in the world yet; map_publish makes it" };
  }
  const p = diffDocs(link.published, doc, { ignore: ["color", "notes"] });
  const n = (c) => (p[c] ? p[c].add.length + p[c].put.length + p[c].del.length : 0);
  const pending = { areas: n("areas"), rooms: n("rooms"), exits: n("exits"), edges: n("edges"), elevators: n("elevators"), blocks: p.blocks ? p.blocks.add.length + p.blocks.del.length : 0, name: p.name !== undefined };
  const any = pending.areas + pending.rooms + pending.exits + pending.edges + pending.elevators + pending.blocks > 0;
  const parts = ["areas", "rooms", "exits", "edges", "elevators", "blocks"].filter((k) => pending[k]).map((k) => `${pending[k]} ${pending[k] === 1 ? k.slice(0, -1) : k}`);
  const when = link.publishedAt ? ` (last synced ${link.publishedAt.slice(0, 16).replace("T", " ")} UTC, rev ${link.publishedRev})` : "";
  return { state: any ? "changed" : "published", pending, label: any ? `changed since publish: ${parts.join(", ")}${when}` : `published, in step with the world as last seen${when}` };
}

/** One row for a list. */
export function summary(record) {
  const ps = publishState(record);
  const last = record.changes[record.changes.length - 1];
  return {
    id: record.id, title: record.doc.name, project: record.project, rev: record.rev, updatedAt: record.updatedAt,
    ...countsOf(record.doc), state: ps.state, pending: ps.pending, publishedAt: record.link.publishedAt,
    by: last?.by ?? null, ...(last?.session ? { session: last.session } : {}),
  };
}

export async function readFocus(env, id) {
  try {
    const f = JSON.parse(await readFile(focusPath(env, id), "utf8"));
    return f && typeof f === "object" ? f : null;
  } catch {
    return null;
  }
}

export async function writeFocus(env, id, focus) {
  await atomicWrite(focusPath(env, id), JSON.stringify({ ...focus, at: new Date().toISOString() }) + "\n");
}

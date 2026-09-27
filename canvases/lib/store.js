// The files of one canvas, all under `canvases/<id>/` in the person's home: `canvas.json` is the index
// (the title, the pages, every artboard's frame, the notes, the order), `<Board>.html` one artboard each,
// and `assets/<name>` the pictures and fonts they reference by relative path. Plain files, so the tools in
// the fence and the commands in the gateway read and write the same thing, the Files place shows them, and
// a person can edit one by hand. Every write is a temporary file renamed into place, so a reader (the
// watcher, the frame) never sees half a file; the temporary names start with a dot, which the watcher
// skips. Every path is resolved under the canvas's own directory and checked to be inside it.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { checkIndex, completeIndex, isBoardName, KEY, PROP } from "./schema.js";

export const DIR = "canvases";
export const LIMITS = Object.freeze({
  canvases: 256, title: 120, boards: 64, notes: 256, pages: 16, props: 32,
  html: 512 * 1024, asset: 16 * 1024 * 1024, canvas: 128 * 1024 * 1024,
  text: 4096, name: 80, coord: 1_000_000, sizeMin: 16, sizeMax: 16384, radius: 512,
});

const ID = /^c_[0-9a-f]{8}$/;
export const isCanvasId = (id) => typeof id === "string" && ID.test(id);
export const newId = () => `c_${randomBytes(4).toString("hex")}`;

const ASSET = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\.(png|jpe?g|gif|webp|svg|css|js|json|woff2?|ttf|otf|mp4|webm|mp3)$/i;
export { KEY, PROP, isBoardName };
export const isAssetName = (name) => typeof name === "string" && ASSET.test(name) && !name.includes("..");

/** The media type an asset is served as, by its extension. */
const TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
};
export const typeOf = (name) => TYPES[String(name).split(".").pop().toLowerCase()] ?? "application/octet-stream";

export const fail = (message) => {
  throw new Error(message);
};

// ---- paths ----

export function canvasDir(env, id) {
  if (!isCanvasId(id)) fail(`${JSON.stringify(id)} is not a canvas id; one looks like c_1a2b3c4d.`);
  return resolve(env.cwd, DIR, id);
}

/** A file under the canvas's directory, refused if the pieces resolve outside it. */
function fileIn(env, id, ...rel) {
  const dir = canvasDir(env, id);
  const absolute = resolve(dir, ...rel);
  if (!absolute.startsWith(dir + sep)) fail("That path leaves the canvas.");
  return absolute;
}

export const indexPath = (env, id) => fileIn(env, id, "canvas.json");
export function boardPath(env, id, file) {
  if (!isBoardName(file)) fail(`${JSON.stringify(file)} is not an artboard file name: letters, digits, _ . and -, ending in .html, like Main.html.`);
  return fileIn(env, id, file);
}
export function assetPath(env, id, name) {
  if (!isAssetName(name)) fail(`${JSON.stringify(name)} is not an asset name: letters, digits, _ . and -, with one of the extensions png jpg jpeg gif webp svg css js json woff woff2 ttf otf mp4 webm mp3.`);
  return fileIn(env, id, "assets", name);
}

// ---- writes ----

/** A temporary file beside the target, then a rename, so nothing ever reads half a file. */
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

// ---- the index ----

/** The index of one canvas, completed, or null: no such directory, a file that does not parse, or an id that disagrees. */
export async function readIndex(env, id) {
  if (!isCanvasId(id)) return null;
  let text;
  try {
    text = await readFile(indexPath(env, id), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  return record && typeof record === "object" && record.id === id ? completeIndex(record) : null;
}

/** Checks and writes an index, one revision up and touched now. Answers what was written. */
export async function writeIndex(env, index) {
  const next = completeIndex({ ...index, rev: (Number.isInteger(index.rev) ? index.rev : 0) + 1, updatedAt: new Date().toISOString() });
  checkIndex(next);
  await atomicWrite(indexPath(env, next.id), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** Every canvas, newest change first. Directories that are not `c_<8 hex>` with a readable index are ignored. */
export async function listCanvases(env) {
  let names;
  try {
    names = await readdir(resolve(env.cwd, DIR));
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const records = await Promise.all(names.filter(isCanvasId).map((id) => readIndex(env, id)));
  return records.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export async function removeCanvas(env, id) {
  await rm(canvasDir(env, id), { recursive: true, force: true });
}

// ---- the files beside it ----

/** For each artboard the index names: its file's modification time and size, or `missing` when the file is not there. */
export async function boardFiles(env, index) {
  const out = {};
  for (const file of Object.keys(index.boards)) {
    try {
      const st = await stat(boardPath(env, index.id, file));
      out[file] = { mtime: Math.round(st.mtimeMs), size: st.size };
    } catch {
      out[file] = { missing: true };
    }
  }
  return out;
}

/** The assets under the canvas, by name. */
export async function assetList(env, id) {
  let names;
  try {
    names = await readdir(resolve(canvasDir(env, id), "assets"));
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const name of names.filter(isAssetName).sort()) {
    try {
      const st = await stat(assetPath(env, id, name));
      if (st.isFile()) out.push({ name, size: st.size });
    } catch {
      /* gone between the listing and the stat */
    }
  }
  return out;
}

/** The bytes a canvas holds on disk, for the cap on assets. */
export async function canvasBytes(env, id) {
  const dir = canvasDir(env, id);
  let total = 0;
  const walk = async (at) => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = resolve(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

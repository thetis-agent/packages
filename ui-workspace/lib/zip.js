// A real zip, written file by file into a stream: each entry's bytes are deflated into a Buffer first, so
// its local header carries the true sizes and CRC and no data descriptor is needed (the readers that
// choke on descriptors are the ones people have). The central directory comes last, as the format says.
// No zip64: the caps (20 000 entries, 512 MiB) keep every field inside 32 bits and every count under
// 65 535, and the caps are checked before the first byte goes out, because once a stream has started
// there is no way left to say no.
//
// `.git` and `node_modules` are left out, symlinks are not followed, and empty directories are kept as
// directory entries, so what unpacks is what a person would expect to see in the explorer.
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { Readable } from "node:stream";
import { crc32, deflateRawSync } from "node:zlib";
import { countTree, MAX_BYTES, MAX_ENTRIES } from "./files.js";

export const ZIP_SKIP = new Set([".git", "node_modules"]);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const VERSION = 20;
const FLAG_UTF8 = 0x0800;
const STORE = 0;
const DEFLATE = 8;

/** MS-DOS time and date, which is what a zip header holds; anything before 1980 becomes 1980. */
export function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** The entries of a tree in a stable order: directories and files under `root`, names relative and posix. */
export async function* walkEntries(root, prefix, skip = ZIP_SKIP) {
  let list;
  try {
    list = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of list) {
    if (ent.isSymbolicLink()) continue;
    const full = join(root, ent.name);
    const name = posix.join(prefix, ent.name);
    if (ent.isDirectory()) {
      if (skip.has(ent.name)) continue;
      yield { kind: "dir", full, name: `${name}/` };
      yield* walkEntries(full, name, skip);
    } else if (ent.isFile()) {
      yield { kind: "file", full, name };
    }
  }
}

function localHeader(e) {
  const name = Buffer.from(e.name, "utf8");
  const h = Buffer.alloc(30 + name.length);
  h.writeUInt32LE(SIG_LOCAL, 0);
  h.writeUInt16LE(VERSION, 4);
  h.writeUInt16LE(FLAG_UTF8, 6);
  h.writeUInt16LE(e.method, 8);
  h.writeUInt16LE(e.time, 10);
  h.writeUInt16LE(e.date, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(e.csize, 18);
  h.writeUInt32LE(e.usize, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  name.copy(h, 30);
  return h;
}

function centralHeader(e) {
  const name = Buffer.from(e.name, "utf8");
  const h = Buffer.alloc(46 + name.length);
  h.writeUInt32LE(SIG_CENTRAL, 0);
  h.writeUInt16LE((3 << 8) | VERSION, 4); // made on unix, so the external attributes are read as a mode
  h.writeUInt16LE(VERSION, 6);
  h.writeUInt16LE(FLAG_UTF8, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(e.time, 12);
  h.writeUInt16LE(e.date, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.csize, 20);
  h.writeUInt32LE(e.usize, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(0, 30);
  h.writeUInt16LE(0, 32);
  h.writeUInt16LE(0, 34);
  h.writeUInt16LE(0, 36);
  h.writeUInt32LE(e.external >>> 0, 38);
  h.writeUInt32LE(e.offset, 42);
  name.copy(h, 46);
  return h;
}

function endRecord(count, cdSize, cdOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(SIG_END, 0);
  h.writeUInt16LE(0, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  h.writeUInt16LE(0, 20);
  return h;
}

/** The bytes of a zip, one Buffer at a time. `entries` is an async iterable of `{ kind, full, name }`. */
export async function* zipChunks(entries) {
  const central = [];
  let offset = 0;
  for await (const ent of entries) {
    const st = await lstat(ent.full).catch(() => null);
    if (!st) continue;
    const { time, date } = dosTime(st.mtimeMs);
    let record;
    let data = Buffer.alloc(0);
    if (ent.kind === "dir") {
      record = { name: ent.name, method: STORE, time, date, crc: 0, csize: 0, usize: 0, external: (0o40755 << 16) | 0x10, offset };
    } else {
      const raw = await readFile(ent.full);
      const deflated = deflateRawSync(raw);
      const stored = deflated.length >= raw.length;
      data = stored ? raw : deflated;
      record = { name: ent.name, method: stored ? STORE : DEFLATE, time, date, crc: crc32(raw) >>> 0, csize: data.length, usize: raw.length, external: ((st.mode & 0o777) | 0o100000) << 16, offset };
    }
    const header = localHeader(record);
    yield header;
    if (data.length) yield data;
    offset += header.length + data.length;
    central.push(record);
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const record of central) {
    const h = centralHeader(record);
    cdSize += h.length;
    yield h;
  }
  yield endRecord(central.length, cdSize, cdOffset);
}

/**
 * A stream of the zip of `absolute` (a directory, or one file), refusing before the first byte when the
 * tree is over the caps. `caps` is for tests; the defaults are the module's.
 */
export async function zipStream(absolute, { display = absolute, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  const st = await lstat(absolute);
  const t = await countTree(absolute, { maxEntries, maxBytes, skip: ZIP_SKIP });
  if (t.capped || t.files + t.dirs > maxEntries || t.bytes > maxBytes) {
    throw new Error(`${display} is over what one zip may hold (${maxEntries} entries or ${maxBytes} bytes; the count stopped at ${t.files} files, ${t.dirs} directories and ${t.bytes} bytes); download its folders one at a time.`);
  }
  const entries = st.isDirectory() ? walkEntries(absolute, basename(absolute) || "root") : (async function* one() {
    yield { kind: "file", full: absolute, name: basename(absolute) };
  })();
  return Readable.from(zipChunks(entries));
}

/**
 * Reads a zip's central directory from a Buffer: `[{ name, method, crc, csize, usize, offset }]`. For
 * tests and for anyone without `unzip`; it is not used by the writer.
 */
export function readCentralDirectory(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`bad central header at ${p}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({ name: buf.toString("utf8", p + 46, p + 46 + nameLen), method: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

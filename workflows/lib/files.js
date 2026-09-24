// The package's files, all under `workflows/` in the person's home. Every write is a whole file written
// beside its destination and renamed over it, so a reader — this service after a restart, or a person
// looking — never sees half a record. A missing file reads as the fallback: an empty home is normal.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

export const DIR = "workflows";

const at = (home, rel) => resolve(home, rel);

/** Parsed JSON, or `fallback` when the file is missing or does not parse. */
export async function readJson(home, rel, fallback = null) {
  let text;
  try {
    text = await readFile(at(home, rel), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Writes `value` as JSON through a temporary file and a rename. */
export async function writeJson(home, rel, value) {
  const file = at(home, rel);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** The names in a directory, or none when it is missing. */
export async function list(home, rel) {
  try {
    return await readdir(at(home, rel));
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return [];
    throw e;
  }
}

/** A file's modification time as an ISO string, or null. */
export async function modified(home, rel) {
  try {
    return (await stat(at(home, rel))).mtime.toISOString();
  } catch {
    return null;
  }
}

export async function remove(home, rel) {
  await rm(at(home, rel), { recursive: true, force: true });
}

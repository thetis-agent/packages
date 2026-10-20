// The package's files, all under the person's home. Every JSON write is a whole file written beside its
// destination and renamed over it, so a reader — the service after a restart, the archive hook in the
// gateway, a person looking — never sees half a record. A missing file reads as the fallback: an empty
// home is normal. Three writers share these files (the hook, the UI commands, the service), and whole-file
// renames are what lets them share without a lock.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

const at = (home, rel) => resolve(home, rel);

/** Parsed JSON, or `fallback` when the file is missing or does not parse. */
export async function readJson(home, rel, fallback = null) {
  const text = await readText(home, rel);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** A file's text, or null when it is missing. */
export async function readText(home, rel) {
  try {
    return await readFile(at(home, rel), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
}

/** Writes text through a temporary file and a rename. */
export async function writeText(home, rel, text) {
  const file = at(home, rel);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export const writeJson = (home, rel, value) => writeText(home, rel, JSON.stringify(value, null, 2) + "\n");

/** The names in a directory, or none when it is missing. */
export async function list(home, rel) {
  try {
    return await readdir(at(home, rel));
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return [];
    throw e;
  }
}

export async function exists(home, rel) {
  try {
    await stat(at(home, rel));
    return true;
  } catch {
    return false;
  }
}

export async function remove(home, rel) {
  await rm(at(home, rel), { recursive: true, force: true });
}

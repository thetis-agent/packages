// The commands of @thetis/ui-workspace, one per verb the manifest declares, plus the three raw exports
// the gateway will route once it has a `kind: "raw"` seam. The gateway runs each as the person, in the
// person's own fence, with `env` = the fence environment plus `user`, `role` and the `session` the page
// named. Commands answer `{ data }`; a refusal is a thrown Error, answered as `400 { error }` with the
// sentence. Reach is decided by `resolveContained` from tools-files on every path, so this package can
// see exactly what the file tools see and not a directory more.
import { basename } from "node:path";
import { uiMount } from "@thetis/projects/index.js";
import { list as listDir } from "./lib/entries.js";
import * as files from "./lib/files.js";
import { roots as rootsOf } from "./lib/roots.js";
import { resolve as resolvePaths } from "./lib/resolve.js";
import { dispositionOf } from "./lib/files.js";
import { zipStream } from "./lib/zip.js";

export const { INLINE_LIMIT, WRITE_INLINE_LIMIT, MAX_UPLOAD, MAX_TEXT, MAX_ENTRIES, MAX_BYTES } = files;

const args = (a) => (a && typeof a === "object" ? a : {});

/** roots: home, shared, the projects with their directories' states, and the mounts. */
export async function roots(a, env) {
  return { data: await rootsOf(args(a), env) };
}

/** list: one directory, dirs first, 500 rows, dotfiles on request. */
export async function list(a, env) {
  return { data: await listDir(args(a), env) };
}

/** stat: the facts about one path. */
export async function stat(a, env) {
  return { data: await files.stat(args(a), env) };
}

/** read: a text file inline when it fits, else the facts and the browser fetches raw. */
export async function read(a, env) {
  return { data: await files.read(args(a), env) };
}

/** write: text to a file, atomically, refusing when the etag no longer matches unless forced. */
export async function write(a, env) {
  return { data: await files.write(args(a), env) };
}

/** mkdir: a directory and its parents. */
export async function mkdir(a, env) {
  return { data: await files.mkdir(args(a), env) };
}

/** rename: a new name in the same directory. */
export async function rename(a, env) {
  return { data: await files.rename(args(a), env) };
}

/** delete: a file or a tree; `dryRun` counts instead. */
export async function del(a, env) {
  return { data: await files.del(args(a), env) };
}

/** count: files, directories and bytes under a path, stopping at the caps. */
export async function count(a, env) {
  return { data: await files.count(args(a), env) };
}

/** resolve: which of up to 64 paths can be reached, relative ones against home then the project. */
export async function resolve(a, env) {
  return { data: await resolvePaths(args(a), env) };
}

/** bind (admin): binds a host directory into this person's fence; `@thetis/projects` does the work. */
export async function bind(a, env) {
  if (env?.role !== "admin") files.fail("Binding a directory is an admin's action.");
  return uiMount(args(a), env);
}

// ---- raw seam (exported now, declared in the manifest once the gateway has `kind: "raw"`) ----

/** upload: `{dir, name, replace?}` with the body as bytes → `{ path, size, etag, replaced }` or `{ exists, path }`. */
export async function upload(a, env, extra = {}) {
  return files.upload(args(a), env, extra);
}

/** raw: the file's bytes with the headers a browser needs. */
export async function raw(a, env) {
  return files.raw(args(a), env);
}

/** zip: a directory (or one file) as a zip stream, refused over the caps before it starts. */
export async function zip(a, env) {
  const { absolute, display } = await files.contained(env, args(a).path);
  await files.statOrFail(absolute, display);
  const name = `${basename(absolute) || "workspace"}.zip`;
  const body = await zipStream(absolute, { display });
  return { status: 200, headers: { "content-type": "application/zip", "content-disposition": dispositionOf("attachment", name), "cache-control": "no-store" }, body };
}

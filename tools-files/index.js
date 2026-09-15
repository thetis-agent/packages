// Entry point: wraps each tool implementation with the shared spill bound. The kernel's
// tool env already exposes cwd (home, read-write) and shared (read-only), which is exactly
// what lib/paths.js expects, so no adaptation is needed beyond picking those two fields.
// The mounts come from the fence's environment (THETIS_MOUNTS), which lib/paths.js reads once.
import { readPath as readPathImpl } from "./lib/read-path.js";
import { editPath as editPathImpl } from "./lib/edit-path.js";
import { writePath as writePathImpl } from "./lib/write-path.js";
import { searchFiles as searchFilesImpl } from "./lib/search-files.js";
import { findFiles as findFilesImpl } from "./lib/find-files.js";
import { getDirectory as getDirectoryImpl } from "./lib/get-directory.js";
import { spill } from "./lib/spill.js";

function toolEnv(env) {
  return { cwd: env.cwd, shared: env.shared ?? null };
}

function wrap(name, fn) {
  return async (args, env) => {
    const tenv = toolEnv(env);
    try {
      const result = await fn(args, tenv);
      return await spill(result, name, tenv);
    } catch (e) {
      // A refusal is still bounded, and it is marked so the transcript and the model see a failure, not an answer.
      return `error: ${await spill(e.message ?? String(e), name, tenv)}`;
    }
  };
}

export const readPath = wrap("read_path", readPathImpl);
export const editPath = wrap("edit_path", editPathImpl);
export const writePath = wrap("write_path", writePathImpl);
export const searchFiles = wrap("search_files", searchFilesImpl);
export const findFiles = wrap("find_files", findFilesImpl);
export const getDirectory = wrap("get_directory", getDirectoryImpl);

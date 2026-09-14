// get_directory: a bounded ls -R replacement. Depth 1 lists everything so the model can
// see what's actually there (including dotfiles); deeper levels apply the same skip list
// as search_files/find_files so we don't drown in node_modules while exploring.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveContained } from "./paths.js";
import { SKIP_DIRS } from "./walk.js";

const MAX_ENTRIES = 500;

export async function getDirectory(args, env) {
  const { absolute, display } = await resolveContained(env, args.path ?? ".", { write: false });
  const depth = Math.min(3, Math.max(1, Number(args.depth) || 1));

  let root;
  try {
    root = await stat(absolute);
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`${display} does not exist.`);
    throw e;
  }
  if (!root.isDirectory()) throw new Error(`${display} is not a directory.`);

  const lines = [];
  const state = { count: 0, capped: false };
  await listLevel(absolute, "", 1, depth, lines, state);

  const footer = state.capped ? `… and more (500 entries shown)` : `${state.count} entries`;
  return [lines.join("\n"), footer].join("\n\n");
}

async function listLevel(dir, prefix, level, maxDepth, lines, state) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // directories first, then files, both alphabetical, matches how people scan a listing
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

  for (const ent of entries) {
    if (level > 1 && ent.isDirectory() && SKIP_DIRS.has(ent.name)) continue;
    if (state.count >= MAX_ENTRIES) { state.capped = true; return; }
    state.count++;

    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      lines.push(`${prefix}${ent.name}/`);
      if (level < maxDepth) await listLevel(full, prefix + "  ", level + 1, maxDepth, lines, state);
    } else {
      const st = await stat(full).catch(() => null);
      lines.push(`${prefix}${ent.name}${st ? `  (${st.size} bytes)` : ""}`);
    }
  }
}

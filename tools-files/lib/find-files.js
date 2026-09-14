// find_files: locate files by name glob, newest first, without a shell find call.
import { resolveContained } from "./paths.js";
import { walkFiles, globToRegExp } from "./walk.js";

const DEFAULT_MAX_RESULTS = 200;

export async function findFiles(args, env) {
  if (!args.glob) throw new Error("glob is required.");
  const { absolute } = await resolveContained(env, args.path ?? ".", { write: false });
  const maxResults = Math.max(1, Number(args.max_results) || DEFAULT_MAX_RESULTS);
  const regex = globToRegExp(String(args.glob));

  const state = {};
  const found = [];
  for await (const ent of walkFiles(absolute, state)) {
    if (!regex.test(ent.name)) continue;
    found.push({ path: ent.path, mtime: ent.stat.mtimeMs });
  }
  found.sort((a, b) => b.mtime - a.mtime);

  const capped = found.length > maxResults;
  const shown = found.slice(0, maxResults);
  const lines = shown.map((f) => relOf(f.path, env));

  const footer = [`${found.length} files matching ${args.glob}`];
  if (capped) footer.push(`(newest ${maxResults} shown; there may be more)`);
  if (state.hitBound) footer.push(`(the scan bound was reached before the tree was exhausted; narrow path to be sure)`);

  return [lines.join("\n"), footer.join("\n")].filter(Boolean).join("\n\n");
}

function relOf(absolute, env) {
  return absolute.startsWith(env.cwd) ? absolute.slice(env.cwd.length + 1) : absolute;
}

// search_files: a bounded regex grep across the tree, so the model doesn't reach for
// shell grep. Three modes share one walk so the skip list and scan bound apply uniformly.
import { readFile } from "node:fs/promises";
import { resolveContained } from "./paths.js";
import { walkFiles, globToRegExp, looksBinary } from "./walk.js";

const MAX_RESULTS_CAP = 1000;
const DEFAULT_MAX_RESULTS = 100;
const LINE_CLIP = 300;

function buildRegex(pattern, ignoreCase) {
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (e) {
    throw new Error(`pattern is not a valid regular expression: ${e.message}`);
  }
}

export async function searchFiles(args, env) {
  const { absolute, display } = await resolveContained(env, args.path ?? ".", { write: false });
  const regex = buildRegex(String(args.pattern ?? ""), Boolean(args.ignore_case));
  const nameFilter = args.glob ? globToRegExp(args.glob) : null;
  const mode = args.mode ?? "content";
  const maxResults = Math.min(MAX_RESULTS_CAP, Math.max(1, Number(args.max_results) || DEFAULT_MAX_RESULTS));

  const state = {};
  const lines = [];
  let total = 0;
  const fileCounts = new Map();
  let stoppedOnResults = false;

  for await (const ent of walkFiles(absolute, state)) {
    if (nameFilter && !nameFilter.test(ent.name)) continue;
    if (ent.stat.size > 4 * 1024 * 1024) continue; // skip huge files silently, same as read_path's own cap
    const buf = await readFile(ent.path).catch(() => null);
    if (!buf || (await looksBinary(buf))) continue;

    const text = buf.toString("utf8");
    const fileLines = text.split("\n");
    let matchesInFile = 0;
    for (let i = 0; i < fileLines.length; i++) {
      if (!regex.test(fileLines[i])) continue;
      matchesInFile++;
      total++;
      if (mode === "content" && lines.length < maxResults) {
        const clipped = fileLines[i].length > LINE_CLIP ? fileLines[i].slice(0, LINE_CLIP) + "…" : fileLines[i];
        lines.push(`${relOf(ent.path, env)}:${i + 1}:${clipped}`);
      }
    }
    if (matchesInFile > 0) fileCounts.set(ent.path, matchesInFile);
    if (mode === "content" && lines.length >= maxResults) { stoppedOnResults = true; break; }
    if (mode === "files" && fileCounts.size >= maxResults) { stoppedOnResults = true; break; }
  }

  const body = renderBody(mode, lines, fileCounts, total, env);
  const tally = renderTally(mode, lines.length, fileCounts.size, total, state, stoppedOnResults, maxResults);
  return [body, tally].filter(Boolean).join("\n\n");
}

function relOf(absolute, env) {
  return absolute.startsWith(env.cwd) ? absolute.slice(env.cwd.length + 1) : absolute;
}

function renderBody(mode, lines, fileCounts, total, env) {
  if (mode === "content") return lines.join("\n");
  if (mode === "files") return [...fileCounts.entries()].map(([p, c]) => `${relOf(p, env)}: ${c} match(es)`).join("\n");
  return ""; // count mode has no body, just the tally
}

function renderTally(mode, shown, filesShown, total, state, stoppedOnResults, maxResults) {
  const parts = [];
  if (mode === "count") parts.push(`${total} match(es)`);
  else if (mode === "files") parts.push(`${filesShown} file(s) with matches, ${total} match(es) total`);
  else parts.push(`${shown} of ${total} match(es) shown`);

  if (stoppedOnResults) {
    parts.push(`(stopped at the first ${maxResults}). Narrow with a tighter pattern, a glob such as '*.js', or a path deeper in the tree; or use mode='files' to see just where.`);
  } else if (state.hitBound) {
    parts.push(`(the scan bound was reached before the tree was exhausted; narrow path to be sure)`);
  }
  return parts.join("\n");
}

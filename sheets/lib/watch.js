// watch (stream): how the page learns of a change whoever made it — a tool in the fence, the page itself,
// another browser tab, a person editing `sheet.json` by hand. It watches the `sheets/` directory, names the
// sheet a change was under, and a moment later reads that sheet again and says what it is now:
// `{ ev: "changed", sheet, rev, title, project, updatedAt, tabs, cells, by, session? }`, where `by` and
// `session` are those of the sheet's last Change (so a page knows its own echo and which agent edit to
// flash), or `{ ev: "removed", sheet }`. First a `snapshot` of the list, then `ping` after twenty quiet
// seconds so a dead connection is noticed.
//
// The lock directory is never a change. A temporary dot-file is never read and never an event of its own,
// but it is a signal: Node's recursive watch on Linux follows inodes, and after a few renames into place it
// reports only the temporary name of the move, never `sheet.json`. So any other name under a sheet makes it
// look again, and what it says is decided by `sheet.json` itself — its time and size — so a temporary file
// that changed nothing says nothing.
import { watch as fsWatch } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { summaries } from "./commands.js";
import { cellsOf, DIR, isSheetId, readSheet, sheetPath } from "./store.js";

const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 20_000;

/** What the page is told about one sheet now. */
export function changedEvent(workbook) {
  const last = workbook.changes?.[workbook.changes.length - 1];
  return {
    ev: "changed",
    sheet: workbook.id,
    rev: workbook.rev,
    title: workbook.title,
    project: workbook.project,
    updatedAt: workbook.updatedAt,
    tabs: workbook.tabs.length,
    cells: cellsOf(workbook),
    by: last?.by ?? null,
    ...(last?.session ? { session: last.session } : {}),
  };
}

export async function* uiWatch(args, env) {
  const dir = resolve(env.cwd, DIR);
  await mkdir(dir, { recursive: true });
  const only = isSheetId(args?.sheet) ? args.sheet : null;

  const pending = new Set();
  const queue = [];
  const seen = new Map();
  let timer = null;
  let wake = null;
  let stopped = false;
  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const stop = () => {
    stopped = true;
    nudge();
  };

  const flush = async () => {
    timer = null;
    for (const id of [...pending]) {
      pending.delete(id);
      try {
        const st = await stat(sheetPath(env, id)).catch(() => null);
        const mark = st ? `${st.mtimeMs}:${st.size}` : "gone";
        if (seen.get(id) === mark) continue;
        const workbook = st ? await readSheet(env, id) : null;
        if (st && !workbook) continue; // unreadable for now: the next change says
        seen.set(id, mark);
        queue.push(workbook ? changedEvent(workbook) : { ev: "removed", sheet: id });
      } catch {
        /* a sheet half-written or gone: the next change says */
      }
    }
    nudge();
  };

  // The watcher is up before the snapshot is taken, so nothing changed between the two is missed: a
  // generator suspended on its first value is not running the code after it.
  let watcher;
  try {
    watcher = fsWatch(dir, { recursive: true }, (_type, name) => {
      if (stopped || !name) return;
      const parts = String(name).split(/[\\/]/);
      const id = parts[0];
      if (!isSheetId(id) || (only && id !== only) || parts.some((p) => p.startsWith(".lock"))) return;
      pending.add(id);
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), DEBOUNCE_MS);
    });
  } catch {
    yield { ev: "snapshot", ...(await summaries(env)) };
    return; // no watcher here (an inotify limit, say): the page retries, and its next snapshot resyncs
  }
  watcher.on("error", stop);
  env.signal?.addEventListener("abort", stop, { once: true });
  try {
    yield { ev: "snapshot", ...(await summaries(env)) };
    for (;;) {
      if (stopped) return;
      if (!queue.length) {
        await new Promise((done) => {
          const beat = setTimeout(() => {
            wake = null;
            done();
          }, HEARTBEAT_MS);
          beat.unref?.();
          wake = () => {
            clearTimeout(beat);
            done();
          };
        });
        if (stopped) return;
        if (!queue.length) {
          yield { ev: "ping" };
          continue;
        }
      }
      while (queue.length) yield queue.shift();
    }
  } finally {
    clearTimeout(timer);
    watcher.close();
    env.signal?.removeEventListener("abort", stop);
  }
}

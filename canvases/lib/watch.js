// watch (stream): how the page learns of a change whoever made it — a tool in the fence, the page itself,
// another browser tab, a person editing a file by hand. It watches the `canvases/` directory, names the
// canvas a change was under, and a moment later reads that canvas again and says what it is now:
// `{ ev: "changed", canvas, rev, title, project, updatedAt, files, assets }` with every artboard file's
// time and size (the page diffs those itself; which file inotify names for a rename is not worth
// trusting), or `{ ev: "removed", canvas }`. First a `snapshot` of the list, then `ping` every twenty
// quiet seconds so a dead connection is noticed.
//
// A temporary file (a dot in front) is never an event of its own, but it is a signal: Node's recursive
// watch on Linux follows inodes, and after a couple of renames into place it reports only the temporary
// name of the move, never `canvas.json` or the artboard. So any name under a canvas makes it look again,
// and it speaks only when what it reads differs from what it last said.
import { watch as fsWatch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { summaries } from "./commands.js";
import { assetList, boardFiles, DIR, isCanvasId, readIndex } from "./store.js";

const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 20_000;

export async function* uiWatch(args, env) {
  const dir = resolve(env.cwd, DIR);
  await mkdir(dir, { recursive: true });
  const only = isCanvasId(args?.canvas) ? args.canvas : null;

  const pending = new Set();
  const queue = [];
  const said = new Map(); // id -> the facts of the last event, so a look that finds nothing new says nothing
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
        const index = await readIndex(env, id);
        const event = index ? { ev: "changed", canvas: id, rev: index.rev, title: index.title, project: index.project, updatedAt: index.updatedAt, files: await boardFiles(env, index), assets: await assetList(env, id) } : { ev: "removed", canvas: id };
        const facts = JSON.stringify(event);
        if (said.get(id) === facts) continue;
        said.set(id, facts);
        queue.push(event);
      } catch {
        /* a canvas half-written or gone: the next change says */
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
      if (!isCanvasId(id) || (only && id !== only)) return;
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

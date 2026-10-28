// The gateway's commands for the Maps sidebar and the map tab. They read and write the same files the
// map_* tools do (lib/store.js), through `mutate`, so the person's edits in the tab and the agent's in the
// chat land on top of each other instead of over each other.
//
//   list    (json)       the maps, one summary row each
//   doc     (raw GET)    one map's document whole, its revision and its publish state: raw because a large
//                        map is more than the 256 KiB a JSON answer may be
//   save    (raw PUT)    a patch (ui/core/doc.js diffDocs) from the revision the tab last read, applied on
//                        top of whatever is on disk now; answers the new revision and any cell conflicts
//   create  (json)       a new map with one area and one room
//   rename  (json)       the map's title
//   remove  (json)       the map, for good (the world is not touched)
//   focus   (json)       what the person has selected, so the agent can be told "this room"
//   watch   (stream)     a snapshot, then a `changed` or `removed` event per change, whoever made it
//   editor  (frame)      the cartographer itself, served into a sandboxed iframe

import { watch as fsWatch } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, completeDoc } from "../ui/core/doc.js";
import { createMap, DIR, fail, isMapId, listMaps, mapPath, mutate, needMap, publishState, readMap, removeMap, summary, writeFocus } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAME_DIR = resolve(HERE, "../frame");
const MAX_PATCH = 24 * 1024 * 1024;
const person = (env) => ({ by: "person", session: env.session?.id });

function rowOf(record) {
  return { ...summary(record), label: publishState(record).label, linked: Object.keys(record.link.areas).length };
}

export async function uiList(_args, env) {
  return { data: { maps: (await listMaps(env)).map(rowOf) } };
}

export async function uiDoc(args, env, req) {
  if (req?.method && req.method !== "GET") fail("doc is read with GET.");
  const record = await needMap(env, args.map);
  const ps = publishState(record);
  const body = JSON.stringify({ id: record.id, rev: record.rev, doc: record.doc, state: ps.state, label: ps.label, linked: record.link.rooms, by: record.changes.at(-1)?.by ?? null });
  return { headers: { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)) }, body };
}

export async function uiSave(args, env, req) {
  if (req?.method && req.method !== "PUT") fail("save is sent with PUT.");
  if (!isMapId(args.map)) fail("save needs { map }.");
  const body = req?.body ?? Buffer.alloc(0);
  if (!body.length) fail("The patch is empty.");
  if (body.length > MAX_PATCH) fail("That patch is larger than 24 MB.");
  let patch;
  try {
    patch = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    fail("The patch is not JSON.");
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) fail("The patch is not an object.");
  let conflicts = [];
  let renumbered = [];
  const next = await mutate(env, args.map, (cur) => {
    const out = applyPatch(cur.doc, patch, { renumber: true });
    conflicts = out.conflicts;
    renumbered = out.renumbered ?? [];
    return { doc: out.doc, what: describe(patch) };
  }, person(env));
  const ps = publishState(next);
  return { rev: next.rev, unchanged: Boolean(next.unchanged), conflicts, renumbered, state: ps.state, label: ps.label, base: Number(args.base) || 0 };
}

function describe(patch) {
  const parts = [];
  for (const c of ["areas", "rooms", "exits", "edges", "elevators"]) {
    const p = patch[c];
    if (!p) continue;
    const bits = [p.add?.length ? `+${p.add.length}` : "", p.put?.length ? `~${p.put.length}` : "", p.del?.length ? `-${p.del.length}` : ""].filter(Boolean);
    if (bits.length) parts.push(`${c} ${bits.join(" ")}`);
  }
  if (patch.blocks) parts.push(`blocks +${patch.blocks.add?.length ?? 0} -${patch.blocks.del?.length ?? 0}`);
  if (typeof patch.name === "string") parts.push(`renamed to "${patch.name}"`);
  return `edited in the tab: ${parts.join(", ") || "no change"}`;
}

export async function uiCreate(args, env) {
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 200) : "Untitled map";
  const doc = completeDoc({ name, areas: [{ id: "a1", name: "Main" }], rooms: [{ id: "r2", area: "a1", x: 0, y: 0, z: 0, name: "Start" }], nextId: 3 });
  const record = await createMap(env, { doc, ...person(env), what: "created the map in the tab" });
  return { data: { map: rowOf(record) } };
}

export async function uiRename(args, env) {
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 200) : "";
  if (!name) fail("A map needs a name.");
  const next = await mutate(env, args.map, (cur) => ({ doc: { ...cur.doc, name }, what: `renamed to "${name}"` }), person(env));
  return { data: { id: next.id, rev: next.rev } };
}

export async function uiRemove(args, env) {
  const record = await needMap(env, args.map);
  await removeMap(env, record.id);
  return { data: { removed: record.id } };
}

export async function uiFocus(args, env) {
  if (!isMapId(args.map)) fail("focus needs { map }.");
  const f = args.focus && typeof args.focus === "object" ? args.focus : {};
  const sel = f.sel && typeof f.sel === "object" && ["room", "exit", "edge"].includes(f.sel.kind) && typeof f.sel.id === "string" ? { kind: f.sel.kind, id: f.sel.id.slice(0, 64) } : null;
  await writeFocus(env, args.map, { sel, area: typeof f.area === "string" ? f.area.slice(0, 64) : null, floor: Number.isInteger(f.floor) ? f.floor : 0 });
  return { data: { ok: true } };
}

// ---- watch --------------------------------------------------------------------------------------------

const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 20_000;

function changedEvent(record) {
  const last = record.changes.at(-1);
  return { ev: "changed", map: record.id, row: rowOf(record), rev: record.rev, by: last?.by ?? null, what: last?.what ?? "", ...(last?.session ? { session: last.session } : {}) };
}

export async function* uiWatch(_args, env) {
  const dir = resolve(env.cwd, DIR);
  await mkdir(dir, { recursive: true });
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
        const st = await stat(mapPath(env, id)).catch(() => null);
        const mark = st ? `${st.mtimeMs}:${st.size}` : "gone";
        if (seen.get(id) === mark) continue;
        const record = st ? await readMap(env, id) : null;
        if (st && !record) continue;
        seen.set(id, mark);
        queue.push(record ? changedEvent(record) : { ev: "removed", map: id });
      } catch {
        /* half-written: the next change says */
      }
    }
    nudge();
  };
  let watcher;
  try {
    watcher = fsWatch(dir, { recursive: true }, (_type, name) => {
      if (stopped || !name) return;
      const parts = String(name).split(/[\\/]/);
      const id = parts[0];
      // focus.json is the tab's own echo of a click: never a change of the map
      if (!isMapId(id) || parts.some((p) => p.startsWith(".lock") || p === "focus.json")) return;
      pending.add(id);
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), DEBOUNCE_MS);
    });
  } catch {
    yield { ev: "snapshot", maps: (await listMaps(env)).map(rowOf) };
    return;
  }
  watcher.on("error", stop);
  env.signal?.addEventListener("abort", stop, { once: true });
  try {
    const all = await listMaps(env);
    for (const r of all) {
      const st = await stat(mapPath(env, r.id)).catch(() => null);
      if (st) seen.set(r.id, `${st.mtimeMs}:${st.size}`);
    }
    yield { ev: "snapshot", maps: all.map(rowOf) };
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

// ---- the editor frame ------------------------------------------------------------------------------------

const FILES = {
  "": { file: "index.html", type: "text/html; charset=utf-8" },
  "index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "mapper.css": { file: "mapper.css", type: "text/css; charset=utf-8" },
  "editor.js": { files: ["engine.js", "host.js"], type: "text/javascript; charset=utf-8" },
};

/**
 * The frame's files. The document runs under an opaque origin, where a module script would need CORS, so
 * the engine (an ES module, kept diffable against the website's copy) is served as a classic script: its
 * one `export` keyword dropped and the host glue appended.
 */
export async function uiEditor(args, env, req) {
  if (!isMapId(args.map)) fail("The editor frame is minted for one map: { map }.");
  const spec = FILES[String(req?.path ?? "")];
  if (!spec) return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "not found" };
  let body;
  if (spec.files) {
    const parts = await Promise.all(spec.files.map((f) => readFile(resolve(FRAME_DIR, f), "utf8")));
    body = `(function(){"use strict";\n${parts[0].replace(/^export function createMapper/m, "function createMapper")}\n${parts.slice(1).join("\n")}\n})();\n`;
  } else {
    body = await readFile(resolve(FRAME_DIR, spec.file), "utf8");
  }
  return { headers: { "content-type": spec.type, "content-length": String(Buffer.byteLength(body)) }, body };
}

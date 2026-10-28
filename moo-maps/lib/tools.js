// The map_* tools, run in the person's fence. Each names its map by id or title, changes it only through
// `mutate` (lib/store.js) so an edit lands on top of whatever the person saved in the tab a moment before,
// and answers plain text: the first line says what happened and the revision it left.
//
// Editing a map never touches the world. map_publish writes it to the MOO, map_pull brings the world's
// changes back, map_import starts a map from areas that already exist. The link between them (local id →
// MOO object) lives in the map file and is kept up to date by those three.

import { completeDoc, countsOf, DEFAULT_COLOR } from "../ui/core/doc.js";
import * as ops from "./ops.js";
import { Book, exitLines, nameOf, at } from "./ops.js";
import { createMap, emptyLink, fail, isMapId, listMaps, mutate, needMap, publishState, readFocus, removeMap, summary } from "./store.js";
import * as moo from "./moo.js";
import { describeOp, linkAfter, mergePull, planPublish, project, remoteDoc, resolveOp } from "./sync.js";
import { areaBuild, header, textMap } from "./view.js";

const MAX_OUTPUT = 60_000;

/** How the tools reach the world. Tests swap it for a simulated one. */
export const world = { connect: moo.connect, listAreas: moo.listAreas, snapshot: moo.snapshot, runOps: moo.runOps };
const connect = (env) => world.connect(env);
const listAreas = (c, q) => world.listAreas(c, q);
const snapshot = (c, ids) => world.snapshot(c, ids);
const runOps = (c, areas, list) => world.runOps(c, areas, list);
const agent = (env) => ({ by: "agent", session: env.session?.id });
const plural = (n, word) => `${n} ${n === 1 ? word : /(ch|sh|s|x)$/.test(word) ? `${word}es` : `${word}s`}`;
const given = (v) => v !== undefined && v !== null && v !== "";

function bounded(text) {
  if (text.length <= MAX_OUTPUT) return text;
  const end = text.lastIndexOf("\n", MAX_OUTPUT - 300);
  return text.slice(0, end > 0 ? end : MAX_OUTPUT - 300) + `\n\n[cut: ${text.length} characters in all. Ask for one area or level, or leave descriptions off.]`;
}

/** A map by id or title; with none given, the only map there is. */
async function resolveMap(env, ref) {
  if (isMapId(ref)) return needMap(env, ref);
  const all = await listMaps(env);
  if (!given(ref)) {
    if (all.length === 1) return all[0];
    fail(all.length ? `Name the map: ${all.slice(0, 12).map((m) => `${m.id} "${m.doc.name}"`).join(", ")}.` : "There are no maps yet. map_create starts one, map_import makes one from areas in the world.");
  }
  const q = String(ref).toLowerCase();
  const hits = all.filter((m) => m.doc.name.toLowerCase() === q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) fail(`${hits.length} maps are called "${ref}": ${hits.map((m) => m.id).join(", ")}. Use the id.`);
  fail(`No map ${JSON.stringify(ref)}. map_list names the maps there are.`);
}

/** Apply one pure edit to a map and answer the result with the map's text grid. */
async function edit(env, args, what, fn, { show = true } = {}) {
  const record = await resolveMap(env, args.map);
  if (args.dry_run) {
    const res = fn(record.doc, record.link);
    return [`Dry run on ${record.id}: nothing written. It would:`, ...res.lines.map((l) => `- ${l}`)].join("\n");
  }
  let lines = [];
  let extra;
  const next = await mutate(env, record.id, (cur) => {
    const res = fn(cur.doc, cur.link);
    lines = res.lines;
    extra = res;
    return { doc: res.doc, what: `${what}: ${lines.slice(0, 3).join("; ")}`.slice(0, 240) };
  }, agent(env));
  if (next.unchanged) return `${record.id}: nothing changed (rev ${next.rev}).`;
  const out = [`${record.id} "${next.doc.name}" is now rev ${next.rev}. ${publishState(next).state === "draft" ? "Not in the world until map_publish." : "map_publish writes it to the world."}`, ...lines.map((l) => `- ${l}`)];
  if (extra?.total !== undefined) out.push(`${plural(extra.total, "replacement")} in all.`);
  if (show) {
    const areas = new Set(extra?.touched ?? []);
    out.push("", textMap(next, { area: areas.size === 1 ? [...areas][0] : undefined, z: args.z }));
  }
  return bounded(out.join("\n"));
}

/** What the person has on screen in the map tab, as the tab last told it (focus.json). */
function focusLine(book, focus) {
  const a = book.areas.get(focus.area);
  const parts = [`looking at area ${a ? `${a.id} "${a.name}"` : focus.area ?? "?"}, level z=${focus.floor ?? 0}`];
  const s = focus.sel;
  if (s?.kind === "room" && book.rooms.get(s.id)) {
    const r = book.rooms.get(s.id);
    parts.push(`room ${nameOf(r)} ${at(r)} selected`);
  } else if (s?.kind === "exit") {
    const e = book.doc.exits.find((x) => x.id === s.id);
    if (e) parts.push(`exit ${e.id} between ${nameOf(book.rooms.get(e.a))} and ${nameOf(book.rooms.get(e.b))} selected`);
  } else if (s?.kind === "edge") parts.push(`edge ${s.id} selected`);
  return `${parts.join(", ")} (as of ${String(focus.at ?? "").slice(11, 16)} UTC)`;
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

export async function mapList(args, env) {
  const all = await listMaps(env);
  if (!all.length) return "No maps yet. map_create starts one; map_import makes one from areas already in the world.";
  const lines = all.map((m) => {
    const s = summary(m);
    return `${m.id} "${m.doc.name}" · ${s.rooms} rooms, ${s.exits} exits, ${s.areas} area${s.areas === 1 ? "" : "s"} · ${publishState(m).label} · rev ${m.rev}, ${m.updatedAt.slice(0, 16).replace("T", " ")} UTC by ${s.by ?? "?"}`;
  });
  return [`${plural(all.length, "map")}. The person sees them under Maps in the sidebar.`, ...lines].join("\n");
}

export async function mapCreate(args, env) {
  const name = String(args.name ?? "").trim();
  if (!name) fail("a map needs a name.");
  const areaNames = Array.isArray(args.areas) && args.areas.length ? args.areas : [name];
  let doc = completeDoc({ name, areas: areaNames.map((a, i) => ({ id: `a${i + 1}`, name: String(a) })), nextId: areaNames.length + 1 });
  const lines = [];
  if (Array.isArray(args.rooms) && args.rooms.length) {
    const res = ops.setRooms(doc, emptyLink(), args.rooms);
    doc = res.doc;
    lines.push(...res.lines);
  }
  const record = await createMap(env, { doc, ...agent(env), what: `created "${name}"` });
  return bounded([
    `Created map ${record.id} "${name}", rev ${record.rev}, with area${doc.areas.length === 1 ? "" : "s"} ${doc.areas.map((a) => `${a.id} "${a.name}"`).join(", ")}. The person opens it from Maps in the sidebar. It is a draft: nothing is in the world until map_publish.`,
    ...lines.map((l) => `- ${l}`),
    ...(doc.rooms.length ? ["", textMap(record)] : []),
  ].join("\n"));
}

export async function mapDelete(args, env) {
  const record = await resolveMap(env, args.map);
  if (args.confirm !== true) fail(`map_delete removes ${record.id} "${record.doc.name}" from Thetis for good (the world is not touched). Call again with confirm: true.`);
  await removeMap(env, record.id);
  const linked = Object.keys(record.link.areas).length;
  return `Deleted map ${record.id} "${record.doc.name}". ${linked ? `Its ${plural(linked, "area")} in the world ${linked === 1 ? "is" : "are"} left as ${linked === 1 ? "it is" : "they are"}; map_import brings them back into a new map.` : ""}`.trim();
}

export async function mapGet(args, env) {
  const record = await resolveMap(env, args.map);
  if (args.json) return bounded(JSON.stringify({ id: record.id, rev: record.rev, doc: record.doc, link: { ...record.link, published: record.link.published ? countsOf(record.link.published) : null } }, null, 1));
  const book = new Book(record.doc, record.link);
  const area = given(args.area) ? book.area(args.area).id : undefined;
  const focus = await readFocus(env, record.id);
  const out = [header(record)];
  if (focus && (focus.sel || focus.area)) {
    out.push(`the person, in the map tab: ${focusLine(book, focus)}`);
  }
  const recent = record.changes.slice(-5).reverse().map((c) => `rev ${c.rev} ${c.by}: ${c.what}`);
  out.push(`recent: ${recent.join(" | ")}`, "", textMap(record, { area, z: args.z, descriptions: args.descriptions }));
  return bounded(out.join("\n"));
}

/** Rooms in detail: a filter, or one room. */
export async function mapRooms(args, env) {
  const record = await resolveMap(env, args.map);
  const book = new Book(record.doc, record.link);
  let list;
  if (given(args.room) || (Number.isInteger(args.x) && Number.isInteger(args.y))) {
    const ref = given(args.room) ? args.room : { x: args.x, y: args.y, z: args.z ?? 0, area: args.area };
    const r = book.room(ref, { required: false });
    if (!r) {
      const c = typeof ref === "object" ? book.cell(ref) : null;
      const blocked = c && book.blocks.has(`${c.area}:${c.x},${c.y},${c.z}`);
      return `${record.id}: no room ${typeof ref === "object" ? `at (${c.x},${c.y},${c.z}) in ${c.area}${blocked ? " (the cell is blocked out)" : " (the cell is empty)"}` : ref}.`;
    }
    list = [r];
  } else {
    list = ops.listRooms(record.doc, record.link, { area: args.area, z: args.z, query: args.query, box: args.box });
  }
  const limit = Math.min(Number(args.limit) || 100, 500);
  const full = list.length === 1 || args.descriptions;
  const rows = list.slice(0, limit).map((r) => {
    const moo = record.link.rooms[r.id];
    const head = `${nameOf(r)} ${at(r)} in ${r.area}${moo ? ` · ${moo}` : " · not in the world yet"}${r.color !== DEFAULT_COLOR ? ` · colour ${r.color}` : ""}`;
    const lines = [head, ...exitLines(book, r).map((l) => `   ${l}`)];
    for (const x of record.link.external.filter((x) => x.room === r.id)) lines.push(`   ${x.dir} → ${x.to} "${x.to_name}" in ${x.to_area_name || x.to_area} (outside the map)`);
    if (full) lines.push(`   description: ${r.description ? r.description.replace(/\n/g, "\n      ") : "(none)"}`);
    if (r.notes) lines.push(`   notes: ${r.notes.replace(/\n/g, "\n      ")}`);
    return lines.join("\n");
  });
  return bounded([`${record.id} rev ${record.rev}: ${plural(list.length, "room")}${list.length > limit ? `, the first ${limit} shown` : ""}.`, ...rows].join("\n"));
}

export async function mapSearch(args, env) {
  const record = await resolveMap(env, args.map);
  const { hits, total } = ops.search(record.doc, record.link, args);
  if (!total) return `${record.id}: no match for ${JSON.stringify(args.pattern)}.`;
  const rows = hits.map((h) => (h.area ? `area ${h.area}: ${h.context}` : `${h.room} "${h.name}" ${h.cell} ${h.field}: ${h.context}`));
  return bounded([`${record.id} rev ${record.rev}: ${plural(total, "match")}${total > hits.length ? `, the first ${hits.length} shown` : ""}.`, ...rows].join("\n"));
}

export const mapReplace = (args, env) => edit(env, args, "replaced text", (doc, link) => ops.replace(doc, link, args), { show: false });
export const mapSetRooms = (args, env) => edit(env, args, "set rooms", (doc, link) => ops.setRooms(doc, link, args.rooms));
export const mapDeleteRooms = (args, env) => edit(env, args, "deleted rooms", (doc, link) => ops.deleteRooms(doc, link, args.rooms));
export const mapMoveRooms = (args, env) => edit(env, args, "moved rooms", (doc, link) => ops.moveRooms(doc, link, args));
export const mapLink = (args, env) => edit(env, args, "linked", (doc, link) => ops.link(doc, link, args));
export const mapUnlink = (args, env) => edit(env, args, "unlinked", (doc, link) => ops.unlink(doc, link, args));
export const mapEdge = (args, env) => edit(env, args, "edge", (doc, link) => ops.edge(doc, link, args));
export const mapElevator = (args, env) => edit(env, args, "elevator", (doc, link) => ops.elevator(doc, link, args), { show: false });
export const mapBlocks = (args, env) => edit(env, args, "blocks", (doc, link) => ops.blocks(doc, link, args));
export async function mapAreas(args, env) {
  if (given(args.name)) {
    // Renaming the map itself.
    return edit(env, args, "renamed the map", (doc, link) => {
      const res = ops.areas(doc, link, args);
      res.doc.name = String(args.name).trim();
      return { doc: res.doc, lines: [`named the map "${res.doc.name}"`, ...res.lines] };
    }, { show: false });
  }
  return edit(env, args, "areas", (doc, link) => ops.areas(doc, link, args), { show: false });
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

export async function mapRender(args, env) {
  const record = await resolveMap(env, args.map);
  const put = env?.kernel?.assets?.put;
  if (typeof put !== "function") fail("this space has no asset store to put images in; map_get draws the map as text.");
  const { levelSvg, toPng, populatedLevels, levelName } = await import("./image.js");
  const book = new Book(record.doc, record.link);
  const areas = given(args.area) ? [book.area(args.area)] : record.doc.areas;
  const assets = [];
  const lines = [];
  for (const a of areas) {
    const b = areaBuild(record.doc, a.id, record.link);
    b.name = `${record.doc.name} · ${a.name}`;
    const levels = populatedLevels(b).filter((z) => args.z === undefined || z === args.z);
    for (const z of levels) {
      if (assets.length >= 6) break;
      const png = await toPng(levelSvg(b, z, { ghost: args.ghost !== false }));
      const name = `${record.id}-${a.id}-z${z}.png`;
      const asset = await put({ mediaType: "image/png", name, data: Buffer.from(png.buf).toString("base64") });
      assets.push({ type: "asset", data: { id: asset.id, mediaType: asset.mediaType ?? "image/png", name: asset.name ?? name } });
      lines.push(`image ${assets.length}: area ${a.id} "${a.name}", level z=${z} (${levelName(z)}), ${b.rooms.filter((r) => r.z === z).length} rooms`);
    }
  }
  if (!assets.length) return `${record.id}: nothing to draw${args.z !== undefined ? ` on level z=${args.z}` : ""}.`;
  const text = [header(record), ...lines, "", "Lines are exits coloured by type (grey open, orange door, red locked, green climb, blue swim), dashed when hidden; a triangle in a corner is an exit up or down (a straight one, or a vertical diagonal such as nu, whose line also points along its bearing); a dashed tag names where an exit leaves the area; a pink arc is a jump edge. The small label in each room matches map_get's legend."].join("\n");
  return { type: "tool-result", content: [{ type: "text", data: { text } }, ...assets] };
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export async function mapWorldAreas(args, env) {
  const conn = await connect(env);
  const res = await listAreas(conn, args.query ?? "");
  const mine = new Map();
  for (const m of await listMaps(env)) for (const [local, moo] of Object.entries(m.link.areas)) mine.set(moo, `${m.id}/${local}`);
  const rows = (res.areas ?? []).sort((a, b) => b.yours - a.yours || a.name.localeCompare(b.name)).slice(0, 300).map((a) => `${a.id} "${a.name}" · ${plural(a.rooms, "room")}${a.yours ? " · yours" : ""}${mine.has(a.id) ? ` · on map ${mine.get(a.id)}` : ""}`);
  return bounded([`${plural(res.areas?.length ?? 0, "area")} in the world${args.query ? ` matching "${args.query}"` : ""}, as ${res.character_name} (${res.character})${res.shaper ? "" : " — NOT a Shaper, so publish will be refused"}. map_import takes their ids.`, ...rows].join("\n"));
}

/**
 * The world's changes merged into a record. Answers { doc, link, lines }. Rooms, exits and edges the
 * world has and the link does not are adopted with fresh local ids.
 */
function pullInto(snap, record) {
  let next = record.doc.nextId;
  const adopted = new Set();
  const alloc = (prefix) => { const id = `${prefix}${next++}`; adopted.add(id); return id; };
  const proj = project(snap, record.link, { adopt: true, alloc, keep: record.doc });
  const world = remoteDoc(proj, { ...record.doc, nextId: next });
  const { doc: merged, kept, conflicts, theirs } = mergePull({ ...record.doc, nextId: next }, record.link.published, world);
  merged.nextId = Math.max(merged.nextId, next);
  const link = { ...record.link, ...proj.link, external: proj.external, character: snap.character ?? record.link.character };
  // A thing adopted now that did not make it into the map (its cell was taken) is not the map's.
  const inDoc = { rooms: new Set(merged.rooms.map((r) => r.id)), exits: new Set(merged.exits.map((e) => e.id)), edges: new Set(merged.edges.map((g) => g.id)), elevators: new Set(merged.elevators.map((v) => v.id)) };
  const liveIds = new Set([...proj.live.rooms.keys()]);
  for (const c of ["rooms", "exits", "edges", "elevators"]) {
    for (const id of Object.keys(link[c])) {
      if (adopted.has(id) && !inDoc[c].has(id)) delete link[c][id];
    }
  }
  // A linked room gone from the world and from the map is forgotten.
  for (const [id, moo] of Object.entries(link.rooms)) if (!inDoc.rooms.has(id) && !liveIds.has(moo)) delete link.rooms[id];
  for (const local of proj.gone.areas) delete link.areas[local];
  for (const local of proj.gone.elevators) delete link.elevators[local];
  link.published = world;
  const lines = [];
  const n = (c) => [...adopted].filter((id) => inDoc[c].has(id) && id[0] === { rooms: "r", exits: "e", edges: "j", elevators: "v" }[c]).length;
  const nr = n("rooms"), ne = n("exits"), nj = n("edges"), nv = n("elevators");
  if (nr || ne || nj || nv) lines.push(`brought in ${[nr && plural(nr, "room"), ne && plural(ne, "exit"), nj && plural(nj, "edge"), nv && plural(nv, "elevator")].filter(Boolean).join(", ")} from the world`);
  // What the world changed that the map took: renames, new descriptions, moves, retypes, removals.
  for (const c of ["areas", "rooms", "exits", "edges", "elevators"]) {
    const p = theirs[c];
    if (!p) continue;
    const put = p.put.filter((o) => !adopted.has(o.id)), del = p.del;
    const add = p.add.filter((o) => !adopted.has(o.id));
    const label = (o) => (o.name ? `${o.id} "${o.name}"` : o.id);
    if (put.length) lines.push(`took the world's changes to ${put.length === 1 ? c.slice(0, -1) : c} ${put.slice(0, 8).map(label).join(", ")}${put.length > 8 ? ", …" : ""}`);
    if (add.length) lines.push(`took ${plural(add.length, c.slice(0, -1))} the world added: ${add.slice(0, 8).map(label).join(", ")}`);
    if (del.length) lines.push(`removed ${del.length === 1 ? c.slice(0, -1) : c} ${del.slice(0, 8).join(", ")}${del.length > 8 ? ", …" : ""}, gone from the world`);
  }
  if (kept.length) lines.push(`kept the map's own version of ${kept.join(", ")} (changed here and in the world; map_publish writes the map's)`);
  lines.push(...conflicts);
  if (proj.gone.areas.length) lines.push(`area${proj.gone.areas.length === 1 ? "" : "s"} ${proj.gone.areas.join(", ")} no longer exist in the world; unlinked (publishing makes them again)`);
  if (proj.external.length) lines.push(`${plural(proj.external.length, "exit")} lead out of the map's areas: ${proj.external.slice(0, 6).map((x) => `${x.room ?? x.moo} ${x.dir} → "${x.to_name}" (${x.to_area_name || x.to_area})`).join(", ")}${proj.external.length > 6 ? ", …" : ""}`);
  return { doc: merged, link, lines, proj };
}

/** Area ids as a list, however the call spelled them: a list, a JSON list in a string, or ids split by commas or spaces. */
function areaList(v) {
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) { try { v = JSON.parse(t); } catch { v = t.slice(1, -1).split(/[\s,"']+/); } }
    else v = t.split(/[\s,]+/);
  }
  return [...new Set((Array.isArray(v) ? v : [v]).filter(given).map((x) => String(x).trim()).filter(Boolean))];
}

export async function mapImport(args, env) {
  const ids = areaList(args.areas);
  if (!ids.length) fail("areas: give the MOO ids of the areas to bring in (map_world_areas lists them).");
  const conn = await connect(env);
  const existing = given(args.map) ? await resolveMap(env, args.map) : null;
  const probe = await snapshot(conn, ids);
  const missing = probe.areas.filter((a) => a.missing).map((a) => a.id);
  if (missing.length) fail(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not an area in the world. map_world_areas lists them.`);
  const taken = new Map();
  for (const m of await listMaps(env)) for (const moo of Object.values(m.link.areas)) taken.set(moo, m.id);
  const clash = probe.areas.filter((a) => taken.has(a.id) && taken.get(a.id) !== existing?.id);
  if (clash.length && !args.allow_shared) fail(`${clash.map((a) => `${a.id} "${a.name}" is already on map ${taken.get(a.id)}`).join("; ")}. Two maps publishing the same area undo each other's work: use that map, or pass allow_shared: true.`);
  // The whole of the map's areas, old and new, so the pull sees every exit between them.
  const snap = existing ? await snapshot(conn, [...new Set([...Object.values(existing.link.areas), ...probe.areas.map((a) => a.id)])], Object.values(existing.link.elevators ?? {})) : probe;

  let record;
  if (existing) {
    record = existing;
  } else {
    const name = String(args.name ?? probe.areas.map((a) => a.name).join(" + ")).slice(0, 200);
    // Made with a placeholder area a1, which becomes the first imported one below.
    record = await createMap(env, { doc: completeDoc({ name, areas: [{ id: "a1", name: probe.areas[0].name }] }), ...agent(env), what: `imported ${ids.join(", ")}` });
  }
  const fresh = !given(args.map);
  const next = await mutate(env, record.id, async (cur) => {
    let doc = { ...cur.doc, areas: [...cur.doc.areas] };
    const link = { ...cur.link, areas: { ...cur.link.areas } };
    let n = doc.nextId;
    probe.areas.forEach((a, i) => {
      if (Object.values(link.areas).includes(a.id)) return;
      const local = fresh && i === 0 ? "a1" : `a${n++}`;
      if (!(fresh && i === 0)) doc.areas.push({ id: local, name: a.name });
      link.areas[local] = a.id;
    });
    doc.nextId = n;
    const pulled = pullInto(snap, { ...cur, doc, link });
    record.lines = pulled.lines;
    return { doc: pulled.doc, link: pulled.link, what: `imported ${probe.areas.map((a) => a.name).join(", ")}` };
  }, agent(env));
  return bounded([
    `${fresh ? "Made" : "Added to"} map ${next.id} "${next.doc.name}" from the world, rev ${next.rev}: ${plural(next.doc.rooms.length, "room")}, ${plural(next.doc.exits.length, "exit")}. It is linked: map_publish writes your edits back to these areas, map_pull brings in changes made in the world.`,
    ...record.lines.map((l) => `- ${l}`),
    "",
    textMap(next),
  ].join("\n"));
}

export async function mapPull(args, env) {
  const record = await resolveMap(env, args.map);
  if (!Object.keys(record.link.areas).length) fail(`${record.id} is not linked to the world yet: map_publish makes it, or map_import brings areas in.`);
  const conn = await connect(env);
  const snap = await snapshot(conn, Object.values(record.link.areas), Object.values(record.link.elevators ?? {}));
  let lines = [];
  const next = await mutate(env, record.id, async (cur) => {
    const pulled = pullInto(snap, cur);
    lines = pulled.lines;
    return { doc: pulled.doc, link: pulled.link, what: "pulled from the world" };
  }, agent(env));
  return bounded([`Pulled ${next.id} from the world, rev ${next.rev}. ${publishState(next).label}.`, ...(lines.length ? lines : ["the world had nothing new"]).map((l) => `- ${l}`)].join("\n"));
}

/** Moves in an order that never lands a room on a cell another still holds; a cycle goes via a spare level. */
export function orderMoves(moves, occupied) {
  const key = (o) => `${o.area}:${o.x},${o.y},${o.z}`;
  const occ = new Map(occupied);
  const pending = [...moves];
  const out = [];
  let spare = 0;
  while (pending.length) {
    const i = pending.findIndex((m) => { const o = occ.get(key({ area: m.ref.area, x: m.x, y: m.y, z: m.z })); return !o || o === m.local; });
    if (i >= 0) {
      const [m] = pending.splice(i, 1);
      occ.delete(key(m.from));
      occ.set(key({ area: m.ref.area, x: m.x, y: m.y, z: m.z }), m.local);
      out.push(m);
      m.from = { ...m.from };
      continue;
    }
    // A cycle: park the first one far below everything, and move it home once the cycle unwinds.
    const m = pending[0];
    const park = { ...m, z: 90000 + spare++, ref: { room: m.ref.room, area: m.from.area }, x: m.from.x, y: m.from.y, parked: true };
    occ.delete(key(m.from));
    occ.set(key({ area: m.from.area, x: park.x, y: park.y, z: park.z }), m.local);
    out.push(park);
    pending[0] = { ...m, from: { area: m.from.area, x: park.x, y: park.y, z: park.z } };
  }
  return out;
}

async function saveLink(env, id, link, what) {
  return mutate(env, id, () => ({ link, what }), agent(env));
}

export async function mapPublish(args, env) {
  const record = await resolveMap(env, args.map);
  const doc = record.doc;
  const conn = await connect(env);
  const snap = await snapshot(conn, Object.values(record.link.areas), Object.values(record.link.elevators ?? {}));
  if (!snap.shaper) fail(`the MOO character ${snap.character} is not a Shaper, so the world will not take map writes from it (the website cartographer has the same gate).`);
  const proj = project(snap, record.link, { keep: doc });
  const plan = planPublish(doc, proj, record.link, record.link.published);
  const out = [];
  const foreign = [
    ...proj.foreign.rooms.filter((f) => !Object.values(plan.adopt.rooms).includes(f.moo)).map((f) => `room ${f.moo} "${f.name}" (${f.x},${f.y},${f.z}) in ${f.area}`),
    ...proj.foreign.exits.filter((f) => !Object.values(plan.adopt.exits).includes(f.moo)).map((f) => `exit ${f.moo} ${f.dir} between ${f.a} and ${f.b}`),
    ...proj.foreign.edges.map((f) => `edge ${f.moo} ${f.dir} from ${f.from}`),
    ...proj.foreign.elevators.map((f) => `elevator ${f.moo} "${f.name}" (${f.stops.join(", ")})`),
  ];
  const all = Object.values(plan.phases).flat();
  if (args.dry_run || !all.length) {
    out.push(all.length ? `Dry run: publishing ${record.id} "${doc.name}" rev ${record.rev} would make ${plural(all.length, "change")} in the world:` : `${record.id} "${doc.name}" rev ${record.rev}: the world already matches the map; nothing to publish.`);
    for (const [phase, list] of Object.entries(plan.phases)) if (list.length) out.push(`${phase}:`, ...list.map((o) => `- ${describeOp(o, doc)}`));
    if (plan.notes.length) out.push("notes:", ...plan.notes.map((n) => `- ${n}`));
    if (foreign.length) out.push(`in the world but not on the map (publish leaves them; map_pull brings them in): ${foreign.slice(0, 20).join("; ")}${foreign.length > 20 ? "; …" : ""}`);
    if (!all.length && !args.dry_run) {
      const link = { ...record.link, published: remoteDoc(proj, doc), publishedRev: record.rev, publishedAt: new Date().toISOString(), external: proj.external, character: snap.character };
      await saveLink(env, record.id, link, "checked against the world");
    }
    return bounded(out.join("\n"));
  }

  const link = JSON.parse(JSON.stringify({ areas: record.link.areas, rooms: record.link.rooms, exits: record.link.exits, edges: record.link.edges, elevators: record.link.elevators ?? {} }));
  for (const local of proj.gone.elevators) delete link.elevators[local];
  for (const local of proj.gone.areas) delete link.areas[local];
  for (const [k, v] of Object.entries(plan.adopt.rooms)) link.rooms[k] = v;
  for (const [k, v] of Object.entries(plan.adopt.exits)) link.exits[k] = v;
  // Rooms linked to objects gone from the world are made again: forget the dead ids.
  for (const op of plan.phases.rooms) if (op.op === "room_create") delete link.rooms[op.local];
  for (const op of plan.phases.joins) if (op.op === "exit_create") delete link.exits[op.local];
  for (const op of plan.phases.joins) if (op.op === "edge_create") delete link.edges[op.local];

  const done = [], failed = [];
  const run = async (phase, list) => {
    if (!list.length) return;
    const ready = [], idx = [];
    list.forEach((op, i) => {
      const r = resolveOp(op, link);
      if (r.error) failed.push(`${describeOp(op, doc)}: ${r.error}`);
      else { if (args.force && op.op === "room_delete") r.op.force = 1; ready.push(r.op); idx.push(i); }
    });
    const results = await runOps(conn, Object.values(link.areas), ready);
    results.forEach((res, j) => {
      const op = list[idx[j]];
      if (res.ok) { linkAfter(link, op, res); done.push(describeOp(op, doc)); }
      else failed.push(`${describeOp(op, doc)}: ${res.error}${res.unknown ? " (it may have run: map_status shows the world)" : ""}`);
    });
    await saveLink(env, record.id, { ...(await needMap(env, record.id)).link, ...link }, `publishing: ${phase}`);
  };

  let stopped = null;
  try {
    await run("areas", plan.phases.areas);
    await run("removals", plan.phases.removals);
    const occupied = proj.remote.rooms.filter((r) => !plan.phases.removals.some((o) => o.op === "room_delete" && o.local === r.id)).map((r) => [`${r.area}:${r.x},${r.y},${r.z}`, r.id]);
    await run("moves", orderMoves(plan.phases.moves, occupied));
    await run("rooms", plan.phases.rooms);
    await run("joins", plan.phases.joins);
    await run("elevators", plan.phases.elevators);
  } catch (e) {
    stopped = e.message;
  }

  // Read the world back: what it holds now is what the map was published as.
  const after = await snapshot(conn, Object.values(link.areas), Object.values(link.elevators));
  const now = await needMap(env, record.id);
  const proj2 = project(after, { ...now.link, ...link }, { keep: doc });
  const published = remoteDoc(proj2, doc);
  const saved = await saveLink(env, record.id, { ...now.link, ...link, published, publishedRev: record.rev, publishedAt: new Date().toISOString(), external: proj2.external, character: after.character }, `published rev ${record.rev}: ${done.length} done${failed.length ? `, ${failed.length} failed` : ""}`);
  const state = publishState({ ...saved, doc });
  out.push(`Published ${record.id} "${doc.name}" rev ${record.rev} to the world: ${plural(done.length, "change")} made${failed.length ? `, ${failed.length} FAILED` : ""}. ${state.label}.`);
  if (stopped) out.push(`STOPPED: ${stopped}`);
  if (failed.length) out.push("failed:", ...failed.map((f) => `- ${f}`));
  out.push("done:", ...done.map((d) => `- ${d}`));
  if (plan.notes.length) out.push("notes:", ...plan.notes.map((n) => `- ${n}`));
  if (foreign.length) out.push(`left alone, in the world but not on the map: ${foreign.slice(0, 20).join("; ")}`);
  out.push(`areas in the world: ${doc.areas.map((a) => `${a.id} "${a.name}" = ${link.areas[a.id] ?? "(not made)"}`).join(", ")}`);
  if (proj2.external.length === 0 && doc.rooms.length) out.push("No exit joins these areas to the rest of the world yet: they are an island until one does (moo_build_link, or @dig in the game).");
  return bounded(out.join("\n"));
}

export async function mapStatus(args, env) {
  const record = await resolveMap(env, args.map);
  const out = [header(record)];
  if (!Object.keys(record.link.areas).length) {
    out.push("Not in the world yet. map_publish (dry_run first) shows what it would make.");
    return out.join("\n");
  }
  const conn = await connect(env);
  const snap = await snapshot(conn, Object.values(record.link.areas), Object.values(record.link.elevators ?? {}));
  const proj = project(snap, record.link, { keep: record.doc });
  const plan = planPublish(record.doc, proj, record.link, record.link.published);
  const world = remoteDoc(proj, record.doc);
  // Drift: what changed in the world since the map last saw it.
  const drift = [];
  if (record.link.published) {
    const { theirs } = mergePull(record.doc, record.link.published, world);
    for (const c of ["areas", "rooms", "exits", "edges", "elevators"]) {
      const p = theirs[c];
      if (p) for (const [k, list] of [["added", p.add], ["changed", p.put]]) if (list.length) drift.push(`${list.length} ${c} ${k} (${list.slice(0, 5).map((o) => o.id).join(", ")})`);
      if (p?.del?.length) drift.push(`${p.del.length} ${c} gone (${p.del.slice(0, 5).join(", ")})`);
    }
  }
  const nf = proj.foreign.rooms.length + proj.foreign.exits.length + proj.foreign.edges.length;
  out.push(`world: ${snap.areas.filter((a) => !a.missing).map((a) => `${a.id} "${a.name}" ${plural(a.rooms.length, "room")}`).join(", ")}`);
  out.push(plan.total ? `publishing now would make ${plural(plan.total, "change")} (${Object.entries(plan.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ")}); map_publish dry_run lists them.` : "the world matches the map.");
  if (drift.length) out.push(`changed in the world since the last sync: ${drift.join("; ")}. map_pull brings it in.`);
  if (nf) out.push(`in the world, not on the map: ${plural(proj.foreign.rooms.length, "room")}, ${plural(proj.foreign.exits.length, "exit")}, ${plural(proj.foreign.edges.length, "edge")}. map_pull brings them in.`);
  if (proj.gone.areas.length) out.push(`linked areas gone from the world: ${proj.gone.areas.join(", ")}`);
  if (proj.foreign.elevators.length) out.push(`elevators stopping here that the map does not have: ${proj.foreign.elevators.map((f) => `${f.moo} "${f.name}" (${f.stops.join(", ")})`).join("; ")}. map_pull brings them in.`);
  if (proj.gone.elevators.length) out.push(`linked elevators gone from the world: ${proj.gone.elevators.join(", ")} (publishing makes them again)`);
  if (record.doc.elevators.length && !snap.elevator_api) out.push(`the MOO has no elevator system yet, so the map's ${plural(record.doc.elevators.length, "elevator")} wait${record.doc.elevators.length === 1 ? "s" : ""} for it.`);
  const players = proj.remote.rooms.filter((r) => r.players);
  if (players.length) out.push(`players are in: ${players.map((r) => `${r.id} "${r.name}" (${r.players})`).join(", ")}`);
  if (proj.external.length) out.push(`exits out of the map: ${proj.external.slice(0, 10).map((x) => `${x.room ?? x.moo} ${x.dir} → ${x.to} "${x.to_name}" (${x.to_area_name || x.to_area})`).join(", ")}`);
  return bounded(out.join("\n"));
}

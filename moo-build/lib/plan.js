// From what a build is and what the caller wants it to be, to the operations
// that get it there. Pure: nothing here talks to the MOO, so every rule is
// tested without a server.
//
// The point of the coordinate view is that a room's exits are a set of compass
// directions, and the direction alone says where each one goes: `e` from (2,3,0)
// is the room at (3,3,0). So an exit list is declarative. It is the whole set
// of that room's exits to its neighbours in this build, and the plan adds and
// removes pairs until the build matches it. Exits that leave the build, and
// `in`/`out`, are never touched by it: those are explicit acts (link, unlink).
//
// A request is checked completely before anything is planned, and a plan with
// any error is not run, so a mistake costs a reply rather than half a build.

import { DIRS, OPPOSITE, cellOf, dirOf, dirBetween, step } from "./grid.js";
import { EXIT_TYPES } from "./source.js";

/** The id form tostr() gives: `#123`, or `#0011E5-9CB7359F34` in upper case. */
export function normalizeId(value) {
  const v = String(value ?? "").trim();
  if (/^#?\d+$/.test(v)) return `#${v.replace(/^#/, "")}`;
  if (/^#?[0-9A-Fa-f]{6}-[0-9A-Fa-f]{10}$/.test(v)) return `#${v.replace(/^#/, "").toUpperCase()}`;
  return undefined;
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const text = (v) => (Array.isArray(v) ? v.map(String).join("\n") : String(v ?? ""));

/** A snapshot as the MOO returned it, made ready for the planner and the picture. */
export function normalize(raw) {
  const rooms = (raw?.rooms ?? []).map((r) => ({
    id: String(r.id), name: String(r.name ?? ""), x: int(r.x), y: int(r.y), z: int(r.z),
    description: text(r.description), parent: r.parent, players: int(r.players),
    edges: Array.isArray(r.edges) ? r.edges : [],
    exits: (Array.isArray(r.exits) ? r.exits : []).map((e) => ({
      id: String(e.id), dir: String(e.dir ?? ""), compass: dirOf(e.dir), twin: String(e.twin ?? "#-1"),
      to: String(e.to ?? "#-1"), to_name: String(e.to_name ?? ""), to_area: String(e.to_area ?? "#-1"), to_area_name: String(e.to_area_name ?? ""),
      type: String(e.type ?? "open"), hidden: Boolean(Number(e.hidden)),
    })),
  }));
  const byId = new Map(rooms.map((r) => [r.id, r]));
  for (const r of rooms) {
    for (const e of r.exits) {
      e.inBuild = byId.has(e.to);
      e.adjacent = Boolean(e.inBuild && e.compass && dirBetween(r, byId.get(e.to)) === e.compass);
    }
  }
  return {
    id: String(raw?.id ?? ""), name: String(raw?.name ?? ""), parent: raw?.parent,
    authored: Boolean(Number(raw?.authored)), character: raw?.character, rooms,
  };
}

const fmt = (c) => `(${c.x},${c.y},${c.z})`;
const hasCoords = (s) => s.x !== undefined || s.y !== undefined || s.z !== undefined;

/**
 * Find one room of the build from `{room}` or `{x, y, z}`. Answers
 * `{ room }`, `{ cell }` for an empty cell, or `{ error }`.
 */
export function locate(build, spec, where) {
  if (spec?.room !== undefined && spec.room !== null && spec.room !== "") {
    const id = normalizeId(spec.room);
    const room = id && build.rooms.find((r) => r.id === id);
    if (!room) return { error: `${where}: room ${JSON.stringify(spec.room)} is not part of build ${build.id} "${build.name}"` };
    if (hasCoords(spec) && (spec.x !== room.x || spec.y !== room.y || (spec.z ?? 0) !== room.z)) {
      return { error: `${where}: room ${room.id} is at ${fmt(room)}, not ${fmt({ x: spec.x, y: spec.y, z: spec.z ?? 0 })}. Rooms are not moved; delete it and set a new one, or give only one of room and x/y/z.` };
    }
    return { room, cell: { x: room.x, y: room.y, z: room.z } };
  }
  if (!Number.isInteger(spec?.x) || !Number.isInteger(spec?.y) || (spec.z !== undefined && !Number.isInteger(spec.z))) {
    return { error: `${where}: give integer x and y (z defaults to 0), or the room's id` };
  }
  const cell = { x: spec.x, y: spec.y, z: spec.z ?? 0 };
  const room = build.rooms.find((r) => r.x === cell.x && r.y === cell.y && r.z === cell.z);
  return room ? { room, cell } : { cell };
}

/** Parse an exit list: `["n", "e", {"dir": "down", "type": "climb", "hidden": true}]`. */
function parseExits(list, where, errors) {
  if (!Array.isArray(list)) {
    errors.push(`${where}.exits: must be a list of directions, e.g. ["n", "e", {"dir": "down", "type": "door"}]`);
    return undefined;
  }
  const out = new Map();
  list.forEach((item, j) => {
    const raw = typeof item === "string" ? { dir: item } : item;
    const dir = dirOf(raw?.dir);
    if (!dir) {
      errors.push(`${where}.exits[${j}]: ${JSON.stringify(raw?.dir ?? item)} is not a direction; use one of ${Object.keys(DIRS).join(" ")}`);
      return;
    }
    if (out.has(dir)) errors.push(`${where}.exits: ${dir} is listed twice`);
    if (raw.type !== undefined && !EXIT_TYPES.includes(raw.type)) errors.push(`${where}.exits[${j}]: type must be one of ${EXIT_TYPES.join(", ")}`);
    if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") errors.push(`${where}.exits[${j}]: hidden must be true or false`);
    out.set(dir, { type: raw.type, hidden: raw.hidden });
  });
  return out;
}

/**
 * Plan a set of room writes. Each spec is `{x, y, z?}` or `{room}`, plus any of
 * `name`, `description` and `exits`. An empty cell is created (a name is
 * required); an existing room is updated. Answers `{ errors }` or `{ ops }`,
 * the ops in the order they must run: unlinks, creates, updates, links, hides.
 */
export function planSetRooms(build, specs) {
  const errors = [];
  if (!Array.isArray(specs) || !specs.length) return { errors: ["rooms: give at least one room"] };

  const slots = [];
  const taken = new Map();
  specs.forEach((spec, i) => {
    const where = `rooms[${i}]`;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return errors.push(`${where}: must be an object`);
    const found = locate(build, spec, where);
    if (found.error) return errors.push(found.error);
    const ref = found.room ? found.room.id : `new:${cellOf(found.cell)}`;
    if (taken.has(ref)) return errors.push(`${where}: names the same room as rooms[${taken.get(ref)}]`);
    taken.set(ref, i);
    if (spec.name !== undefined && (typeof spec.name !== "string" || !spec.name.trim())) errors.push(`${where}: name must be a non-empty string`);
    if (!found.room && spec.name === undefined) errors.push(`${where}: ${fmt(found.cell)} is empty, so this creates a room there, and a new room needs a name`);
    if (spec.description !== undefined && typeof spec.description !== "string") errors.push(`${where}: description must be a string`);
    const exits = spec.exits === undefined ? undefined : parseExits(spec.exits, where, errors);
    slots.push({ i, where, spec, ref, cell: found.cell, room: found.room, exits });
  });
  if (errors.length) return { errors };

  // The build as it will be once the new rooms exist.
  const refAt = new Map(build.rooms.map((r) => [cellOf(r), r.id]));
  for (const s of slots) if (!s.room) refAt.set(cellOf(s.cell), s.ref);
  const byId = new Map(build.rooms.map((r) => [r.id, r]));
  const declared = new Map(slots.filter((s) => s.exits).map((s) => [s.ref, s]));

  // Pass 1: the pairs a declaring room no longer wants.
  const unlinks = new Map();
  const gone = new Set();
  const unlink = (room, e, why) => {
    if (gone.has(e.id)) return;
    gone.add(e.id);
    if (e.twin !== "#-1") gone.add(e.twin);
    unlinks.set(e.id, { op: "unlink", exit: e.id, from: room.id, dir: e.compass ?? e.dir, to: e.to, to_area: e.to_area, why });
  };
  for (const s of slots) {
    if (!s.exits || !s.room) continue;
    for (const e of s.room.exits) {
      if (!e.inBuild || !e.compass) continue;
      const want = s.exits.get(e.compass);
      const target = refAt.get(cellOf(step(s.cell, e.compass)));
      const keep = want && e.to === target && (want.type === undefined || want.type === e.type);
      if (keep) continue;
      const far = declared.get(e.to);
      if (!want && far && far.exits.has(OPPOSITE[e.compass]) && e.adjacent) {
        errors.push(`${s.where} leaves out ${e.compass}, but ${far.where} wants its ${OPPOSITE[e.compass]} exit back to it: the same pair cannot be kept and removed`);
        continue;
      }
      unlink(s.room, e, !want ? "not listed" : e.to !== target ? "led to the wrong room" : `type ${e.type} → ${want.type}`);
    }
  }

  // Pass 2: the pairs a declaring room wants and does not have.
  const links = new Map();
  const hides = [];
  for (const s of slots) {
    if (!s.exits) continue;
    for (const [dir, want] of s.exits) {
      const nb = step(s.cell, dir);
      const target = refAt.get(cellOf(nb));
      if (!target) {
        errors.push(`${s.where}: exit ${dir} needs a room at ${fmt(nb)}, and this build has none there. Add that room in this call, or leave ${dir} out.`);
        continue;
      }
      const far = declared.get(target);
      const opp = OPPOSITE[dir];
      if (far && !far.exits.has(opp)) {
        errors.push(`${s.where} wants an exit ${dir} to ${fmt(nb)}, but ${far.where} (that room) leaves out ${opp}. List both sides or neither.`);
        continue;
      }
      const farWant = far?.exits.get(opp);
      if (want.type && farWant?.type && want.type !== farWant.type) errors.push(`${s.where} and ${far.where} disagree about the type of the exit between them (${want.type} vs ${farWant.type})`);
      if (want.hidden !== undefined && farWant?.hidden !== undefined && want.hidden !== farWant.hidden) errors.push(`${s.where} and ${far.where} disagree about whether the exit between them is hidden`);

      const cur = s.room?.exits.find((e) => e.compass === dir && !gone.has(e.id));
      if (cur && !cur.inBuild) {
        errors.push(`${s.where}: the ${dir} exit (${cur.id}) of ${s.room.id} "${s.room.name}" leads out of this build, to ${cur.to} "${cur.to_name}". Remove it with moo_build_unlink first, or use another direction.`);
        continue;
      }
      if (cur) {
        // Kept by pass 1, so it already goes to the right room with the right type.
        const hidden = want.hidden ?? farWant?.hidden;
        if (hidden !== undefined && hidden !== cur.hidden && !hides.some((h) => h.exit === cur.id || h.exit === cur.twin)) {
          hides.push({ op: "hide", exit: cur.id, hidden, from: s.room.id, dir });
        }
        continue;
      }
      const farRoom = byId.get(target);
      const back = farRoom?.exits.find((e) => e.compass === opp && !gone.has(e.id));
      if (back) {
        errors.push(
          `${s.where}: ${farRoom.id} "${farRoom.name}" at ${fmt(nb)} already has a ${opp} exit, to ${back.to === "#-1" ? "nowhere (a broken twin)" : `${back.to} "${back.to_name}"`}. ` +
            `Remove it with moo_build_unlink, or include that room in this call with ${opp} left out.`,
        );
        continue;
      }
      const pair = [s.ref, target].sort().join("|");
      if (links.has(pair)) continue;
      links.set(pair, { op: "link", from: s.ref, to: target, dir, type: want.type ?? farWant?.type ?? "open", hidden: want.hidden ?? farWant?.hidden ?? false });
    }
  }
  if (errors.length) return { errors };

  const creates = slots.filter((s) => !s.room).map((s) => ({
    op: "create", ref: s.ref, ...s.cell, name: s.spec.name.trim(),
    ...(s.spec.description !== undefined ? { description: s.spec.description } : {}),
  }));
  const updates = slots
    .filter((s) => s.room && (s.spec.name !== undefined || s.spec.description !== undefined))
    .filter((s) => (s.spec.name !== undefined && s.spec.name.trim() !== s.room.name) || (s.spec.description !== undefined && s.spec.description !== s.room.description))
    .map((s) => ({
      op: "update", room: s.room.id,
      ...(s.spec.name !== undefined && s.spec.name.trim() !== s.room.name ? { name: s.spec.name.trim() } : {}),
      ...(s.spec.description !== undefined && s.spec.description !== s.room.description ? { description: s.spec.description } : {}),
    }));
  return { ops: [...unlinks.values(), ...creates, ...updates, ...links.values(), ...hides] };
}

/** Plan room deletions: each spec is `{room}` or `{x, y, z?}` and must be in the build. */
export function planDeleteRooms(build, specs) {
  const errors = [];
  if (!Array.isArray(specs) || !specs.length) return { errors: ["rooms: give at least one room"] };
  const seen = new Set();
  const ops = [];
  specs.forEach((spec, i) => {
    const where = `rooms[${i}]`;
    const found = locate(build, spec, where);
    if (found.error) return errors.push(found.error);
    if (!found.room) return errors.push(`${where}: there is no room at ${fmt(found.cell)} in this build`);
    if (seen.has(found.room.id)) return;
    seen.add(found.room.id);
    if (found.room.players) errors.push(`${where}: ${found.room.id} "${found.room.name}" has ${found.room.players} player(s) in it; a room with a player in it is not deleted`);
    ops.push({ op: "delete", room: found.room.id, name: found.room.name, cell: { x: found.room.x, y: found.room.y, z: found.room.z } });
  });
  return errors.length ? { errors } : { ops };
}

/**
 * Plan one explicit link. Without `to` it joins the room at `from` to its
 * neighbour in `dir`; with `to` it may go anywhere: another cell of this build,
 * or a room outside it, which is how a build is joined to the rest of the world.
 */
export function planLink(build, { from, dir, to, type, hidden }) {
  const found = locate(build, from ?? {}, "from");
  if (found.error) return { errors: [found.error] };
  if (!found.room) return { errors: [`from: there is no room at ${fmt(found.cell)} in this build`] };
  const d = dirOf(dir);
  if (!d) return { errors: [`dir: ${JSON.stringify(dir)} is not a direction; use one of ${Object.keys(DIRS).join(" ")}`] };
  if (type !== undefined && !EXIT_TYPES.includes(type)) return { errors: [`type must be one of ${EXIT_TYPES.join(", ")}`] };
  const here = found.room;
  const taken = here.exits.find((e) => e.compass === d);
  if (taken) return { errors: [`${here.id} "${here.name}" already has a ${d} exit, to ${taken.to} "${taken.to_name}" (exit ${taken.id})`] };

  let target, outside = false;
  if (to === undefined || to === null || to === "") {
    const nb = step(found.cell, d);
    const there = build.rooms.find((r) => cellOf(r) === cellOf(nb));
    if (!there) return { errors: [`there is no room ${d} of ${fmt(found.cell)}, at ${fmt(nb)}. Give \`to\` to link somewhere that is not the neighbouring cell.`] };
    target = there.id;
  } else {
    target = normalizeId(to);
    if (!target) return { errors: [`to: ${JSON.stringify(to)} is not an object id such as #123`] };
    if (target === here.id) return { errors: ["a room cannot have an exit to itself"] };
    outside = !build.rooms.some((r) => r.id === target);
    const there = build.rooms.find((r) => r.id === target);
    const back = there?.exits.find((e) => e.compass === OPPOSITE[d]);
    if (back) return { errors: [`${there.id} "${there.name}" already has a ${OPPOSITE[d]} exit (${back.id})`] };
  }
  return { ops: [{ op: "link", from: here.id, to: target, dir: d, type: type ?? "open", hidden: Boolean(hidden), outside }] };
}

/** Plan one unlink, from `{exit}` or from a room and a direction. */
export function planUnlink(build, { exit, from, dir }) {
  if (exit !== undefined && exit !== null && exit !== "") {
    const id = normalizeId(exit);
    for (const r of build.rooms) {
      const e = r.exits.find((x) => x.id === id);
      if (e) return { ops: [{ op: "unlink", exit: e.id, from: r.id, dir: e.compass ?? e.dir, to: e.to, to_area: e.to_area }] };
    }
    return { errors: [`exit ${JSON.stringify(exit)} is not an exit of any room in this build`] };
  }
  const found = locate(build, from ?? {}, "from");
  if (found.error) return { errors: [found.error] };
  if (!found.room) return { errors: [`from: there is no room at ${fmt(found.cell)} in this build`] };
  const d = dirOf(dir) ?? String(dir ?? "").trim().toLowerCase();
  const e = found.room.exits.find((x) => (x.compass ?? x.dir.toLowerCase()) === d);
  if (!e) {
    const have = found.room.exits.map((x) => x.compass ?? x.dir).join(" ") || "none";
    return { errors: [`${found.room.id} "${found.room.name}" has no ${d || "such"} exit; its exits are: ${have}`] };
  }
  return { ops: [{ op: "unlink", exit: e.id, from: found.room.id, dir: e.compass ?? e.dir, to: e.to, to_area: e.to_area }] };
}


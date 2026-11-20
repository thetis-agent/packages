// MOO source for every build operation, built from literals and never
// interpolated from caller text.
//
// Each operation is one task with its own authority check at the top, so a
// call that reaches the MOO by some other route still cannot touch an area that
// is not one of the character's builds. The steps mirror the Shaper Feature's
// own verbs (#272:@dig, @build, @open) and $building_utils:make_exit_pair, so a
// room made here is indistinguishable from one a builder dug by hand.

import { LONG, OPPOSITE } from "./grid.js";

/** A JSON value as a MOO literal: strings escaped, so a quote stays a quote. */
export function lit(value) {
  if (value === null || value === undefined) return "0";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot encode a non-finite number");
    return String(value);
  }
  if (typeof value === "string") {
    // A program is one line, so a stray newline becomes a space: a description
    // that means to have lines arrives here already split into a list.
    return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/[\n\t]/g, " ") + '"';
  }
  if (Array.isArray(value)) return `{${value.map(lit).join(", ")}}`;
  throw new Error(`cannot encode ${typeof value} as a MOO literal`);
}

/**
 * A description as the MOO stores it. One paragraph stays a string; several
 * become a list of lines, the form $root:set_description and `look` already
 * understand, so no newline escape ever has to survive the parser.
 */
export function descriptionValue(text) {
  const s = String(text ?? "").replace(/\r/g, "");
  return s.includes("\n") ? s.split("\n") : s;
}

/**
 * An object reference as a MOO expression: `#123`, a UUID id
 * `#0011E5-9CB7359F34`, the mapper's bare form of either, or a corified `$name`.
 * Anything else is refused, which is the injection check for ids.
 */
export function objRef(value, what = "object") {
  const v = String(value ?? "").trim();
  if (/^#?\d+$/.test(v)) return `#${v.replace(/^#/, "")}`;
  if (/^#?[0-9A-Fa-f]{6}-[0-9A-Fa-f]{10}$/.test(v)) return `toobj(${lit("#" + v.replace(/^#/, "").toUpperCase())})`;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(v)) return v;
  throw new Error(`${what} must be an object id such as #123 or #0011E5-9CB7359F34, got ${JSON.stringify(v)}`);
}

// typeof(#0) rather than a type constant: it reads the same on every core.
const isObj = (expr) => `(typeof(${expr}) == typeof(#0))`;

/** Resolve `area`, and refuse unless it is an $area in the character's .builds. */
export function guard(build) {
  return (
    `area = ${objRef(build, "build")}; ` +
    `if (!${isObj("area")} || !valid(area)) raise(E_INVARG, tostr("build ", ${lit(String(build))}, " is not a valid object")); endif ` +
    `if (!$ou:isa(area, $area)) raise(E_INVARG, tostr(area, " is not an area (a descendant of $area)")); endif ` +
    `if (!(area in \`player.builds ! ANY => {}')) raise(E_PERM, tostr(area.name, " (", area, ") is not one of ", player.name, "'s builds, so it cannot be authored here. A build is an area listed in ", player, ".builds.")); endif `
  );
}

/** Bind `name` to a room and refuse unless it belongs to `area`. */
function roomIn(name, ref) {
  return (
    `${name} = ${objRef(ref, "room")}; ` +
    `if (!${isObj(name)} || !valid(${name})) raise(E_INVARG, tostr("room ", ${lit(String(ref))}, " is not a valid object")); endif ` +
    `if (\`${name}.area ! ANY => #-1' != area) raise(E_PERM, tostr(${name}, " is not part of this build (", area, ")")); endif `
  );
}

/** Raise when a $root setter answered with an error value instead of raising. */
const checked = (call) => `r = ${call}; if (typeof(r) == typeof(E_PERM)) raise(r, tostr(${lit(call)}, " => ", r)); endif `;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The builds of the character, or with `all` every area that has rooms. */
export function listSource({ all = false } = {}) {
  return (
    `builds = \`player.builds ! ANY => E_PROPNF'; has = typeof(builds) == typeof({}); if (!has) builds = {}; endif ` +
    `pool = ${all ? "$ou:descendants($area)" : "builds"}; out = {}; ` +
    `for a in (pool) ` +
    `if (!${isObj("a")} || !valid(a)) continue; endif ` +
    `n = length(\`a.rooms ! ANY => {}'); mine = a in builds; ` +
    `if (!mine && n == 0) continue; endif ` +
    `out = {@out, ["id" -> tostr(a), "name" -> a.name, "rooms" -> n, "authored" -> mine ? 1 | 0, "parent" -> tostr(parent(a))]}; ` +
    `endfor ` +
    `return ["character" -> tostr(player), "character_name" -> player.name, "has_builds" -> has ? 1 | 0, "areas" -> out];`
  );
}

/**
 * Everything the coordinate view needs about one area, in one task. Exits
 * carry their twin and the twin's room, which is how $exit:dest_for finds a
 * destination, so a broken twin shows up as `#-1` rather than vanishing.
 */
export function snapshotSource(build, { authority = true } = {}) {
  const head = authority
    ? guard(build)
    : `area = ${objRef(build, "build")}; ` +
      `if (!${isObj("area")} || !valid(area) || !$ou:isa(area, $area)) raise(E_INVARG, tostr("build ", ${lit(String(build))}, " is not a valid area")); endif `;
  return (
    head +
    `rooms = {}; ` +
    `for r in (\`area.rooms ! ANY => {}') ` +
    `if (!${isObj("r")} || !valid(r)) continue; endif ` +
    `exits = {}; ` +
    `for e in (\`r.exits ! ANY => {}') ` +
    `if (!valid(e)) continue; endif ` +
    `t = \`e.twin ! ANY => #-1'; d = ${isObj("t")} && valid(t) ? t.location | #-1; ` +
    `da = ${isObj("d")} && valid(d) ? \`d.area ! ANY => #-1' | #-1; ` +
    `kind = "open"; ` +
    `if ($ou:isa(e, $climbing_exit)) kind = "climb"; elseif ($ou:isa(e, $swim_exit)) kind = "swim"; ` +
    `elseif ($ou:isa(e, $door)) kind = $recycler:valid(\`e.lock ! ANY => #-1') ? "locked" | "door"; endif ` +
    `exits = {@exits, ["id" -> tostr(e), "dir" -> \`e.direction ! ANY => ""', "twin" -> tostr(t), "to" -> tostr(d), ` +
    `"to_name" -> valid(d) ? d.name | "", "to_area" -> tostr(da), "to_area_name" -> ${isObj("da")} && valid(da) ? da.name | "", "type" -> kind, "hidden" -> \`e.hidden ! ANY => 0' ? 1 | 0]}; ` +
    `endfor ` +
    `edges = {}; ` +
    `for g in (\`r:edges() ! ANY => {}') ` +
    `if (!valid(g)) continue; endif ` +
    `edges = {@edges, ["id" -> tostr(g), "dir" -> \`g.direction ! ANY => ""', "success" -> tostr(\`g.success_dest ! ANY => #-1'), "fail" -> tostr(\`g.failure_dest ! ANY => #-1')]}; ` +
    `endfor ` +
    `people = 0; for c in (r.contents) if (is_player(c)) people = people + 1; endif endfor ` +
    `rooms = {@rooms, ["id" -> tostr(r), "name" -> r.name, "x" -> \`r.x ! ANY => 0', "y" -> \`r.y ! ANY => 0', "z" -> \`r.z ! ANY => 0', ` +
    `"description" -> \`r.description ! ANY => ""', "parent" -> tostr(parent(r)), "exits" -> exits, "edges" -> edges, "players" -> people]}; ` +
    `endfor ` +
    `return ["id" -> tostr(area), "name" -> area.name, "parent" -> tostr(parent(area)), ` +
    `"authored" -> area in \`player.builds ! ANY => {}' ? 1 | 0, "character" -> tostr(player), "rooms" -> rooms];`
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The room parent: configured, else the Shaper Feature's own @dig default. */
const roomParent = (cfg) => (cfg?.room_parent ? objRef(cfg.room_parent, "room_parent") : "`#272.default_room_type ! ANY => $room'");
/** The area parent: configured, else the character's @build default. */
const areaParent = (cfg) => (cfg?.area_parent ? objRef(cfg.area_parent, "area_parent") : "`player.default_build_area ! ANY => #273'");

/** Steps that make one room in `area` at a cell; leaves it bound to `room`. */
function makeRoom({ x, y, z, name, description }, cfg) {
  return (
    `if ($recycler:valid(other = area:get_room_at(${lit(x)}, ${lit(y)}, ${lit(z)}))) ` +
    `raise(E_INVARG, tostr("cell (${x},${y},${z}) is already taken by ", other.name, " (", other, ")")); endif ` +
    `pool = \`area.build_pool ! ANY => #-1'; kind = ${roomParent(cfg)}; ` +
    `room = $recycler:valid(pool) ? $recycler:create(kind, pool) | $recycler:create(kind); ` +
    checked(`room:set_name(${lit(String(name))})`) +
    `room.x = ${lit(x)}; room.y = ${lit(y)}; room.z = ${lit(z)}; ` +
    `area:add_room(room); ` +
    (description !== undefined ? checked(`room:set_description(${lit(descriptionValue(description))})`) : "") +
    `\`room:refresh_icon() ! ANY'; `
  );
}

/**
 * A new area, appended to the character's .builds the way @build does, and
 * optionally its first room. Refused before anything is made when the
 * character has no .builds to hold it.
 */
export function createBuildSource({ name, room }, cfg = {}) {
  return (
    `if (typeof(\`player.builds ! ANY => E_PROPNF') != typeof({})) ` +
    `raise(E_PROPNF, tostr(player.name, " (", player, ") has no .builds list, so it cannot own a build. Builders inherit one from Generic Builder #4 or Generic Shaper #268.")); endif ` +
    `kind = ${areaParent(cfg)}; ` +
    `area = $recycler:create(kind); ` +
    checked(`area:set_name(${lit(String(name))})`) +
    `player.builds = {@player.builds, area}; ` +
    (room ? makeRoom({ ...room, z: room.z ?? 0 }, cfg) + `return {tostr(area), tostr(room)};` : `return {tostr(area)};`)
  );
}

export function createRoomSource(build, room, cfg = {}) {
  return guard(build) + makeRoom(room, cfg) + `return tostr(room);`;
}

export function updateRoomSource(build, { room, name, description }) {
  return (
    guard(build) +
    roomIn("room", room) +
    (name !== undefined ? checked(`room:set_name(${lit(String(name))})`) : "") +
    (description !== undefined ? checked(`room:set_description(${lit(descriptionValue(description))})`) : "") +
    `return tostr(room);`
  );
}

const EXIT_KINDS = { door: "$door", climb: "$climbing_exit", swim: "$swim_exit" };
export const EXIT_TYPES = ["open", ...Object.keys(EXIT_KINDS)];

/**
 * One exit pair, named, directed and aliased exactly as @dig does it, of the
 * type $building_utils:make_exit_pair would choose (the area's
 * default_exit_type, and the type's otherside_type for the far half). The pair
 * is made inline rather than through make_exit_pair so this task holds both
 * halves from the start: if any step fails, both are recycled and the error is
 * raised again, instead of leaving an unnamed exit in a room. They are named
 * before they move, so $room:sort_exits files them by their real direction.
 *
 * `to` may be outside the build only when `outside` is set: that is a
 * deliberate link into the wider world, and both areas get the peek links
 * @dig gives a cross-area dig.
 */
export function linkSource(build, { from, to, dir, type = "open", hidden = false, outside = false }) {
  if (!LONG[dir]) throw new Error(`unknown direction ${JSON.stringify(dir)}`);
  if (type !== "open" && !EXIT_KINDS[type]) throw new Error(`exit type must be one of ${EXIT_TYPES.join(", ")}`);
  const fwd = LONG[dir], back = LONG[OPPOSITE[dir]];
  const kind = type === "open" ? "`area.default_exit_type ! ANY => $exit'" : EXIT_KINDS[type];
  const name = (v, d) =>
    checked(`${v}:set_name(${lit(d)})`) + `${v}.direction = ${lit(d)}; ${v}:set_aliases({${lit(d)}, @$building_utils:exit_aka(${lit(d)})}); `;
  const target = outside
    ? `there = ${objRef(to, "to")}; ` +
      `if (!${isObj("there")} || !valid(there) || !$ou:isa(there, $room)) raise(E_INVARG, tostr("to ", ${lit(String(to))}, " is not a valid room")); endif `
    : roomIn("there", to);
  return (
    guard(build) +
    roomIn("here", from) +
    target +
    `if (here == there) raise(E_INVARG, "a room cannot have an exit to itself"); endif ` +
    `for e in (here.exits) if (valid(e) && \`e.direction ! ANY => ""' == ${lit(fwd)}) ` +
    `raise(E_INVARG, tostr(here.name, " (", here, ") already has a ${fwd} exit (", e, ")")); endif endfor ` +
    `for e in (there.exits) if (valid(e) && \`e.direction ! ANY => ""' == ${lit(back)}) ` +
    `raise(E_INVARG, tostr(there.name, " (", there, ") already has a ${back} exit (", e, ")")); endif endfor ` +
    `etype = ${kind}; otype = etype; ` +
    `if ($recycler:valid(o = \`etype.otherside_type ! ANY => #-1') && $ou:isa(o, $exit)) otype = o; endif ` +
    `a = #-1; b = #-1; ` +
    `try ` +
    `a = $recycler:create(etype); b = $recycler:create(otype); a.twin = b; b.twin = a; ` +
    name("a", fwd) +
    name("b", back) +
    (hidden ? `a.hidden = 1; b.hidden = 1; ` : "") +
    `a:moveto(here); b:moveto(there); ` +
    `if (a.location != here || b.location != there) raise(E_INVARG, "the exits did not arrive in their rooms"); endif ` +
    `except err (ANY) ` +
    `for x in ({a, b}) if ($recycler:valid(x)) \`$recycler:recycle(x) ! ANY'; endif endfor ` +
    `raise(err[1], err[2]); ` +
    `endtry ` +
    // A cross-area link registers mutual peek icons the way @dig does: each area
    // stores the border cell in its own coordinate space.
    `far = \`there.area ! ANY => #-1'; ` +
    `if ($recycler:valid(far) && far != area) ` +
    `p = $building_utils:calc_relative_coordinates(here.x, here.y, here.z, ${lit(fwd)}); \`area:add_area_link(far, p[1], p[2], p[3], there) ! ANY'; ` +
    `p = $building_utils:calc_relative_coordinates(there.x, there.y, there.z, ${lit(back)}); \`far:add_area_link(area, p[1], p[2], p[3], here) ! ANY'; ` +
    `endif ` +
    `return {tostr(a), tostr(b), tostr(far)};`
  );
}

/** Show or hide both halves of an existing pair. */
export function hideSource(build, { exit, hidden }) {
  return (
    guard(build) +
    `e = ${objRef(exit, "exit")}; ` +
    `if (!valid(e) || !$ou:isa(e, $exit) || \`e.location.area ! ANY => #-1' != area) raise(E_PERM, tostr(e, " is not an exit in this build")); endif ` +
    `e.hidden = ${hidden ? 1 : 0}; if ($recycler:valid(t = \`e.twin ! ANY => #-1')) t.hidden = ${hidden ? 1 : 0}; endif ` +
    `return tostr(e);`
  );
}

/** Remove an exit pair. $exit:recycle takes the twin with it. */
export function unlinkSource(build, { exit }) {
  return (
    guard(build) +
    `e = ${objRef(exit, "exit")}; ` +
    `if (!${isObj("e")} || !valid(e) || !$ou:isa(e, $exit)) raise(E_INVARG, tostr(${lit(String(exit))}, " is not a valid exit")); endif ` +
    `if (\`e.location.area ! ANY => #-1' != area) raise(E_PERM, tostr(e, " is not an exit in a room of this build")); endif ` +
    `$recycler:recycle(e); ` +
    `return tostr(e);`
  );
}

/**
 * Recycle a room through $recycler, which runs $room:recycle: the room leaves
 * its area and its exits go, twins included. Edges are not swept by room
 * teardown, so this build's edges that start in it or land in it go first. A
 * room with a player in it is refused rather than emptied.
 */
export function deleteRoomSource(build, { room }) {
  return (
    guard(build) +
    roomIn("room", room) +
    `for c in (room.contents) if (is_player(c)) raise(E_PERM, tostr(room.name, " (", room, ") has a player in it: ", c.name, " (", c, ")")); endif endfor ` +
    `for r in (area.rooms) if (valid(r)) for g in (\`r:edges() ! ANY => {}') ` +
    `if (valid(g) && (r == room || \`g.success_dest ! ANY => #-1' == room || \`g.failure_dest ! ANY => #-1' == room)) $recycler:recycle(g); endif ` +
    `endfor endif endfor ` +
    `$recycler:recycle(room); ` +
    `return tostr(room);`
  );
}

/**
 * The maintenance @dig does after every exit, done once per call: the route
 * cache of each touched area, and the area's cached maps.
 */
export function finishSource(build, others = []) {
  const extra = others.map((o) => objRef(o, "area"));
  return (
    guard(build) +
    `touched = {area${extra.length ? ", " + extra.join(", ") : ""}}; ` +
    `for a in (touched) if ($recycler:valid(a)) \`a:recompute_next_hops() ! ANY'; endif endfor ` +
    `if (length(area.rooms)) \`area.rooms[1]:refresh_icon() ! ANY'; endif ` +
    `return length(touched);`
  );
}

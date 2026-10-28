// Reaching the world. This package has no client or credentials of its own: it finds the moo package
// installed in the same space (@thetis/moo, else @bitmuse/moo, or the one `moo_package` names), imports its
// client.js and logs in as that package's character, exactly as @bitmuse/moo-build does.
//
// Every MOO program here is built from one JSON payload, handed over as a string literal and read back with
// parse_json, so no caller text is ever spliced into source. The writes go through the same pieces the
// website cartographer's write API ($netsat:mapper_*) and @dig use -- $netsat:_mapper_new_room,
// _mapper_cell_free, _mapper_recycle_room, _mapper_exit_type, $building_utils:make_exit_pair, label_exit,
// relink_after_exit, unlink_after_exit, relink_after_room_move, retype_exit_pair, $room_edge:set_direction
// and :sync_elevations -- so a room made here is indistinguishable from one dug by hand or on the website.
//
// Authority: every op names objects by id and the program refuses any room, exit, edge or block whose area
// is not one of the map's own linked areas (or one this publish just created). The character must be a
// Shaper or staff ($wiz_utils:is_shaper), the website mapper's own gate.

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MOO_PACKAGES = ["@thetis/moo", "@bitmuse/moo"];
const harness = {};
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function connect(env) {
  const named = str(env?.config?.moo_package);
  const installed = (await env.kernel?.packages?.list?.()) ?? [];
  const pkg = (named ? [named] : MOO_PACKAGES).map((n) => installed.find((p) => p.name === n)).find(Boolean);
  if (!pkg?.root) {
    throw new Error(
      named
        ? `the key moo_package names ${named}, and no package of that name is installed in this space.`
        : `no moo package is installed in this space. Maps reach the world through ${MOO_PACKAGES.join(" or ")}: install it and set its username and password.`,
    );
  }
  const file = resolve(pkg.root, "client.js");
  let mod;
  try {
    mod = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
  } catch (e) {
    throw new Error(`could not load ${pkg.name}'s client from ${file}: ${e.message}`);
  }
  if (typeof mod.createClient !== "function") throw new Error(`${pkg.name}'s client.js has no createClient export`);
  const config = (await env.kernel.config.effective(pkg.name)) ?? {};
  return { name: pkg.name, client: mod.createClient({ ...env, config, harness }), mod };
}

function explain(r, mod) {
  const err = mod?.compactWire ? mod.compactWire(r.error) : r.error;
  const strings = [];
  const walk = (v) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(err);
  const message = strings.filter((s) => s.length > 3).sort((a, b) => b.length - a.length)[0];
  const raw = JSON.stringify(err ?? null);
  return message ?? (raw.length > 600 ? raw.slice(0, 600) + "…" : raw);
}

export async function call(conn, source, timeoutMs = 30_000) {
  const r = await conn.client.captured("/v1/eval", source, timeoutMs);
  if (r.timed_out) {
    const e = new Error("the task hit its time limit. A timeout is not a rollback: what it did before the limit is committed. Run map_status to see where the world is before trying again.");
    e.timedOut = true;
    throw e;
  }
  if (!r.success) throw new Error(explain(r, conn.mod));
  return r.value;
}

/** A string as a MOO literal. Only backslash and quote need escaping: JSON text has no raw newlines. */
const moostr = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const payload = (data) => `data = parse_json(${moostr(JSON.stringify(data))}); `;

// Resolves an id string ("#123" or "#0A52…") to an object, or $nothing. $netsat:_resolve_obj parses it as
// data (toobj, round-trip checked), never as code.
const R = (expr) => `$netsat:_resolve_obj(${expr}[2..$])`;

const GATE =
  `if (!$netsat:is_shaper(player)) raise(E_PERM, tostr(player.name, " (", player, ") is not a Shaper, so it cannot write the map. The website cartographer has the same gate.")); endif `;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every area that holds rooms, for choosing what to import. */
export function areasSource({ query = "" } = {}) {
  return (
    payload({ q: String(query).toLowerCase() }) +
    `builds = \`player.builds ! ANY => {}'; if (typeof(builds) != TYPE_LIST) builds = {}; endif out = {}; ` +
    `for a in ($ou:descendants($area)) ` +
    `if (!$recycler:valid(a)) continue; endif n = length(\`a.rooms ! ANY => {}'); mine = a in builds; ` +
    `if (n == 0 && !mine) continue; endif ` +
    `if (data["q"] && !index(a.name, data["q"]) && !index(tostr(a), data["q"])) continue; endif ` +
    `out = {@out, ["id" -> tostr(a), "name" -> a.name, "rooms" -> n, "yours" -> mine ? 1 | 0]}; ` +
    `endfor return ["character" -> tostr(player), "character_name" -> player.name, "shaper" -> $netsat:is_shaper(player) ? 1 | 0, "areas" -> out];`
  );
}

/**
 * The live state of some areas: their rooms with every exit (twin, far room, its area, type, hidden,
 * direction), edges, players present, and painted blocks. An id that is not a live area answers
 * `missing`.
 */
export function snapshotSource(areaIds, carriages = []) {
  return (
    payload({ areas: areaIds, carriages }) +
    // Elevators (plans/elevators-app.md): a lobby's \`in\` leads to a carriage off the grid. Those exits are
    // read as stops, not as exits leaving the map; the carriages are read whole with :mapper_get().
    `gen = \`$elevator_carriage ! ANY => $nothing'; api = $recycler:valid(gen) && respond_to(gen, "mapper_set") ? 1 | 0; cars = {}; ` +
    `for s in (data["carriages"]) c = ${R("s")}; if ($recycler:valid(c) && api && $ou:isa(c, gen)) cars = setadd(cars, c); endif endfor ` +
    `out = {}; ` +
    `for s in (data["areas"]) ` +
    `area = ${R("s")}; ` +
    `if (!$recycler:valid(area) || !$ou:isa(area, $area)) out = {@out, ["id" -> s, "missing" -> 1]}; continue; endif ` +
    `rooms = {}; ` +
    `for r in (\`area.rooms ! ANY => {}') ` +
    `if (!$recycler:valid(r) || !$ou:isa(r, $room)) continue; endif ` +
    `ex = {}; ` +
    `for e in (\`r.exits ! ANY => {}') ` +
    `if (!$recycler:valid(e) || !$ou:isa(e, $exit) || $ou:isa(e, $room_edge)) continue; endif ` +
    `if (api) dd = \`e.dest ! ANY => $nothing'; if ($recycler:valid(dd) && $ou:isa(dd, gen)) cars = setadd(cars, dd); continue; endif endif ` +
    `t = \`e.twin ! ANY => $nothing'; d = $recycler:valid(t) ? \`t.location ! ANY => $nothing' | $nothing; ` +
    `da = $recycler:valid(d) ? \`d:area() ! ANY => $nothing' | $nothing; ` +
    `ex = {@ex, ["id" -> tostr(e), "twin" -> tostr(t), "to" -> tostr(d), "to_name" -> $recycler:valid(d) ? d.name | "", ` +
    `"to_area" -> tostr(da), "to_area_name" -> $recycler:valid(da) ? da.name | "", "dir" -> \`e.direction ! ANY => ""', ` +
    `"type" -> $netsat:_mapper_exit_type(e), "hidden" -> \`e.hidden ! ANY => 0' ? 1 | 0]}; ` +
    `endfor ` +
    `eg = {}; ` +
    `for g in (\`r:edges() ! ANY => {}') ` +
    `if (!$recycler:valid(g)) continue; endif ` +
    `eg = {@eg, ["id" -> tostr(g), "dir" -> $netsat:_mapper_compass(\`g.direction ! ANY => ""', ""), "success" -> tostr(\`g.success_dest ! ANY => $nothing'), ` +
    `"fail" -> tostr(\`g.failure_dest ! ANY => $nothing'), "hidden" -> \`g.hidden ! ANY => 0' ? 1 | 0]}; ` +
    `endfor ` +
    `people = 0; for c in (r.contents) if (is_player(c)) people = people + 1; endif endfor ` +
    `rooms = {@rooms, ["id" -> tostr(r), "x" -> \`r.x ! ANY => 0', "y" -> \`r.y ! ANY => 0', "z" -> \`r.z ! ANY => 0', "name" -> r.name, ` +
    `"description" -> $netsat:_mapper_description(r), "exits" -> ex, "edges" -> eg, "players" -> people]}; ` +
    `endfor ` +
    `out = {@out, ["id" -> tostr(area), "name" -> area.name, "blocks" -> \`area.mapper_blocks ! ANY => {}', "rooms" -> rooms]}; ` +
    `endfor ` +
    `ev = {}; for c in (cars) ` +
    `try sp = c:mapper_get(); st = {}; for x in (\`sp["stops"] ! ANY => {}') st = {@st, {tostr(x[1]), tostr(x[2])}}; endfor ` +
    `ev = {@ev, ["id" -> tostr(c), "name" -> \`sp["name"] ! ANY => c.name', "description" -> \`sp["description"] ! ANY => ""', "door" -> \`sp["door"] ! ANY => 0', "travel" -> \`sp["travel"] ! ANY => 0', "stops" -> st]}; ` +
    `except err (ANY) ev = {@ev, ["id" -> tostr(c), "error" -> tostr(err[2])]}; endtry endfor ` +
    `gone = {}; for s in (data["carriages"]) c = ${R("s")}; if (!$recycler:valid(c)) gone = {@gone, s}; endif endfor ` +
    `return ["character" -> tostr(player), "shaper" -> $netsat:is_shaper(player) ? 1 | 0, "areas" -> out, "elevator_api" -> api, "elevators" -> ev, "carriages_gone" -> gone];`
  );
}

// ---------------------------------------------------------------------------
// Writes: a batch of ops, each in its own try, stopping cleanly before the task's time runs out
// ---------------------------------------------------------------------------

const FAIL = (msg) => `raise(E_INVARG, ${msg}); `;
// A $netsat helper that answers an error map instead of raising.
const MAPERR = `if (typeof(e) == TYPE_MAP) raise(E_INVARG, \`e["error"]["message"] ! ANY => toliteral(e)'); endif `;
const IN_SCOPE = (v, what) =>
  `if (!(\`${v}:area() ! ANY => $nothing' in allowed)) raise(E_PERM, tostr(${what}, " ", ${v}, " is not in one of this map's areas, so the map does not touch it.")); endif `;
const ROOM = (v, field) =>
  `${v} = ${R(`op["${field}"]`)}; if (!$recycler:valid(${v}) || !$ou:isa(${v}, $room)) ${FAIL(`tostr("room ", op["${field}"], " is gone")`)}endif ` + IN_SCOPE(v, '"room"');
const DESC = `if (maphaskey(op, "description")) r = room:set_description(op["description"]); if (typeof(r) == TYPE_ERR) raise(r, "set_description refused"); endif endif `;

const ELEV_GEN =
  `gen = \`$elevator_carriage ! ANY => $nothing'; if (!$recycler:valid(gen) || !respond_to(gen, "mapper_set")) raise(E_INVARG, "the MOO has no elevator system yet ($elevator_carriage:mapper_set)"); endif `;
// The spec, with each stop's lobby resolved and checked to be in one of the map's areas.
const ELEV_SPEC =
  `["name" -> op["name"], "description" -> op["description"], "door" -> op["door"], "travel" -> op["travel"], "stops" -> {}]; ` +
  `for x in (op["stops"]) lob = ${R('x["room"]')}; if (!$recycler:valid(lob) || !$ou:isa(lob, $room)) ${FAIL('tostr("lobby ", x["room"], " is gone")')}endif ` +
  IN_SCOPE("lob", '"lobby"') + `spec["stops"] = {@spec["stops"], {x["label"], lob}}; endfor `;

const OPS = {
  area_create:
    `area = $recycler:create($area); area:set_name(op["name"]); ` +
    `if (typeof(\`player.builds ! ANY => 0') == TYPE_LIST) player.builds = setadd(player.builds, area); endif ` +
    `allowed = {@allowed, area}; value = tostr(area); `,
  area_rename:
    `area = ${R('op["area"]')}; if (!(area in allowed)) raise(E_PERM, "that area is not one of this map's"); endif ` +
    `area:set_name(op["name"]); value = tostr(area); `,
  room_create:
    `area = ${R('op["area"]')}; if (!(area in allowed)) raise(E_PERM, "that area is not one of this map's"); endif ` +
    `e = $netsat:_mapper_cell_free(area, op["x"], op["y"], op["z"], $nothing); ${MAPERR}` +
    `room = $netsat:_mapper_new_room(area); ` +
    `try ` +
    `r = room:set_name(op["name"]); if (typeof(r) == TYPE_ERR) raise(r, "set_name refused"); endif ` +
    `room.x = op["x"]; room.y = op["y"]; room.z = op["z"]; area:add_room(room); ${DESC}` +
    `\`room:refresh_icon() ! ANY'; ` +
    `except err (ANY) $netsat:_mapper_recycle_room(room); raise(err[1], err[2]); endtry ` +
    `value = tostr(room); `,
  room_update:
    ROOM("room", "room") +
    `if (maphaskey(op, "name")) r = room:set_name(op["name"]); if (typeof(r) == TYPE_ERR) raise(r, "set_name refused"); endif endif ${DESC}` +
    `value = tostr(room); `,
  room_move:
    ROOM("room", "room") +
    `area = ${R('op["area"]')}; if (!(area in allowed)) raise(E_PERM, "that area is not one of this map's"); endif ` +
    `e = $netsat:_mapper_cell_free(area, op["x"], op["y"], op["z"], room); ${MAPERR}` +
    `old = room:area(); room.x = op["x"]; room.y = op["y"]; room.z = op["z"]; ` +
    `if (area != old) area:add_room(room); endif ` +
    `$building_utils:relink_after_room_move(room, old); \`room:refresh_icon() ! ANY'; value = tostr(room); `,
  room_delete:
    ROOM("room", "room") +
    `if (!\`op["force"] ! ANY => 0') for c in (room.contents) if (is_player(c)) raise(E_PERM, tostr(room.name, " (", room, ") has ", c.name, " in it; publish with force to send them home and delete it anyway.")); endif endfor endif ` +
    `$netsat:_mapper_recycle_room(room); value = op["room"]; `,
  exit_create:
    ROOM("a", "a") + ROOM("b", "b") +
    `if (a == b) ${FAIL('"an exit needs two different rooms"')}endif ` +
    `if ($recycler:valid($netsat:_mapper_exit_between(a, b))) ${FAIL('tostr(a.name, " and ", b.name, " are already joined by an exit")')}endif ` +
    `adir = $netsat.mapper_compass_dirs[op["adir"]]; bdir = $netsat.mapper_compass_dirs[op["bdir"]]; ` +
    `for x in (a.exits) if ($recycler:valid(x) && \`x.direction ! ANY => ""' == adir) ${FAIL('tostr(a.name, " (", a, ") already has a ", adir, " exit (", x, ")")')}endif endfor ` +
    `for x in (b.exits) if ($recycler:valid(x) && \`x.direction ! ANY => ""' == bdir) ${FAIL('tostr(b.name, " (", b, ") already has a ", bdir, " exit (", x, ")")')}endif endfor ` +
    `etype = op["type"] == "open" ? \`a:area().default_exit_type ! ANY => $exit' | $netsat.mapper_exit_types[op["type"]]; ` +
    `{e1, e2} = $building_utils:make_exit_pair(a, b, etype); ` +
    `$building_utils:label_exit(e1, adir); $building_utils:label_exit(e2, bdir); ` +
    `e1.hidden = op["hidden"] ? 1 | 0; e2.hidden = op["hidden"] ? 1 | 0; ` +
    `$building_utils:relink_after_exit(a, b); value = tostr($netsat:_mapper_exit_canonical(e1)[1]); `,
  exit_update:
    `ex = ${R('op["exit"]')}; pair = $netsat:_mapper_exit_canonical(ex); if (!pair) ${FAIL('tostr("exit ", op["exit"], " is gone or has lost its twin")')}endif ` +
    `p1 = pair[1]; p2 = pair[2]; ra = p1.location; rb = p2.location; ` + IN_SCOPE("ra", '"room"') + IN_SCOPE("rb", '"room"') +
    `sa = tostr(ra) == op["a"] ? p1 | p2; sb = sa == p1 ? p2 | p1; ` +
    `if (maphaskey(op, "type")) $building_utils:retype_exit_pair(sa, op["type"] == "open" ? \`ra:area().default_exit_type ! ANY => $exit' | $netsat.mapper_exit_types[op["type"]]); endif ` +
    `if (maphaskey(op, "hidden")) sa.hidden = op["hidden"] ? 1 | 0; sb.hidden = op["hidden"] ? 1 | 0; endif ` +
    `if (maphaskey(op, "adir")) $building_utils:label_exit(sa, $netsat.mapper_compass_dirs[op["adir"]]); endif ` +
    `if (maphaskey(op, "bdir")) $building_utils:label_exit(sb, $netsat.mapper_compass_dirs[op["bdir"]]); endif ` +
    `value = tostr(p1); `,
  exit_delete:
    `ex = ${R('op["exit"]')}; pair = $netsat:_mapper_exit_canonical(ex); if (!pair) ${FAIL('tostr("exit ", op["exit"], " is gone or has lost its twin")')}endif ` +
    `ra = pair[1].location; rb = pair[2].location; ` + IN_SCOPE("ra", '"room"') + IN_SCOPE("rb", '"room"') +
    `$recycler:recycle(pair[1]); $building_utils:unlink_after_exit(ra, rb); value = op["exit"]; `,
  edge_create:
    ROOM("src", "from") + ROOM("succ", "success") + ROOM("fl", "fail") +
    `dir = $netsat.mapper_compass_dirs[op["dir"]]; ` +
    `for g in (src:edges()) if (g.direction == dir) ${FAIL('tostr(src.name, " already has an edge ", dir)')}endif endfor ` +
    `edge = $recycler:create($room_edge); edge:set_direction(dir); edge.success_dest = succ; edge.failure_dest = fl; ` +
    `edge.hidden = op["hidden"] ? 1 | 0; edge:moveto(src); edge:sync_elevations(); value = tostr(edge); `,
  edge_update:
    `edge = ${R('op["edge"]')}; if (!$recycler:valid(edge) || !$ou:isa(edge, $room_edge)) ${FAIL('tostr("edge ", op["edge"], " is gone")')}endif ` +
    `src = edge.location; ` + IN_SCOPE("src", '"room"') +
    `if (maphaskey(op, "dir")) dir = $netsat.mapper_compass_dirs[op["dir"]]; for g in (src:edges()) if (g.direction == dir && g != edge) ${FAIL('tostr(src.name, " already has an edge ", dir)')}endif endfor edge:set_direction(dir); endif ` +
    `if (maphaskey(op, "success")) ${ROOM("succ", "success")}edge.success_dest = succ; endif ` +
    `if (maphaskey(op, "fail")) ${ROOM("fl", "fail")}edge.failure_dest = fl; endif ` +
    `if (maphaskey(op, "hidden")) edge.hidden = op["hidden"] ? 1 | 0; endif ` +
    `edge:sync_elevations(); value = tostr(edge); `,
  edge_delete:
    `edge = ${R('op["edge"]')}; if (!$recycler:valid(edge) || !$ou:isa(edge, $room_edge)) ${FAIL('tostr("edge ", op["edge"], " is gone")')}endif ` +
    `src = edge.location; ` + IN_SCOPE("src", '"room"') + `$recycler:recycle(edge); value = op["edge"]; `,
  // Elevators: the MOO side owns how a carriage works; these only hand it the map's spec.
  elevator_create:
    `${ELEV_GEN}spec = ${ELEV_SPEC}value = tostr(gen:mapper_create(spec)); `,
  elevator_update:
    `${ELEV_GEN}car = ${R('op["elevator"]')}; if (!$recycler:valid(car) || !$ou:isa(car, gen)) ${FAIL('tostr("carriage ", op["elevator"], " is gone")')}endif ` +
    `spec = ${ELEV_SPEC}car:mapper_set(spec); value = tostr(car); `,
  elevator_delete:
    `${ELEV_GEN}car = ${R('op["elevator"]')}; if ($recycler:valid(car) && $ou:isa(car, gen)) car:mapper_destroy(); endif value = op["elevator"]; `,
  block_add:
    `area = ${R('op["area"]')}; if (!(area in allowed)) raise(E_PERM, "that area is not one of this map's"); endif ` +
    `if ($recycler:valid(area:get_room_at(op["x"], op["y"], op["z"]))) ${FAIL('"a room occupies that cell"')}endif ` +
    `area:add_block(op["x"], op["y"], op["z"]); value = 1; `,
  block_remove:
    `area = ${R('op["area"]')}; if (!(area in allowed)) raise(E_PERM, "that area is not one of this map's"); endif ` +
    `area:remove_block(op["x"], op["y"], op["z"]); value = 1; `,
};

export const OP_KINDS = Object.keys(OPS);

/**
 * One task that runs `ops` in order, each in its own try, and answers one result per op:
 * `{ ok: 1, value }`, `{ ok: 0, error }`, or `{ ok: 0, skipped: 1 }` for ops it had no time left for.
 * `areas` are the map's linked areas: nothing outside them is touched.
 */
export function batchSource(areas, ops) {
  for (const op of ops) if (!OPS[op.op]) throw new Error(`unknown op ${op.op}`);
  const kinds = [...new Set(ops.map((o) => o.op))];
  const dispatch = kinds.map((k, i) => `${i ? "elseif" : "if"} (kind == ${moostr(k)}) ${OPS[k]}`).join("") + (kinds.length ? "endif " : "");
  return (
    GATE +
    payload({ areas, ops }) +
    `allowed = {}; for s in (data["areas"]) a = ${R("s")}; if ($recycler:valid(a) && $ou:isa(a, $area)) allowed = {@allowed, a}; endif endfor ` +
    `res = {}; ` +
    `for op in (data["ops"]) ` +
    `if (seconds_left() < 3) res = {@res, ["ok" -> 0, "skipped" -> 1]}; continue; endif ` +
    `kind = op["op"]; value = 0; ` +
    `try ${dispatch}res = {@res, ["ok" -> 1, "value" -> value]}; ` +
    `except err (ANY) res = {@res, ["ok" -> 0, "error" -> tostr(err[2])]}; endtry ` +
    `endfor ` +
    `return ["results" -> res];`
  );
}

/** Run ops in batches, in order, stopping at nothing: every op gets a result. */
export async function runOps(conn, areas, ops, { batch = 30, onProgress } = {}) {
  const results = [];
  let i = 0;
  while (i < ops.length) {
    const chunk = ops.slice(i, i + batch);
    let out;
    try {
      out = await call(conn, batchSource(areas, chunk), 30_000);
    } catch (e) {
      // A whole task failed (a timeout, a compile error): its ops did not all run, and some may have.
      for (const _ of chunk) results.push({ ok: 0, error: e.message, unknown: Boolean(e.timedOut) });
      i += chunk.length;
      if (e.timedOut) break;
      continue;
    }
    const got = Array.isArray(out?.results) ? out.results : [];
    let ran = 0;
    for (let j = 0; j < chunk.length; j++) {
      const r = got[j] ?? { ok: 0, skipped: 1 };
      if (r.skipped) break;
      results.push(r);
      ran++;
    }
    i += ran;
    if (!ran) {
      // Out of time before the first op: take a smaller bite.
      if (batch <= 1) {
        results.push({ ok: 0, error: "the MOO had no time left to run this op" });
        i++;
      } else batch = Math.max(1, Math.floor(batch / 2));
    }
    onProgress?.(results.length, ops.length);
  }
  return results;
}

export async function listAreas(conn, query) {
  return call(conn, areasSource({ query }), 60_000);
}

export async function snapshot(conn, areaIds, carriages = []) {
  // With no areas it still asks the world who the character is and whether it may build: a draft's
  // first publish checks that before it makes anything.
  return call(conn, snapshotSource(areaIds, carriages), 60_000);
}

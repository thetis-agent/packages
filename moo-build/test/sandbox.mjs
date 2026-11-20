// Run every MOO program this package generates against a real Torchship
// database, offline: mooR's compiler imports an objdef export into a throwaway
// database and plays a .moot script against it as a wizard. No server, no
// login, nothing live is touched.
//
//   node test/sandbox.mjs [objdef-dir] [moorc]
//
// Defaults: the recovery2 export and the debug moorc beside it. Each step
// runs one generated program through eval() and returns a check computed in the
// MOO, so a failure prints the MOO's own answer. Ids pass between steps through
// scratch properties on #0, which the generated programs read as `$bt_*`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lit, listSource, snapshotSource, createBuildSource, createRoomSource, updateRoomSource,
  linkSource, hideSource, unlinkSource, deleteRoomSource, finishSource,
} from "../lib/source.js";
import { normalize, planSetRooms } from "../lib/plan.js";
import { execute } from "../lib/run.js";

const MOOR = "/tank/data/Dev/games/moor";
// recovery2.moo, not the newer recovery-export-20260828: that export writes
// builtins under the wrong names (1,727 calls to value_hash() where the code
// means length(), fromliteral() for toliteral()), so it is not the live world.
const objdef = process.argv[2] ?? `${MOOR}/recovery2.moo`;
const moorc = process.argv[3] ?? `${MOOR}/target/debug/moorc`;
if (!existsSync(objdef) || !existsSync(moorc)) {
  console.log(`skipped: needs ${objdef} and ${moorc}`);
  process.exit(0);
}

const lines = ["@wizard", ""];
const SCRATCH = ["bt_area", "bt_r1", "bt_r2", "bt_r3", "bt_far", "bt_out", "bt_ex", "bt_v", "bt_lay", ...Array.from({ length: 12 }, (_, i) => `bt_n${i + 1}`)];

let n = 0;
/** Log a step's answer, so a failure shows what the MOO actually said. */
const logged = (title) => `server_log(tostr("BT@${++n} ", ${lit(title)}, " => ", toliteral(res), tb ? tostr(" TRACEBACK ", toliteral(tb)) | "")); return res;`;

/** A step: run `src` through eval(), bind its value to `v`, then compute `check` (ending in `return x;`). */
function step(title, src, check, expect = "1") {
  const assign = check.replace(/return ([^;]*);\s*$/, "res = $1;");
  lines.push(`// ${title}`);
  lines.push(
    `; res = 0; tb = 0; try r = eval(${lit(src)}); if (!r[1]) res = {"COMPILE", r[2]}; else v = r[2]; #0.bt_v = v; ${assign} endif ` +
      `except e (ANY) res = {"RAISED", e[1], e[2]}; tb = e[4]; endtry ${logged(title)}`,
  );
  lines.push(expect, "");
}
/** A step that must be refused with this error. */
function refused(title, src, code) {
  lines.push(`// ${title}`);
  lines.push(`; res = 0; tb = 0; try r = eval(${lit(src)}); res = {"NOT REFUSED", r}; except e (ANY) res = e[1]; endtry ${logged(title)}`);
  lines.push(code, "");
}
const raw = (title, code, expect = "1") => lines.push(`// ${title}`, `; ${code}`, expect, "");

raw(
  "scratch properties, an area outside the builds and a room in it",
  SCRATCH.map((p) => `add_property(#0, "${p}", #-1, {player, "rw"});`).join(" ") +
    ` far = $recycler:create(#273); far:set_name("Elsewhere"); #0.bt_far = far;` +
    ` out = $recycler:create($room); out:set_name("Street"); out.x = 0; out.y = 0; out.z = 0; far:add_room(out); #0.bt_out = out;` +
    ` return valid(far) && valid(out) && !(far in player.builds);`,
);

step("list: the character has .builds", listSource(), `return v["has_builds"] == 1 && typeof(v["areas"]) == typeof({});`);
step("list all: every area with rooms", listSource({ all: true }), `return length(v["areas"]) > 0;`);

step(
  "create a build with a first room and a two-paragraph description",
  createBuildSource({ name: "Moot Annex", room: { name: "Hall", x: 0, y: 0, z: 0, description: "Line one.\nLine two." } }),
  `a = toobj(v[1]); h = toobj(v[2]); #0.bt_area = a; #0.bt_r1 = h; ` +
    `return {(a in player.builds) > 0, $ou:isa(a, $area), h.area == a, (h in a.rooms) > 0, h.name, {h.x, h.y, h.z}, h.description};`,
  `{1, 1, 1, 1, "Hall", {0, 0, 0}, {"Line one.", "Line two."}}`,
);

step(
  "create a room east of it",
  createRoomSource("$bt_area", { x: 1, y: 0, z: 0, name: "Corridor", description: "Dim." }),
  `c = toobj(v); #0.bt_r2 = c; return {c.area == $bt_area, c.name, {c.x, c.y, c.z}, c.description, parent(c) == #272.default_room_type};`,
  `{1, "Corridor", {1, 0, 0}, "Dim.", 1}`,
);

refused("a taken cell is refused", createRoomSource("$bt_area", { x: 1, y: 0, z: 0, name: "Twin" }), "E_INVARG");

step(
  "a name with quotes and a semicolon stays a name",
  createRoomSource("$bt_area", { x: 1, y: 0, z: 1, name: `Bob's "big" room"; recycle(#1); "` }),
  `c = toobj(v); #0.bt_r3 = c; return c.name;`,
  lit(`Bob's "big" room"; recycle(#1); "`),
);

step(
  "link east: names, directions, aliases and twins as @dig makes them",
  linkSource("$bt_area", { from: "$bt_r1", to: "$bt_r2", dir: "e" }),
  `a = toobj(v[1]); b = toobj(v[2]); #0.bt_ex = a; ` +
    `return {a.location == $bt_r1, b.location == $bt_r2, a.twin == b, b.twin == a, a.name, a.direction, b.name, b.direction, ("e" in a.aliases) > 0, ("w" in b.aliases) > 0, (a in $bt_r1.exits) > 0, (b in $bt_r2.exits) > 0, toobj(v[3]) == $bt_area};`,
  `{1, 1, 1, 1, "east", "east", "west", "west", 1, 1, 1, 1, 1}`,
);

refused("a second east exit is refused", linkSource("$bt_area", { from: "$bt_r1", to: "$bt_r3", dir: "e" }), "E_INVARG");

step(
  "a door down to the room below",
  linkSource("$bt_area", { from: "$bt_r2", to: "$bt_r3", dir: "down", type: "door" }),
  `a = toobj(v[1]); b = toobj(v[2]); return {$ou:isa(a, $door), a.direction, b.direction, b.location == $bt_r3};`,
  `{1, "down", "up", 1}`,
);

step(
  "hide a pair, both halves",
  hideSource("$bt_area", { exit: "$bt_ex", hidden: true }),
  `return {$bt_ex.hidden, $bt_ex.twin.hidden};`,
  `{1, 1}`,
);

step(
  "the snapshot sees three rooms, their exits, types and hidden flags",
  snapshotSource("$bt_area"),
  `rooms = v["rooms"]; n = 0; hid = 0; doors = 0; dirs = {}; ` +
    `for r in (rooms) for e in (r["exits"]) n = n + 1; hid = hid + e["hidden"]; doors = doors + (e["type"] == "door"); dirs = setadd(dirs, e["dir"]); endfor endfor ` +
    `return {length(rooms), v["authored"], n, hid, doors, length(dirs)};`,
  `{3, 1, 4, 2, 2, 4}`,
);

step(
  "update name and description",
  updateRoomSource("$bt_area", { room: "$bt_r2", name: "Long Corridor", description: "Longer." }),
  `return {$bt_r2.name, $bt_r2.description};`,
  `{"Long Corridor", "Longer."}`,
);

step(
  "link north out of the build into another area's room",
  linkSource("$bt_area", { from: "$bt_r2", to: "$bt_out", dir: "n", outside: true }),
  `a = toobj(v[1]); #0.bt_ex = a; return {a.twin.location == $bt_out, a.twin.direction, toobj(v[3]) == $bt_far, ($bt_far in \`$bt_area.adjacent_areas ! ANY => {}') > 0};`,
  `{1, "south", 1, 1}`,
);

step(
  "the snapshot names the area an exit leads into",
  snapshotSource("$bt_area"),
  `for r in (v["rooms"]) for e in (r["exits"]) if (e["dir"] == "north") return {e["to_name"], e["to_area_name"]}; endif endfor endfor return 0;`,
  `{"Street", "Elsewhere"}`,
);

refused("linking out without saying so is refused", linkSource("$bt_area", { from: "$bt_r1", to: "$bt_out", dir: "w" }), "E_PERM");

step(
  "unlink takes the twin with it",
  unlinkSource("$bt_area", { exit: "$bt_ex" }),
  `n = 0; for e in ($bt_out.exits) if (valid(e) && e.direction == "south") n = n + 1; endif endfor ` +
    `m = 0; for e in ($bt_r2.exits) if (valid(e) && e.direction == "north") m = m + 1; endif endfor return {n, m};`,
  `{0, 0}`,
);

step(
  "delete the room below: it leaves the area and its door goes on both sides",
  deleteRoomSource("$bt_area", { room: "$bt_r3" }),
  `d = 0; for e in ($bt_r2.exits) if (valid(e) && e.direction == "down") d = d + 1; endif endfor ` +
    `return {($bt_r3 in $bt_area.rooms) > 0, d, length($bt_area.rooms)};`,
  `{0, 0, 2}`,
);

step("finish: route caches and maps", finishSource("$bt_area", ["$bt_far"]), `return v;`, `2`);

refused("reading another area with authority is refused", snapshotSource("$bt_far"), "E_PERM");
step("reading it without authority works", snapshotSource("$bt_far", { authority: false }), `return length(v["rooms"]);`, `1`);
refused("a room outside the build cannot be updated", updateRoomSource("$bt_area", { room: "$bt_out", name: "Mine" }), "E_PERM");
refused("a room outside the build cannot be deleted", deleteRoomSource("$bt_area", { room: "$bt_out" }), "E_PERM");
refused("an area that is not a build cannot be written", createRoomSource("$bt_far", { x: 5, y: 5, z: 0, name: "Squat" }), "E_PERM");

// The whole pipeline: one moo_build_set_rooms request planned against an empty
// build and run by the real executor, each task it sends played here. A new
// room's id comes back as `$bt_nK`, which the step stores, so later links
// reach it the way the executor's own new:x,y,z references would.
step("an empty build for the layout", createBuildSource({ name: "Moot Layout" }), `#0.bt_lay = toobj(v[1]); return 1;`);
const layout = [
  { x: 0, y: 0, name: "Plaza", description: "Open.", exits: ["n", "e", "s", "w", "down", "ne"] },
  { x: 0, y: -1, name: "North Arch", exits: ["s", "e", "se"] },
  { x: 1, y: -1, name: "Tower Foot", exits: ["w", "sw", { dir: "up", type: "climb" }] },
  { x: 1, y: 0, name: "East Gate", exits: ["w", "nw", { dir: "e", type: "door" }] },
  { x: 2, y: 0, name: "Guardhouse", exits: [{ dir: "w", type: "door" }] },
  { x: 0, y: 1, name: "South Steps", exits: ["n"] },
  { x: -1, y: 0, name: "West Alley", exits: [{ dir: "e", hidden: true }] },
  { x: 0, y: 0, z: 1, name: "Undercroft", exits: ["up"] },
  { x: 1, y: -1, z: -1, name: "Tower Top", exits: [{ dir: "down", type: "climb" }] },
];
const plan = planSetRooms(normalize({ id: "#1", name: "Moot Layout", rooms: [] }), layout);
if (plan.errors) throw new Error(plan.errors.join("\n"));
let made = 0;
const recorder = {
  mod: {},
  client: {
    async captured(_path, src) {
      if (/\$recycler:create\(kind/.test(src) && !/player\.builds = /.test(src)) {
        const k = ++made;
        step(`layout: create #${k}`, src, `#0.bt_n${k} = toobj(v); return 1;`);
        return { success: true, value: `$bt_n${k}` };
      }
      step("layout: " + (/a:moveto/.test(src) ? "link" : "finish"), src, `return 1;`);
      return { success: true, value: ["#-1", "#-1", "#-1"] };
    },
  },
};
const result = await execute(recorder, "$bt_lay", plan.ops, {});
if (result.failed) throw new Error(result.failed.error);
step(
  "layout: every exit's twin is in the cell its direction names, facing back",
  snapshotSource("$bt_lay"),
  `bad = {}; ex = 0; for r in (v["rooms"]) for e in (r["exits"]) ex = ex + 1; ` +
    `here = toobj(r["id"]); there = toobj(e["to"]); want = $building_utils:calc_relative_coordinates(here.x, here.y, here.z, e["dir"]); ` +
    `back = toobj(e["twin"]).direction; ` +
    `if (want != {there.x, there.y, there.z} || back != $building_utils:opposite_dir(e["dir"])) bad = {@bad, {r["name"], e["dir"]}}; endif ` +
    `endfor endfor return {length(v["rooms"]), ex, bad};`,
  `{9, 20, {}}`,
);
step(
  "layout: types and hidden flags arrived",
  snapshotSource("$bt_lay"),
  `t = []; for r in (v["rooms"]) for e in (r["exits"]) k = e["type"] + (e["hidden"] ? "/hidden" | ""); t[k] = \`t[k] ! ANY => 0' + 1; endfor endfor return t;`,
  `["climb" -> 2, "door" -> 2, "open" -> 14, "open/hidden" -> 2]`,
);

const dir = mkdtempSync(join(tmpdir(), "moo-build-sandbox-"));
const file = join(dir, "build.moot");
writeFileSync(file, lines.join("\n") + "\n");
const features = [
  "--use-uuobjids", "true", "--bool-type", "true", "--use-boolean-returns", "false", "--symbol-type", "true",
  "--custom-errors", "true", "--type-dispatch", "true", "--flyweight-type", "true", "--anonymous-objects", "true",
  "--rich-notify", "true", "--persistent-tasks", "true",
];
console.log(`moot script: ${file} (${lines.filter((l) => l.startsWith(";")).length} steps)`);
try {
  const out = execFileSync(moorc, [
    "--src-objdef-dir", objdef, ...features,
    "--test-files", file, "--test-wizard", "2", "--test-programmer", "2", "--test-player", "2",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  console.log("sandbox: every step passed");
} catch (e) {
  const text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  const answers = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => l.includes("SERVER_LOG") && l.includes("BT@")).map((l) => l.slice(l.indexOf("BT@")));
  console.log(answers.join("\n") || text.slice(-4000));
  console.log(text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => /^\s+Line \d+/.test(l)).join("\n"));
  console.log(`\nsandbox: FAILED (script kept at ${file})`);
  process.exit(1);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as T from "../lib/tools.js";
import { needMap } from "../lib/store.js";
import { completeDoc } from "../ui/core/doc.js";
import * as ops from "../lib/ops.js";
import { batchSource, OP_KINDS, snapshot } from "../lib/moo.js";
import { fakeWorld } from "./fakeworld.js";

async function space() {
  const cwd = await mkdtemp(join(tmpdir(), "moo-maps-"));
  const W = fakeWorld();
  Object.assign(T.world, { connect: W.connect, snapshot: W.snapshot, runOps: W.runOps, listAreas: W.listAreas });
  return { env: { cwd, session: { id: "s_test" } }, W, done: () => rm(cwd, { recursive: true, force: true }) };
}
const idOf = (text) => /m_[0-9a-f]{8}/.exec(text)[0];

test("ops: set rooms by cell, declarative exits, errors leave the doc alone", () => {
  let doc = completeDoc({ name: "t", areas: [{ id: "a1", name: "A" }] });
  const link = { areas: {}, rooms: {}, exits: {}, edges: {} };
  let r = ops.setRooms(doc, link, [
    { x: 0, y: 0, name: "Hall", exits: ["e", { dir: "s", type: "door" }] },
    { x: 1, y: 0, name: "East" },
    { x: 0, y: 1, name: "South" },
  ]);
  doc = r.doc;
  assert.equal(doc.rooms.length, 3);
  assert.equal(doc.exits.length, 2);
  assert.equal(doc.exits.find((e) => e.type === "door").b, doc.rooms[2].id);
  // Declarative: listing only e removes s.
  r = ops.setRooms(doc, link, [{ x: 0, y: 0, exits: ["e"] }]);
  assert.equal(r.doc.exits.length, 1);
  assert.throws(() => ops.setRooms(doc, link, [{ x: 0, y: 0, exits: ["w"] }]), /no room to its west/);
  assert.throws(() => ops.setRooms(doc, link, [{ x: 5, y: 5 }]), /needs a name/);
  assert.equal(doc.exits.length, 2, "the input doc is not mutated");
});

test("ops: move, replace, search, link across areas, blocks, edges", () => {
  let doc = completeDoc({ name: "t", areas: [{ id: "a1", name: "A" }, { id: "a2", name: "B" }], nextId: 3 });
  const L = { areas: {}, rooms: {}, exits: {}, edges: {} };
  doc = ops.setRooms(doc, L, [{ x: 0, y: 0, name: "Old Hall", description: "A hall. The hall is old.", exits: ["e"] }, { x: 1, y: 0, name: "Old Room" }]).doc;
  doc = ops.moveRooms(doc, L, { rooms: [{ x: 0, y: 0 }, { x: 1, y: 0 }], dx: 1, dy: 0 }).doc;
  assert.deepEqual(doc.rooms.map((r) => r.x).sort(), [1, 2]);
  assert.throws(() => ops.moveRooms(doc, L, { rooms: [{ x: 1, y: 0 }], dx: 1 }), /is there/);
  const rep = ops.replace(doc, L, { pattern: "old", replacement: "new", ignore_case: true });
  assert.equal(rep.total, 3);
  assert.equal(rep.doc.rooms[0].name, "new Hall");
  const re = ops.replace(doc, L, { pattern: "(\\w+) Hall", replacement: "Great $1", regex: true, fields: ["name"] });
  assert.equal(re.doc.rooms.find((r) => r.name.startsWith("Great")).name, "Great Old");
  assert.equal(ops.search(doc, L, { pattern: "hall", ignore_case: true }).total, 3);
  doc = ops.setRooms(doc, L, [{ x: 0, y: 0, area: "a2", name: "Over There" }]).doc;
  doc = ops.link(doc, L, { from: { x: 2, y: 0 }, to: { x: 0, y: 0, area: "a2" }, adir: "e" }).doc;
  const cross = doc.exits.find((e) => e.adir);
  assert.equal(cross.adir, "e");
  assert.equal(cross.bdir, "w");
  // (1,0) already leaves east, to (2,0): a second east exit is refused.
  doc = ops.setRooms(doc, L, [{ x: 3, y: 3, area: "a2", name: "Far" }]).doc;
  assert.throws(() => ops.link(doc, L, { from: { x: 1, y: 0 }, to: { x: 3, y: 3, area: "a2" }, adir: "e" }), /already has a east exit/);
  doc = ops.blocks(doc, L, { add: [{ x: 5, y: 5 }] }).doc;
  assert.throws(() => ops.setRooms(doc, L, [{ x: 5, y: 5, name: "x" }]), /blocked/);
  doc = ops.edge(doc, L, { from: { x: 1, y: 0 }, dir: "n", success: { x: 2, y: 0 }, fail: { x: 1, y: 0 } }).doc;
  assert.equal(doc.edges.length, 1);
  doc = ops.deleteRooms(doc, L, [{ x: 2, y: 0 }]).doc;
  assert.equal(doc.edges.length, 0, "an edge landing in a deleted room goes too");
  assert.equal(doc.exits.length, 0);
});

test("publish makes a draft in the world, links it, and a second publish is a no-op", async () => {
  const { env, W, done } = await space();
  try {
    const id = idOf(await T.mapCreate({ name: "Docks", rooms: [
      { x: 0, y: 0, name: "Pier", description: "Wet boards.\nGulls.", exits: ["e", "down"] },
      { x: 1, y: 0, name: "Shed", exits: [{ dir: "w", type: "door" }] },
      { x: 0, y: 0, z: 1, name: "Under the Pier" },
    ] }, env));
    const dry = await T.mapPublish({ map: id, dry_run: true }, env);
    assert.match(dry, /would make 6 changes/);
    assert.equal(W.areas.size, 0);
    const out = await T.mapPublish({ map: id }, env);
    assert.match(out, /6 changes made/);
    assert.doesNotMatch(out, /FAILED/);
    assert.equal(W.areas.size, 1);
    assert.equal(W.rooms.size, 3);
    const pier = W.roomAt([...W.areas.keys()][0], 0, 0, 0);
    assert.deepEqual(W.exitDirs(pier), ["down", "east"]);
    assert.equal(W.rooms.get(pier).description, "Wet boards.\nGulls.");
    const rec = await needMap(env, id);
    assert.equal(Object.keys(rec.link.rooms).length, 3);
    assert.equal(Object.keys(rec.link.exits).length, 2);
    assert.match(await T.mapStatus({ map: id }, env), /the world matches the map/);
    assert.match(await T.mapPublish({ map: id }, env), /nothing to publish/);
  } finally {
    await done();
  }
});

test("publish carries edits: rename, move, retype, delete, and leaves foreign rooms alone", async () => {
  const { env, W, done } = await space();
  try {
    const id = idOf(await T.mapCreate({ name: "Row", rooms: [
      { x: 0, y: 0, name: "A", exits: ["e"] }, { x: 1, y: 0, name: "B", exits: ["e"] }, { x: 2, y: 0, name: "C" },
    ] }, env));
    await T.mapPublish({ map: id }, env);
    const area = [...W.areas.keys()][0];
    const foreign = W.addRoom(area, 9, 9, 0, "Dug by hand");
    const cMoo = W.roomAt(area, 2, 0, 0);
    await T.mapSetRooms({ map: id, rooms: [{ x: 0, y: 0, name: "A2", description: "new" }, { x: 1, y: 0, exits: [{ dir: "e", type: "door" }, "w"] }] }, env);
    await T.mapMoveRooms({ map: id, rooms: [{ x: 2, y: 0 }], to: { x: 2, y: 1 } }, env);
    await T.mapDeleteRooms({ map: id, rooms: [{ x: 0, y: 0 }] }, env);
    const out = await T.mapPublish({ map: id }, env);
    assert.doesNotMatch(out, /FAILED/, out);
    assert.match(out, /left alone.*Dug by hand/);
    assert.ok(W.rooms.has(foreign), "a foreign room is never deleted");
    assert.equal(W.rooms.size, 3);
    assert.deepEqual([W.rooms.get(cMoo).x, W.rooms.get(cMoo).y], [2, 1], "moved, same object");
    const b = W.roomAt(area, 1, 0, 0);
    assert.equal(W.exits.get(W.rooms.get(b).exits[0]).type, "door");
    // B (1,0) and C (2,1) are now diagonal neighbours: the exit's sides are renamed.
    assert.deepEqual(W.exitDirs(b), ["southeast"]);
    assert.match(await T.mapStatus({ map: id }, env), /the world matches the map/);
  } finally {
    await done();
  }
});

test("rooms swapping cells publish through a parked move", async () => {
  const { env, W, done } = await space();
  try {
    const id = idOf(await T.mapCreate({ name: "Swap", rooms: [{ x: 0, y: 0, name: "L" }, { x: 1, y: 0, name: "R" }] }, env));
    await T.mapPublish({ map: id }, env);
    const area = [...W.areas.keys()][0];
    const l = W.roomAt(area, 0, 0, 0), r = W.roomAt(area, 1, 0, 0);
    const rec = await needMap(env, id);
    const doc = structuredClone(rec.doc);
    doc.rooms[0].x = 1; doc.rooms[1].x = 0;
    const { mutate } = await import("../lib/store.js");
    await mutate(env, id, () => ({ doc, what: "swap" }));
    const out = await T.mapPublish({ map: id }, env);
    assert.doesNotMatch(out, /FAILED/, out);
    assert.equal(W.rooms.get(l).x, 1);
    assert.equal(W.rooms.get(r).x, 0);
    assert.equal(W.rooms.get(l).z, 0);
  } finally {
    await done();
  }
});

test("import, pull merges the world's changes under the map's own, publish fixes the rest", async () => {
  const { env, W, done } = await space();
  try {
    const area = W.addArea("Gardens");
    const other = W.addArea("Street");
    const n = W.addRoom(area, 0, 0, 0, "Nursery", "Seedlings.");
    const d = W.addRoom(area, 0, -1, 0, "Darkrooms");
    const s = W.addRoom(other, 5, 5, 0, "Street");
    W.join(n, d, "n", "s");
    W.join(n, s, "e", "w");
    const out = await T.mapImport({ areas: [area] }, env);
    const id = idOf(out);
    assert.match(out, /2 rooms, 1 exit/);
    let rec = await needMap(env, id);
    assert.equal(rec.link.external.length, 1, "the exit to the street is outside the map");
    assert.match(await T.mapStatus({ map: id }, env), /the world matches the map/);
    // The world changes: a new room is dug; the map changes the nursery's name.
    const g = W.addRoom(area, 0, 1, 0, "Grocers");
    W.join(n, g, "s", "n");
    W.rooms.get(d).name = "Mushroom Rooms";
    await T.mapSetRooms({ map: id, rooms: [{ x: 0, y: 0, name: "Seed Nursery" }] }, env);
    assert.match(await T.mapStatus({ map: id }, env), /not on the map: 1 room/);
    const pulled = await T.mapPull({ map: id }, env);
    assert.match(pulled, /brought in 1 room, 1 exit/);
    assert.match(pulled, /took the world's changes to room r\d+ "Mushroom Rooms"/);
    rec = await needMap(env, id);
    assert.equal(rec.doc.rooms.find((r) => r.x === 0 && r.y === 0).name, "Seed Nursery", "the map's edit survives a pull");
    assert.equal(rec.doc.rooms.find((r) => r.y === -1).name, "Mushroom Rooms", "the world's edit comes in");
    const pub = await T.mapPublish({ map: id }, env);
    assert.match(pub, /1 change made/);
    assert.equal(W.rooms.get(n).name, "Seed Nursery");
    assert.equal(W.rooms.size, 4);
    assert.ok(W.rooms.get(n).exits.some((e) => W.exits.get(W.exits.get(e).twin).loc === s), "the exit out of the map is untouched");
    // Importing the same area into a second map is refused.
    await assert.rejects(T.mapImport({ areas: [area] }, env), /already on map/);
  } finally {
    await done();
  }
});

test("a failed op is reported, the rest still land, and the next publish retries it", async () => {
  const { env, W, done } = await space();
  try {
    const id = idOf(await T.mapCreate({ name: "Flaky", rooms: [{ x: 0, y: 0, name: "One", exits: ["e"] }, { x: 1, y: 0, name: "Two" }] }, env));
    W.fail = (op) => op.op === "room_create" && op.name === "Two";
    const out = await T.mapPublish({ map: id }, env);
    assert.match(out, /FAILED/);
    assert.match(out, /simulated failure/);
    assert.equal(W.rooms.size, 1);
    W.fail = null;
    const again = await T.mapPublish({ map: id }, env);
    assert.doesNotMatch(again, /FAILED/, again);
    assert.equal(W.rooms.size, 2);
    assert.match(await T.mapStatus({ map: id }, env), /the world matches the map/);
  } finally {
    await done();
  }
});

test("a room deleted in the world is made again; a room with a player needs force", async () => {
  const { env, W, done } = await space();
  try {
    const id = idOf(await T.mapCreate({ name: "Re", rooms: [{ x: 0, y: 0, name: "Keep" }, { x: 1, y: 0, name: "Busy" }] }, env));
    await T.mapPublish({ map: id }, env);
    const area = [...W.areas.keys()][0];
    W.removeRoom(W.roomAt(area, 0, 0, 0));
    const busy = W.roomAt(area, 1, 0, 0);
    W.rooms.get(busy).players = 1;
    await T.mapDeleteRooms({ map: id, rooms: [{ x: 1, y: 0 }] }, env);
    const out = await T.mapPublish({ map: id }, env);
    assert.match(out, /is made again/);
    assert.match(out, /FAILED/);
    assert.ok(W.rooms.has(busy));
    assert.ok(W.roomAt(area, 0, 0, 0));
    const forced = await T.mapPublish({ map: id, force: true }, env);
    assert.doesNotMatch(forced, /FAILED/, forced);
    assert.ok(!W.rooms.has(busy));
  } finally {
    await done();
  }
});

test("the MOO batch program is generated for every op kind", () => {
  const src = batchSource(["#1"], OP_KINDS.map((op) => ({ op })));
  for (const k of OP_KINDS) assert.ok(src.includes(`kind == "${k}"`));
  assert.ok(src.startsWith("if (!$netsat:is_shaper(player))"));
  // Caller text only ever travels inside the JSON string literal.
  const evil = batchSource(["#1"], [{ op: "room_update", room: "#1", name: '"); recycle(#1); ("\\' }]);
  assert.ok(!evil.includes('recycle(#1); ("'), "no unescaped quote breaks out");
});

test("a draft's first publish still asks the world who the character is", async () => {
  const sent = [];
  const conn = { client: { captured: async (_p, src) => { sent.push(src); return { success: true, value: { character: "#9", shaper: 1, areas: [] } }; } } };
  const snap = await snapshot(conn, []);
  assert.equal(sent.length, 1, "it went to the MOO even with no areas");
  assert.equal(snap.shaper, 1);
  assert.match(sent[0], /\$netsat:is_shaper\(player\)/);
});

test("vertical diagonals: dig by cell, opposite twin, text map, publish codes", async () => {
  const { DIRS, OPPOSITE, LONG, dirOf, exitDirFrom } = await import("../ui/core/doc.js");
  assert.equal(Object.keys(DIRS).length, 26);
  assert.deepEqual(DIRS.nu, [0, -1, -1]);
  assert.deepEqual(DIRS.swd, [-1, 1, 1]);
  assert.equal(OPPOSITE.nu, "sd");
  assert.equal(OPPOSITE.nwd, "seu");
  assert.equal(LONG.neu, "northeastup");
  for (const s of ["nu", "northup", "north up", "up north", "upnorth", "up n"]) assert.equal(dirOf(s), "nu", s);
  assert.equal(dirOf("southwestdown"), "swd");
  let doc = completeDoc({ name: "ramp", areas: [{ id: "a1", name: "A" }] });
  const link = { areas: {}, rooms: {}, exits: {}, edges: {} };
  doc = ops.setRooms(doc, link, [
    { x: 0, y: 0, z: 0, name: "Pit floor", exits: ["nu"] },
    { x: 0, y: -1, z: -1, name: "Rim" },
  ]).doc;
  assert.equal(doc.exits.length, 1);
  const [pit, rim] = doc.rooms;
  assert.equal(exitDirFrom(doc, doc.exits[0], pit), "nu");
  assert.equal(exitDirFrom(doc, doc.exits[0], rim), "sd");
  assert.throws(() => ops.setRooms(doc, link, [{ x: 0, y: 0, z: 0, exits: ["eu"] }]), /no room to its eastup/);
  // map_link by direction
  doc = ops.setRooms(doc, link, [{ x: 1, y: 1, z: 1, name: "Cellar" }]).doc;
  doc = ops.link(doc, link, { from: pit.id, dir: "sed" }).doc;
  assert.equal(doc.exits.length, 2);
  const { textMap } = await import("../lib/view.js");
  const text = textMap({ id: "m_00000000", rev: 1, doc, link: { ...link, published: null, publishedRev: 0 }, changes: [] });
  assert.match(text, /"Pit floor" \(0,0,0\)\s+exits: nu sed/);
  assert.match(text, /"Rim" \(0,-1,-1\)\s+exits: sd/);
  assert.match(text, /<0.>/);
});

test("elevators: stops across areas, publish waits for the MOO side, then makes, updates, removes", async () => {
  const { env, W, done } = await space();
  try {
    const id = idOf(await T.mapCreate({ name: "Tower", areas: ["Tower", "Basement"], rooms: [
      { x: 0, y: 0, z: -2, name: "Roof Lobby" },
      { x: 0, y: 0, z: 0, name: "Ground Lobby", exits: ["e"] },
      { x: 1, y: 0, z: 0, name: "Street" },
      { x: 5, y: 5, z: 1, area: "a2", name: "Car Park" },
    ] }, env));
    // add by floor: top first, whatever order they come in.
    let out = await T.mapElevator({ map: id, name: "Tower Lift", add: [{ label: "G", room: { x: 0, y: 0 } }, { label: "B", room: { x: 5, y: 5, z: 1, area: "a2" } }, { label: "R", room: { x: 0, y: 0, z: -2 } }] }, env);
    assert.match(out, /stops top first: R="?r\d/);
    let rec = await needMap(env, id);
    assert.deepEqual(rec.doc.elevators[0].stops.map((s) => s.label), ["R", "G", "B"]);
    await assert.rejects(T.mapElevator({ map: id, elevator: "Tower Lift", add: [{ label: "g", room: { x: 1, y: 0 } }] }, env), /labelled "g"/);
    assert.match(await T.mapGet({ map: id }, env), /Elevators[\s\S]*Tower Lift/);
    assert.match(await T.mapRooms({ map: id, x: 0, y: 0 }, env), /in → elevator v\d+ "Tower Lift", stop G/);

    // No elevator system in the MOO yet: rooms publish, the elevator waits.
    W.elevatorApi = false;
    out = await T.mapPublish({ map: id }, env);
    assert.match(out, /no elevator system yet/);
    assert.equal(W.cars.size, 0);
    W.elevatorApi = true;
    out = await T.mapPublish({ map: id, dry_run: true }, env);
    assert.match(out, /make elevator v\d+ "Tower Lift": a carriage and 3 lobby exits/);
    out = await T.mapPublish({ map: id }, env);
    assert.doesNotMatch(out, /FAILED/);
    assert.equal(W.cars.size, 1);
    const [car] = W.cars.keys();
    rec = await needMap(env, id);
    assert.equal(rec.link.elevators[rec.doc.elevators[0].id], car);
    assert.deepEqual(W.cars.get(car).stops.map((s) => s.label), ["R", "G", "B"]);
    // The lobby `in` is not reported as an exit leaving the map, and the world matches.
    assert.doesNotMatch(await T.mapStatus({ map: id }, env), /exits out of the map/);
    assert.match(await T.mapPublish({ map: id }, env), /nothing to publish/);

    // Relabel and drop a stop; deleting a lobby room drops its stop too.
    await T.mapElevator({ map: id, elevator: car, door: 12, drop: ["R"], add: [{ label: "1", room: { x: 1, y: 0 }, at: 1 }] }, env);
    out = await T.mapPublish({ map: id }, env);
    assert.match(out, /update elevator/);
    assert.deepEqual(W.cars.get(car).stops.map((s) => s.label), ["G", "1", "B"]);
    assert.equal(W.cars.get(car).door, 12);
    assert.equal(W.exitDirs(W.roomAt([...W.areas.keys()][0], 0, 0, -2)).length, 0);
    out = await T.mapDeleteRooms({ map: id, rooms: [{ x: 5, y: 5, z: 1, area: "a2" }] }, env);
    assert.match(out, /1 elevator stop/);
    await T.mapPublish({ map: id }, env);
    assert.deepEqual(W.cars.get(car).stops.map((s) => s.label), ["G", "1"]);
    assert.match(await T.mapPublish({ map: id }, env), /nothing to publish/);

    // Pull: a fresh import of the same areas brings the elevator in.
    const rec2 = await needMap(env, id);
    const imp = await T.mapImport({ areas: Object.values(rec2.link.areas), allow_shared: true, name: "Copy" }, env);
    assert.match(imp, /1 elevator/);

    await T.mapElevator({ map: id, elevator: "Tower Lift", remove: true }, env);
    out = await T.mapPublish({ map: id }, env);
    assert.match(out, /delete elevator/);
    assert.equal(W.cars.size, 0);
    assert.equal(W.exitDirs(W.roomAt([...W.areas.keys()][0], 0, 0, 0)).length, 1);
  } finally {
    await done();
  }
});

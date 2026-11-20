import test from "node:test";
import assert from "node:assert/strict";
import { normalize, planSetRooms, planDeleteRooms, planLink, planUnlink, normalizeId } from "../lib/plan.js";

// A build as the MOO reports it: a hall at (0,0,0) joined east to a corridor
// at (1,0,0), and a door from the corridor out of the build to #9 Street.
function fixture() {
  return normalize({
    id: "#100", name: "Annex", authored: 1, character: "#50",
    rooms: [
      { id: "#1", name: "Hall", x: 0, y: 0, z: 0, description: "A hall.", players: 0, edges: [],
        exits: [{ id: "#11", dir: "east", twin: "#12", to: "#2", to_name: "Corridor", to_area: "#100", type: "open", hidden: 0 }] },
      { id: "#2", name: "Corridor", x: 1, y: 0, z: 0, description: ["Long.", "Dim."], players: 0, edges: [],
        exits: [
          { id: "#12", dir: "west", twin: "#11", to: "#1", to_name: "Hall", to_area: "#100", type: "open", hidden: 0 },
          { id: "#13", dir: "north", twin: "#14", to: "#9", to_name: "Street", to_area: "#200", type: "door", hidden: 0 },
        ] },
    ],
  });
}

const kinds = (ops) => ops.map((o) => o.op);

test("normalize marks compass, build membership and adjacency, and joins list descriptions", () => {
  const b = fixture();
  const [hall, corridor] = b.rooms;
  assert.equal(hall.exits[0].compass, "e");
  assert.equal(hall.exits[0].adjacent, true);
  assert.equal(corridor.exits[1].inBuild, false);
  assert.equal(corridor.description, "Long.\nDim.");
  assert.equal(b.authored, true);
});

test("ids are normalised to tostr() form", () => {
  assert.equal(normalizeId("123"), "#123");
  assert.equal(normalizeId("#0011e5-9cb7359f34"), "#0011E5-9CB7359F34");
  assert.equal(normalizeId("$room"), undefined);
  assert.equal(normalizeId("#1; recycle(#2)"), undefined);
});

test("an empty cell creates a room, and its exits link after every create", () => {
  const plan = planSetRooms(fixture(), [
    { x: 2, y: 0, name: "Vault", exits: ["w", "s"] },
    { x: 2, y: 1, name: "Cellar door", exits: ["n"] },
    { room: "#2", exits: ["w", "e"] },
  ]);
  assert.equal(plan.errors, undefined, plan.errors?.join("\n"));
  assert.deepEqual(kinds(plan.ops), ["create", "create", "link", "link"]);
  const links = plan.ops.filter((o) => o.op === "link");
  assert.deepEqual(links.map((l) => [l.from, l.dir, l.to]), [["new:2,0,0", "w", "#2"], ["new:2,0,0", "s", "new:2,1,0"]]);
});

test("a pair declared from both sides is made once", () => {
  const plan = planSetRooms(fixture(), [
    { x: 0, y: 1, name: "A", exits: ["e", "n"] },
    { x: 1, y: 1, name: "B", exits: ["w"] },
    { room: "#1", exits: ["e", "s"] },
  ]);
  assert.equal(plan.errors, undefined, plan.errors?.join("\n"));
  assert.equal(plan.ops.filter((o) => o.op === "link").length, 2);
});

test("an exit list is the whole set: an unlisted in-build pair is removed", () => {
  const plan = planSetRooms(fixture(), [{ room: "#1", exits: [] }]);
  assert.deepEqual(plan.ops, [{ op: "unlink", exit: "#11", from: "#1", dir: "e", to: "#2", to_area: "#100", why: "not listed" }]);
});

test("omitting exits leaves them alone, and an unchanged room plans nothing", () => {
  assert.deepEqual(planSetRooms(fixture(), [{ room: "#1" }]).ops, []);
  assert.deepEqual(planSetRooms(fixture(), [{ x: 0, y: 0, name: "Hall", exits: ["e"] }]).ops, []);
});

test("an exit leaving the build is never removed by a declaration", () => {
  const plan = planSetRooms(fixture(), [{ room: "#2", exits: ["w"] }]);
  assert.deepEqual(plan.ops, []);
});

test("declaring a direction taken by an exit out of the build is refused, naming the way out", () => {
  const plan = planSetRooms(fixture(), [{ x: 1, y: -1, name: "Loft" }, { room: "#2", exits: ["w", "n"] }]);
  assert.match(plan.errors.join("\n"), /leads out of this build, to #9 "Street".*moo_build_unlink/);
});

test("a direction with no room in that cell is refused before anything runs", () => {
  const plan = planSetRooms(fixture(), [{ x: 5, y: 5, name: "Island", exits: ["n"] }]);
  assert.equal(plan.ops, undefined);
  assert.match(plan.errors[0], /needs a room at \(5,4,0\)/);
});

test("the two sides of one pair must agree", () => {
  const plan = planSetRooms(fixture(), [{ room: "#1", exits: ["e"] }, { room: "#2", exits: [] }]);
  assert.match(plan.errors.join("\n"), /wants an exit e .* leaves out w|leaves out w, but .* wants/);
});

test("changing an exit's type replaces the pair; changing hidden edits it in place", () => {
  const door = planSetRooms(fixture(), [{ room: "#1", exits: [{ dir: "e", type: "door" }] }]);
  assert.deepEqual(kinds(door.ops), ["unlink", "link"]);
  assert.equal(door.ops[1].type, "door");
  const hide = planSetRooms(fixture(), [{ room: "#1", exits: [{ dir: "e", hidden: true }] }]);
  assert.deepEqual(hide.ops, [{ op: "hide", exit: "#11", hidden: true, from: "#1", dir: "e" }]);
});

test("up and down are levels: z grows downward", () => {
  const plan = planSetRooms(fixture(), [{ x: 0, y: 0, z: 1, name: "Basement", exits: ["up"] }, { room: "#1", exits: ["e", "down"] }]);
  assert.equal(plan.errors, undefined, plan.errors?.join("\n"));
  const l = plan.ops.find((o) => o.op === "link");
  assert.deepEqual([l.from, l.dir, l.to], ["new:0,0,1", "up", "#1"]);
});

test("rooms outside the build, new rooms without a name, bad directions and moves are refused", () => {
  const errors = planSetRooms(fixture(), [
    { room: "#9", name: "Street" },
    { x: 3, y: 3 },
    { x: 4, y: 4, name: "Odd", exits: ["sideways"] },
    { room: "#1", x: 7, y: 7 },
  ]).errors.join("\n");
  assert.match(errors, /#9.* is not part of build #100/);
  assert.match(errors, /needs a name/);
  assert.match(errors, /"sideways" is not a direction/);
  assert.match(errors, /Rooms are not moved/);
});

test("the same room twice in one call is refused", () => {
  assert.match(planSetRooms(fixture(), [{ room: "#1" }, { x: 0, y: 0 }]).errors[0], /same room as rooms\[0\]/);
});

test("a name or description that differs is an update, with only what changed", () => {
  const plan = planSetRooms(fixture(), [{ x: 0, y: 0, name: "Great Hall", description: "A hall." }]);
  assert.deepEqual(plan.ops, [{ op: "update", room: "#1", name: "Great Hall" }]);
});

test("delete by cell or id, refused outside the build or with a player inside", () => {
  const b = fixture();
  assert.deepEqual(planDeleteRooms(b, [{ x: 1, y: 0 }, { room: "#2" }]).ops.map((o) => o.room), ["#2"]);
  assert.match(planDeleteRooms(b, [{ x: 9, y: 9 }]).errors[0], /no room at \(9,9,0\)/);
  b.rooms[0].players = 1;
  assert.match(planDeleteRooms(b, [{ room: "#1" }]).errors[0], /player/);
});

test("link: the neighbour by default, anywhere with `to`, and never over an existing exit", () => {
  assert.match(planLink(fixture(), { from: { room: "#1" }, dir: "e" }).errors[0], /already has a e exit/);
  assert.match(planLink(fixture(), { from: { x: 0, y: 0 }, dir: "n" }).errors[0], /no room n of \(0,0,0\)/);
  const out = planLink(fixture(), { from: { x: 0, y: 0 }, dir: "w", to: "#300", type: "door" });
  assert.deepEqual(out.ops, [{ op: "link", from: "#1", to: "#300", dir: "w", type: "door", hidden: false, outside: true }]);
});

test("unlink by direction (including out of the build) or by exit id", () => {
  assert.deepEqual(planUnlink(fixture(), { from: { room: "#2" }, dir: "north" }).ops[0].exit, "#13");
  assert.equal(planUnlink(fixture(), { exit: "11" }).ops[0].exit, "#11");
  assert.equal(planUnlink(fixture(), { exit: "#77" }).errors[0], 'exit "#77" is not an exit of any room in this build');
  assert.match(planUnlink(fixture(), { from: { room: "#1" }, dir: "s" }).errors[0], /has no s exit; its exits are: e/);
});

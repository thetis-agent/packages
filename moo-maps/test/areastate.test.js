import { test } from "node:test";
import assert from "node:assert/strict";
import { completeDoc } from "../ui/core/doc.js";
import { areaStates, areasOfOp, mergePublished, driftByArea } from "../lib/areastate.js";

const base = completeDoc({
  name: "w", nextId: 20,
  areas: [{ id: "a1", name: "Dock" }, { id: "a2", name: "Mall" }, { id: "a3", name: "New" }],
  rooms: [
    { id: "r1", area: "a1", x: 0, y: 0, z: 0, name: "Pier" },
    { id: "r2", area: "a1", x: 1, y: 0, z: 0, name: "Quay" },
    { id: "r3", area: "a2", x: 0, y: 0, z: 0, name: "Atrium" },
  ],
  exits: [{ id: "e1", a: "r1", b: "r2" }, { id: "e2", a: "r2", b: "r3", adir: "e", bdir: "w" }],
});
const published = completeDoc({ ...base, areas: base.areas.slice(0, 2) });
const link = { areas: { a1: "#1", a2: "#2" }, published, drift: null };

test("each area gets its own state", () => {
  const doc = completeDoc({ ...base, rooms: base.rooms.map((r) => (r.id === "r3" ? { ...r, name: "Grand Atrium" } : r)).concat([{ id: "r9", area: "a3", x: 0, y: 0, z: 0, name: "Plot" }]) });
  const rows = Object.fromEntries(areaStates({ doc, link }).map((r) => [r.id, r]));
  assert.equal(rows.a1.state, "published");
  assert.equal(rows.a2.state, "changed");
  assert.equal(rows.a2.pending, 1);
  assert.equal(rows.a3.state, "draft");
});

test("a cross-area exit counts for both areas; drift marks an area out of date", () => {
  const doc = completeDoc({ ...base, exits: base.exits.filter((e) => e.id !== "e2") });
  const rows = Object.fromEntries(areaStates({ doc, link: { ...link, drift: { areas: { a1: 2 } } } }).map((r) => [r.id, r]));
  assert.equal(rows.a2.state, "changed");
  assert.equal(rows.a1.state, "outdated");
  assert.equal(rows.a1.drift, 2);
});

test("ops are put down to their areas", () => {
  assert.deepEqual(areasOfOp({ op: "exit_create", ref: { a: "r2", b: "r3" } }, base), ["a1", "a2"]);
  assert.deepEqual(areasOfOp({ op: "room_update", local: "r3", ref: { room: "r3" } }, base), ["a2"]);
  assert.deepEqual(areasOfOp({ op: "area_create", local: "a3" }, base), ["a3"]);
});

test("publishing some areas keeps the old picture of the others", () => {
  const fresh = completeDoc({ ...published, rooms: published.rooms.map((r) => ({ ...r, name: r.name + "!" })) });
  const merged = mergePublished(published, fresh, new Set(["a2"]));
  assert.equal(merged.rooms.find((r) => r.id === "r1").name, "Pier");
  assert.equal(merged.rooms.find((r) => r.id === "r3").name, "Atrium!");
  assert.deepEqual(driftByArea(published, fresh), { a1: 2, a2: 1 });
});

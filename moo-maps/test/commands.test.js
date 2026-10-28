import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiCreate, uiDoc, uiSave, uiList, uiFocus, uiWatch, uiEditor, uiRename, uiRemove } from "../lib/commands.js";
import { mapSetRooms, mapGet } from "../lib/tools.js";
import { diffDocs, completeDoc } from "../ui/core/doc.js";

const env = async () => ({ cwd: await mkdtemp(join(tmpdir(), "mm-cmd-")), session: { id: "s_test" } });
const docOf = async (e, id) => JSON.parse((await uiDoc({ map: id }, e, { method: "GET" })).body);
const put = (e, id, patch, base) => uiSave({ map: id, base }, e, { method: "PUT", body: Buffer.from(JSON.stringify(patch)) });

test("the tab's save is merged on top of an agent edit made meanwhile", async () => {
  const e = await env();
  const { map } = (await uiCreate({ name: "Cmd test" }, e)).data;
  const first = await docOf(e, map.id);
  assert.equal(first.rev, 1);
  assert.equal(first.doc.rooms.length, 1);
  // the agent adds a room east of Start
  await mapSetRooms({ map: map.id, rooms: [{ x: 1, y: 0, name: "Agent room" }, { x: 0, y: 0, exits: ["e"] }] }, e);
  // the tab, still on rev 1, renames Start and adds a room to the south
  const mine = completeDoc(JSON.parse(JSON.stringify(first.doc)));
  mine.rooms[0].name = "Gate";
  mine.rooms.push({ id: `r${mine.nextId}`, area: "a1", x: 0, y: 1, z: 0, name: "Tab room", color: "#2a3140", description: "", notes: "" });
  mine.nextId += 1;
  const out = await put(e, map.id, diffDocs(first.doc, completeDoc(mine)), 1);
  assert.equal(out.rev, 3);
  assert.deepEqual(out.conflicts, []);
  const now = (await docOf(e, map.id)).doc;
  assert.deepEqual(now.rooms.map((r) => r.name).sort(), ["Agent room", "Gate", "Tab room"]);
  assert.equal(now.exits.length, 1);
  const list = (await uiList({}, e)).data.maps;
  assert.equal(list[0].rooms, 3);
  assert.equal(list[0].state, "draft");
  await rm(e.cwd, { recursive: true });
});

test("two rooms on one cell: the later is refused as a conflict, nothing lost", async () => {
  const e = await env();
  const { map } = (await uiCreate({ name: "Clash" }, e)).data;
  const first = await docOf(e, map.id);
  await mapSetRooms({ map: map.id, rooms: [{ x: 2, y: 0, name: "Agent" }] }, e);
  const mine = JSON.parse(JSON.stringify(first.doc));
  mine.rooms.push({ id: "r9", area: "a1", x: 2, y: 0, z: 0, name: "Tab", color: "#2a3140", description: "", notes: "" });
  mine.nextId = 10;
  const out = await put(e, map.id, diffDocs(first.doc, completeDoc(mine)), 1);
  assert.equal(out.conflicts.length, 1);
  const now = (await docOf(e, map.id)).doc;
  assert.ok(now.rooms.some((r) => r.name === "Agent"));
  assert.ok(!now.rooms.some((r) => r.name === "Tab"));
  await rm(e.cwd, { recursive: true });
});

test("focus is shown to the agent; rename, remove, watch and the editor frame", async () => {
  const e = await env();
  const { map } = (await uiCreate({ name: "Focus" }, e)).data;
  await uiFocus({ map: map.id, focus: { sel: { kind: "room", id: "r2" }, area: "a1", floor: 0 } }, e);
  const text = await mapGet({ map: map.id }, e);
  assert.match(text, /room r2 "Start" \(0,0,0\) selected/);
  await uiRename({ map: map.id, name: "Renamed" }, e);
  const ac = new AbortController();
  const it = uiWatch({}, { ...e, signal: ac.signal });
  const snap = (await it.next()).value;
  assert.equal(snap.ev, "snapshot");
  assert.equal(snap.maps[0].title, "Renamed");
  const nextP = it.next();
  await mapSetRooms({ map: map.id, rooms: [{ x: 0, y: 1, name: "Watched" }] }, e);
  const ev = (await nextP).value;
  assert.equal(ev.ev, "changed");
  assert.equal(ev.by, "agent");
  assert.equal(ev.row.rooms, 2);
  ac.abort();
  await it.return();
  const html = await uiEditor({ map: map.id }, e, { path: "" });
  assert.match(html.headers["content-type"], /text\/html/);
  assert.match(html.body, /editor\.js/);
  const js = await uiEditor({ map: map.id }, e, { path: "editor.js" });
  assert.doesNotMatch(js.body, /^export /m);
  assert.equal((await uiEditor({ map: map.id }, e, { path: "../package.json" })).status, 404);
  await uiRemove({ map: map.id }, e);
  assert.equal((await uiList({}, e)).data.maps.length, 0);
  await rm(e.cwd, { recursive: true });
});

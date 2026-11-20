// The tools end to end, against a fake moo package: the soft link to its
// client, the reports, and that a refused request never reaches the MOO.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tools from "../index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// A moo package whose client answers from a script and records every task.
function fakeMoo(answer) {
  const root = mkdtempSync(join(tmpdir(), "fake-moo-"));
  const sent = [];
  globalThis.__fakeMoo = { sent, answer };
  writeFileSync(
    join(root, "client.js"),
    `export function createClient(env) {
       return { async captured(path, src) {
         globalThis.__fakeMoo.sent.push({ src, config: env.config });
         return globalThis.__fakeMoo.answer(src);
       } };
     }
     export const compactWire = (v) => v;`,
  );
  return { root, sent };
}

function envFor(root, { name = "@thetis/moo", config = {} } = {}) {
  return {
    config,
    kernel: {
      packages: { list: async () => (root ? [{ name, root }] : []) },
      config: { effective: async (n) => ({ username: "zero", from: n }) },
    },
  };
}

const ROOMS = {
  id: "#100", name: "Annex", authored: 1, character: "#50",
  rooms: [
    { id: "#1", name: "Hall", x: 0, y: 0, z: 0, description: "", players: 0, edges: [],
      exits: [{ id: "#11", dir: "east", twin: "#12", to: "#2", to_name: "Corridor", to_area: "#100", type: "open", hidden: 0 }] },
    { id: "#2", name: "Corridor", x: 1, y: 0, z: 0, description: "", players: 0, edges: [],
      exits: [{ id: "#12", dir: "west", twin: "#11", to: "#1", to_name: "Hall", to_area: "#100", type: "open", hidden: 0 }] },
  ],
};
const ok = (value) => ({ success: true, value, output: [] });

test("every manifest tool names an export, and every export is declared", () => {
  const declared = pkg.thetis.tools.map((t) => t.export).sort();
  assert.deepEqual(declared, Object.keys(tools).sort());
  for (const t of pkg.thetis.tools) {
    assert.match(t.name, /^moo_build_[a-z_]+$/);
    assert.equal(t.parameters.type, "object");
  }
});

test("get draws the build, using the moo package's client and config", async () => {
  const { root, sent } = fakeMoo(() => ok(ROOMS));
  const out = await tools.get({ build: "100" }, envFor(root));
  assert.match(out, /Build #100 "Annex": 2 rooms/);
  assert.match(out, /\[01\]-\[02\]/);
  assert.match(out, /01 #1 "Hall" \(0,0,0\)  exits: e/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].config, { username: "zero", from: "@thetis/moo" });
});

test("a refused request sends nothing after the read", async () => {
  const { root, sent } = fakeMoo(() => ok(ROOMS));
  const out = await tools.setRooms({ build: "#100", rooms: [{ x: 5, y: 5, name: "Island", exits: ["n"] }] }, envFor(root));
  assert.match(out, /^Nothing was changed/);
  assert.equal(sent.length, 1);
});

test("dry run plans without writing", async () => {
  const { root, sent } = fakeMoo(() => ok(ROOMS));
  const out = await tools.setRooms({ build: "#100", rooms: [{ x: 2, y: 0, name: "Vault", exits: ["w"] }], dry_run: true }, envFor(root));
  assert.match(out, /Dry run: nothing was changed\. This would run 2 operations/);
  assert.match(out, /create  "Vault" at \(2,0,0\)/);
  assert.match(out, /link    new:2,0,0 w ⇄ e #2/);
  assert.equal(sent.length, 1);
});

test("a write runs each operation, passes new ids on, finishes, and reads back", async () => {
  const { root, sent } = fakeMoo((src) => {
    if (src.includes("$recycler:create(kind")) return ok("#3");
    if (src.includes("a:moveto(here)")) return ok(["#13", "#14", "#100"]);
    if (src.includes("recompute_next_hops")) return ok(1);
    return ok(ROOMS);
  });
  const out = await tools.setRooms({ build: "#100", rooms: [{ x: 2, y: 0, name: "Vault", exits: ["w"] }] }, envFor(root));
  const kinds = sent.map(({ src }) =>
    src.includes("$recycler:create(kind") ? "create" : src.includes("a:moveto") ? "link" : src.includes("recompute_next_hops") ? "finish" : "read");
  assert.deepEqual(kinds, ["read", "create", "link", "finish", "read"]);
  assert.match(sent[2].src, /here = #3;/, "the link reaches the room the create made");
  assert.match(out, /Done \(2\):/);
  assert.match(out, /create  #3 "Vault" at \(2,0,0\)/);
});

test("a failure stops the run and says what did not happen", async () => {
  const { root } = fakeMoo((src) => {
    if (src.includes("$recycler:create(kind")) return { success: false, error: { message: "cell (2,0,0) is already taken by Vault (#9)" }, output: [] };
    return ok(ROOMS);
  });
  const out = await tools.setRooms({ build: "#100", rooms: [{ x: 2, y: 0, name: "Vault", exits: ["w"] }] }, envFor(root));
  assert.match(out, /FAILED, and nothing after it was run:/);
  assert.match(out, /already taken by Vault/);
  assert.match(out, /Not run \(1\):\n  link/);
});

test("a timeout is not reported as a failure to retry", async () => {
  const { root } = fakeMoo((src) => (src.includes("$recycler:create(kind") ? { success: false, timed_out: true, output: [] } : ok(ROOMS)));
  const out = await tools.setRooms({ build: "#100", rooms: [{ x: 2, y: 0, name: "Vault" }] }, envFor(root));
  assert.match(out, /A timeout is not a rollback/);
});

test("a timeout says what the task kept when mooR reports it", async () => {
  for (const [kept, says] of [["No", /rolled back/], ["Yes", /It committed/], ["Unknown", /unknown/]]) {
    const { root } = fakeMoo((src) => (src.includes("$recycler:create(kind") ? { success: false, timed_out: true, kept, output: [] } : ok(ROOMS)));
    const out = await tools.setRooms({ build: "#100", rooms: [{ x: 2, y: 0, name: "Vault" }] }, envFor(root));
    assert.match(out, says, kept);
    assert.match(out, /moo_build_get/);
  }
});

test("without a moo package the error says how to get one; moo_package picks another", async () => {
  await assert.rejects(tools.get({ build: "#1" }, envFor(null)), /no moo package is installed in this space/);
  const { root, sent } = fakeMoo(() => ok(ROOMS));
  await tools.get({ build: "#100" }, envFor(root, { name: "@bitmuse/moo" }));
  assert.equal(sent[0].config.from, "@bitmuse/moo");
  await assert.rejects(tools.get({ build: "#1" }, envFor(root, { config: { moo_package: "@x/y" } })), /moo_package names @x\/y/);
});

test("a build id that is not an object id is refused before connecting", async () => {
  await assert.rejects(tools.get({ build: "#1; recycle(#2)" }, envFor(null)), /build must be an area id/);
});

test("list shows only builds unless all is asked for", async () => {
  const areas = { character: "#50", character_name: "zero", has_builds: 1, areas: [
    { id: "#100", name: "Annex", rooms: 2, authored: 1 }, { id: "#7", name: "Old Town", rooms: 40, authored: 0 }] };
  const { root } = fakeMoo(() => ok(areas));
  const mine = await tools.list({}, envFor(root));
  assert.match(mine, /zero \(#50\)'s builds \(1\):\n  #100 "Annex": 2 rooms/);
  assert.doesNotMatch(mine, /Old Town/);
  assert.match(await tools.list({ all: true }, envFor(root)), /✎ #100 "Annex"[\s\S]*  #7 "Old Town"/);
});

// moo_build_render: one PNG asset per populated level, put in the asset store.
function renderEnv(root, put) {
  const env = envFor(root);
  env.kernel.assets = { put };
  return env;
}
const STACKED = {
  ...ROOMS,
  rooms: [
    ...ROOMS.rooms,
    { id: "#3", name: "Cellar <&> \"vault\"", x: 0, y: 0, z: 1, description: "", players: 0, edges: [],
      exits: [{ id: "#21", dir: "west", twin: "#22", to: "#9", to_name: "Street", to_area: "#200", to_area_name: "Old Town", type: "door", hidden: 0 }] },
  ],
};

test("render returns the text and one PNG asset per populated level", async () => {
  const { root } = fakeMoo(() => ok(STACKED));
  const puts = [];
  const out = await tools.render({ build: "#100" }, renderEnv(root, async (u) => (puts.push(u), { id: `a${puts.length}`, mediaType: u.mediaType, name: u.name, size: 1 })));
  assert.equal(out.type, "tool-result");
  assert.deepEqual(out.content.map((p) => p.type), ["text", "asset", "asset"]);
  assert.deepEqual(puts.map((p) => p.name), ["annex-z0.png", "annex-z1.png"]);
  for (const p of puts) assert.equal(Buffer.from(p.data, "base64").subarray(1, 4).toString(), "PNG");
  assert.match(out.content[0].data.text, /image 1: level z=0 \(ground\), 2 rooms/);
  assert.match(out.content[0].data.text, /image 2: level z=1 \(1 down\), 1 room/);
  assert.deepEqual(out.content[1].data, { id: "a1", mediaType: "image/png", name: "annex-z0.png" });
});

test("render draws one level with z, and says which levels exist when z is empty", async () => {
  const { root } = fakeMoo(() => ok(STACKED));
  const puts = [];
  const env = renderEnv(root, async (u) => (puts.push(u), { id: "x", mediaType: u.mediaType, size: 1 }));
  const one = await tools.render({ build: "#100", z: 1 }, env);
  assert.equal(one.content.filter((p) => p.type === "asset").length, 1);
  assert.match(await tools.render({ build: "#100", z: 7 }, env), /No rooms on level z=7\. Populated levels: 0, 1\./);
});

test("render caps a tall build at six images and names the rest", async () => {
  const tower = { ...ROOMS, rooms: Array.from({ length: 8 }, (_, i) => ({ id: `#${i + 1}`, name: `F${i}`, x: 0, y: 0, z: -i, exits: [], edges: [], players: 0 })) };
  const { root } = fakeMoo(() => ok(tower));
  const out = await tools.render({ build: "#100" }, renderEnv(root, async (u) => ({ id: "x", mediaType: u.mediaType, size: 1 })));
  assert.equal(out.content.filter((p) => p.type === "asset").length, 6);
  assert.match(out.content[0].data.text, /Not drawn: levels -1, 0\. Pass z/);
});

test("render without an asset store says so instead of failing silently", async () => {
  const { root } = fakeMoo(() => ok(STACKED));
  await assert.rejects(tools.render({ build: "#100" }, envFor(root)), /no asset store/);
});

// The files of a canvas: the name rules, the completed index and its checks, atomic writes, the revision, the listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { completeIndex, checkIndex } from "../lib/schema.js";
import { assetList, boardFiles, boardPath, assetPath, isAssetName, isBoardName, isCanvasId, listCanvases, readIndex, removeCanvas, writeIndex } from "../lib/store.js";
import { makeEnv } from "./helpers.js";

test("names: an artboard file, an asset, a canvas id", () => {
  for (const ok of ["Main.html", "a-b_c.1.html", "Detail2.html"]) assert.ok(isBoardName(ok), ok);
  for (const bad of ["", ".hidden.html", "../x.html", "a/b.html", "Main.htm", "Main.HTML", "a b.html", "x".repeat(65) + ".html", "a..b.html", 42]) assert.ok(!isBoardName(bad), String(bad));
  for (const ok of ["hero.png", "Photo.JPG", "font.woff2", "style.css", "clip.mp4"]) assert.ok(isAssetName(ok), ok);
  for (const bad of ["hero.exe", ".env.png", "../x.png", "a/b.png", "hero", "a b.png", "x.html"]) assert.ok(!isAssetName(bad), bad);
  assert.ok(isCanvasId("c_1a2b3c4d"));
  assert.ok(!isCanvasId("c_1A2B3C4D") && !isCanvasId("p_1a2b3c4d") && !isCanvasId("c_1a2b3c4"));
});

test("paths stay under the canvas, and a refused name is a sentence", async () => {
  const { env, done } = await makeEnv();
  assert.equal(boardPath(env, "c_00000001", "Main.html"), resolve(env.cwd, "canvases", "c_00000001", "Main.html"));
  assert.equal(assetPath(env, "c_00000001", "hero.png"), resolve(env.cwd, "canvases", "c_00000001", "assets", "hero.png"));
  assert.throws(() => boardPath(env, "c_00000001", "../x.html"), /not an artboard file name/);
  assert.throws(() => assetPath(env, "c_00000001", "x.exe"), /not an asset name/);
  assert.throws(() => boardPath(env, "nope", "Main.html"), /not a canvas id/);
  await done();
});

test("completeIndex fills defaults, drops what cannot be right, and reconciles the order; checkIndex refuses the limits", () => {
  const index = completeIndex({
    id: "c_00000001",
    title: "  Flow ",
    boards: { "Main.html": { x: 1.6, y: -2.2, props: { accent: "#123", bad_Key: 1, ok: true, obj: {} } }, "bad name.html": { x: 0 }, "Two.html": { w: 300, h: 200, page: "nope-not-listed-but-kept" } },
    order: ["Two.html", "ghost.html", "Two.html"],
    pages: [{ id: "p1", name: "Mobile" }, { id: "p1", name: "Twice" }, { id: "bad id!", name: "x" }],
    notes: { n1: { x: 0, y: 0, text: "hi", kind: "title1", fill: "blue" }, n2: { x: 0, y: 0 }, "bad id": { x: 0, y: 0, text: "x" } },
    launch: { view: "focused", file: "ghost.html" },
    rev: -1,
  });
  assert.equal(index.title, "Flow");
  assert.deepEqual(Object.keys(index.boards), ["Main.html", "Two.html"]);
  assert.deepEqual(index.boards["Main.html"], { x: 2, y: -2, w: 1440, h: 900, props: { accent: "#123", ok: true } });
  assert.deepEqual(index.order, ["Two.html", "Main.html"], "unknown files dropped, duplicates folded, the rest appended");
  assert.deepEqual(index.pages, [{ id: "p1", name: "Mobile" }]);
  assert.deepEqual(Object.keys(index.notes), ["n1"]);
  assert.deepEqual(index.launch, { view: "canvas" }, "a launch naming no artboard falls back");
  assert.equal(index.rev, 0);
  assert.equal(index.project, null);
  assert.throws(() => checkIndex(index), /artboard Two.html: no page nope-not-listed-but-kept/);
  delete index.boards["Two.html"].page;
  assert.equal(checkIndex(index), index);
  assert.throws(() => checkIndex({ ...index, title: "x".repeat(121) }), /1 to 120 characters/);
  assert.throws(() => checkIndex({ ...index, boards: { ...index.boards, "Main.html": { ...index.boards["Main.html"], w: 8 } } }), /w and h are whole numbers from 16 to 16384/);
  assert.throws(() => checkIndex({ ...index, boards: { ...index.boards, "Main.html": { ...index.boards["Main.html"], x: 2e6 } } }), /within ±1000000/);
  assert.throws(() => checkIndex({ ...index, order: ["Main.html"] }), /order must name every artboard once/);
  assert.throws(() => checkIndex({ ...index, notes: { n1: { ...index.notes.n1, fill: "mauve" } } }), /fill is one of/);
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`B${i}.html`, { x: 0, y: 0, w: 100, h: 100 }]));
  assert.throws(() => checkIndex(completeIndex({ id: "c_00000001", title: "x", boards: many })), /at most 64 artboards/);
});

test("writeIndex bumps the revision and the time, writes atomically, and readIndex reads it back; a bad file or a stranger's id reads as nothing", async () => {
  const { env, done } = await makeEnv();
  assert.equal(await readIndex(env, "c_00000001"), null);
  const first = await writeIndex(env, completeIndex({ id: "c_00000001", title: "One", rev: 0 }));
  assert.equal(first.rev, 1);
  assert.ok(first.updatedAt);
  const again = await writeIndex(env, { ...first, title: "One again" });
  assert.equal(again.rev, 2);
  assert.deepEqual(await readIndex(env, "c_00000001"), again);
  const dir = resolve(env.cwd, "canvases", "c_00000001");
  assert.deepEqual(readdirSync(dir), ["canvas.json"], "no temporary file left behind");
  assert.match(readFileSync(resolve(dir, "canvas.json"), "utf8"), /"title": "One again"/);
  await env.writeFile("canvases/c_00000002/canvas.json", "{ not json");
  assert.equal(await readIndex(env, "c_00000002"), null);
  await env.writeFile("canvases/c_00000003/canvas.json", JSON.stringify({ id: "c_00000009", title: "x" }));
  assert.equal(await readIndex(env, "c_00000003"), null, "an index whose id disagrees with its directory is not trusted");
  await env.writeFile("canvases/stray/canvas.json", JSON.stringify({ id: "stray" }));
  assert.deepEqual((await listCanvases(env)).map((c) => c.id), ["c_00000001"], "only real canvases are listed");
  await removeCanvas(env, "c_00000001");
  assert.equal(await readIndex(env, "c_00000001"), null);
  await done();
});

test("boardFiles says each artboard's time and size or that it is missing; assetList the assets by name", async () => {
  const { env, done } = await makeEnv();
  const index = await writeIndex(env, completeIndex({ id: "c_00000001", title: "x", boards: { "Main.html": {}, "Gone.html": {} } }));
  await env.writeFile("canvases/c_00000001/Main.html", "<p>hi</p>");
  await env.writeFile("canvases/c_00000001/assets/b.png", "xx");
  await env.writeFile("canvases/c_00000001/assets/a.svg", "x");
  await env.writeFile("canvases/c_00000001/assets/.tmp.png", "x");
  const files = await boardFiles(env, index);
  assert.equal(files["Main.html"].size, 9);
  assert.ok(files["Main.html"].mtime > 0);
  assert.deepEqual(files["Gone.html"], { missing: true });
  assert.deepEqual(await assetList(env, "c_00000001"), [{ name: "a.svg", size: 1 }, { name: "b.png", size: 2 }]);
  await done();
});

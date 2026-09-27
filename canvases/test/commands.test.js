// The page's commands: the list with project names, one canvas with its files' facts, a save and its
// revision, create, remove, assign, the upload, and the frame's strict path matrix. The UI modules are
// checked for syntax at the end, since no browser runs here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { canvasCreate, canvasWriteBoard, uiAsset, uiAssign, uiCreate, uiFrame, uiGet, uiList, uiRemove, uiSave } from "../index.js";
import { readIndex } from "../lib/store.js";
import { idIn, makeEnv, page } from "./helpers.js";

const PROJECTS = [{ id: "p_00000001", name: "Nova" }];

const text = async (body) => {
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  let out = "";
  for await (const chunk of body) out += chunk;
  return out;
};

test("list names projects and marks a canvas whose project is gone; get carries each file's facts and the assets", async () => {
  const { env, done } = await makeEnv({ projects: PROJECTS });
  assert.deepEqual(await uiList({}, env), { data: { canvases: [], projects: [{ id: "p_00000001", name: "Nova" }] } });
  const a = idIn(await canvasCreate({ title: "A", project: "p_00000001" }, env));
  const b = idIn(await canvasCreate({ title: "B", project: "none" }, env));
  await canvasWriteBoard({ canvas: a, file: "Main.html", html: page() }, env);
  await env.writeFile(`canvases/${b}/canvas.json`, JSON.stringify({ ...(await readIndex(env, b)), project: "p_00000009" }));
  const { data } = await uiList({}, env);
  assert.deepEqual(data.projects, [{ id: "p_00000001", name: "Nova" }]);
  const rowA = data.canvases.find((c) => c.id === a);
  assert.deepEqual({ ...rowA, updatedAt: "", rev: 0 }, { id: a, title: "A", project: "p_00000001", projectName: "Nova", projectMissing: false, boards: 1, updatedAt: "", rev: 0 });
  const rowB = data.canvases.find((c) => c.id === b);
  assert.equal(rowB.projectMissing, true);
  assert.equal(rowB.projectName, null);
  assert.deepEqual((await uiList({ project: "p_00000001" }, env)).data.canvases.map((c) => c.id), [a]);
  assert.deepEqual((await uiList({ project: "none" }, env)).data.canvases, []);
  const got = (await uiGet({ id: a }, env)).data;
  assert.equal(got.canvas.id, a);
  assert.deepEqual(Object.keys(got.files["Main.html"]).sort(), ["decl", "mtime", "problems", "size"]);
  assert.deepEqual(Object.keys(got.files["Main.html"].decl), ["accent", "dark"]);
  assert.deepEqual(got.assets, []);
  await assert.rejects(uiGet({ id: "c_00000000" }, env), /No canvas/);
  await assert.rejects(uiGet({ id: "x" }, env), /A canvas id looks like/);
  await done();
});

test("save applies a patch, answers the revision, and says merged when the page's base was stale; create, assign and remove", async () => {
  const { env, done } = await makeEnv({ projects: PROJECTS });
  const created = (await uiCreate({ title: "  New  ", project: "p_00000001" }, env)).data.canvas;
  assert.equal(created.title, "New");
  assert.equal(created.project, "p_00000001");
  assert.equal(created.rev, 1);
  assert.equal((await uiCreate({}, env)).data.canvas.title, "Untitled canvas");
  await assert.rejects(uiCreate({ project: "p_00000009" }, env), /No project/);
  await canvasWriteBoard({ canvas: created.id, file: "Main.html", html: page() }, env);
  const saved = (await uiSave({ id: created.id, patch: { boards: { "Main.html": { x: 50 } } }, base: 2 }, env)).data;
  assert.equal(saved.rev, 3);
  assert.equal(saved.merged, undefined);
  assert.equal(saved.canvas.boards["Main.html"].x, 50);
  const stale = (await uiSave({ id: created.id, patch: { title: "Later" }, base: 1 }, env)).data;
  assert.equal(stale.merged, true);
  assert.equal(stale.rev, 4);
  await assert.rejects(uiSave({ id: created.id, patch: { boards: { "Nope.html": {} } } }, env), /No artboard Nope.html/);
  assert.deepEqual((await uiAssign({ id: created.id, project: null }, env)).data, { id: created.id, project: null, rev: 5 });
  await assert.rejects(uiAssign({ id: created.id, project: "p_00000009" }, env), /No project/);
  assert.deepEqual((await uiRemove({ id: created.id, board: "Main.html" }, env)).data.removed, "Main.html");
  assert.deepEqual(Object.keys((await readIndex(env, created.id)).boards), []);
  assert.deepEqual((await uiRemove({ id: created.id }, env)).data, { removed: created.id });
  assert.equal(await readIndex(env, created.id), null);
  await done();
});

test("asset: a PUT stores the bytes and bumps the revision, an existing name is not replaced unless asked, a GET serves it", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await canvasCreate({ title: "A" }, env));
  const put = await uiAsset({ id, name: "hero.png" }, env, { method: "PUT", body: Buffer.from("PNG") });
  assert.deepEqual(put, { name: "hero.png", size: 3, rev: 2 });
  assert.deepEqual(await uiAsset({ id, name: "hero.png" }, env, { method: "PUT", body: Buffer.from("PNG2") }), { exists: true, name: "hero.png", size: 3 });
  assert.equal((await uiAsset({ id, name: "hero.png", replace: true }, env, { method: "PUT", body: Buffer.from("PNG2") })).size, 4);
  const got = await uiAsset({ id, name: "hero.png" }, env, { method: "GET" });
  assert.equal(got.headers["content-type"], "image/png");
  assert.equal(await text(got.body), "PNG2");
  assert.equal((await uiAsset({ id, name: "none.png" }, env, { method: "GET" })).status, 404);
  await assert.rejects(uiAsset({ id, name: "x.exe" }, env, { method: "PUT", body: Buffer.from("x") }), /not an asset name/);
  await assert.rejects(uiAsset({ id, name: "x.png" }, env, { method: "PUT", body: Buffer.alloc(0) }), /empty/);
  await done();
});

test("frame: an artboard with the runtime in it, an asset by its relative path, and a refusal for everything else", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await canvasCreate({ title: "A" }, env));
  await canvasWriteBoard({ canvas: id, file: "Main.html", html: page() }, env);
  await env.writeFile(`canvases/${id}/assets/dot.svg`, "<svg/>");
  await env.writeFile(`canvases/${id}/Unlisted.html`, "<p>soon</p>");
  const doc = await uiFrame({ canvas: id }, env, { path: "Main.html" });
  assert.equal(doc.headers["content-type"], "text/html; charset=utf-8");
  assert.match(doc.body, /^<!doctype html><html><head><script data-canvas-runtime>/);
  assert.match(doc.body, /canvas-props/);
  const unlisted = await uiFrame({ canvas: id }, env, { path: "Unlisted.html" });
  assert.match(unlisted.body, /<p>soon<\/p>/, "a file on disk previews before the index names it");
  const svg = await uiFrame({ canvas: id }, env, { path: "assets/dot.svg" });
  assert.equal(svg.headers["content-type"], "image/svg+xml");
  assert.equal(svg.headers["content-length"], "6");
  assert.ok(svg.body instanceof Readable);
  assert.equal(await text(svg.body), "<svg/>");
  for (const bad of ["", "canvas.json", "assets", "assets/", "assets/none.svg", "assets/x.exe", "assets/../Main.html", ".hidden.html", "sub/Main.html", "Main.htm"]) {
    const out = await uiFrame({ canvas: id }, env, { path: bad });
    assert.equal(out.status, 404, `refused: ${JSON.stringify(bad)}`);
    assert.equal(out.headers["content-type"], "text/plain; charset=utf-8");
  }
  await assert.rejects(uiFrame({ canvas: "c_00000000" }, env, { path: "Main.html" }), /No canvas/);
  await assert.rejects(uiFrame({}, env, { path: "Main.html" }), /minted for one canvas/);
  await done();
});

test("the browser modules parse", () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) execFileSync(process.execPath, ["--check", resolve(dir, file)]);
  assert.ok(readFileSync(resolve(dir, "index.css"), "utf8").includes(".cv-"));
});

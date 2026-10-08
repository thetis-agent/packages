// The seven tools with a fake env: create in a project or the conversation's own, list, write an artboard
// and where it lands, replace one and keep its frame, the layout patch, assets from a path and from bytes,
// delete an artboard and a canvas, and how a canvas is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canvasAsset, canvasCreate, canvasDelete, canvasEditBoard, canvasLayout, canvasList, canvasRead, canvasWriteBoard } from "../index.js";
import { readIndex } from "../lib/store.js";
import { idIn, makeEnv, page } from "./helpers.js";

const PROJECTS = [{ id: "p_00000001", name: "Nova" }, { id: "p_00000002", name: "Orion" }];

test("create: in the conversation's project by default, in a named one, global with none; a project that is not there is refused", async () => {
  const { env, done } = await makeEnv({ session: "s_1", projects: PROJECTS, assignments: { s_1: "p_00000001" } });
  const own = await canvasCreate({ title: "Flow" }, env);
  assert.match(own, /^Created canvas c_[0-9a-f]{8} "Flow", project "Nova" \(p_00000001\) \(this conversation's project\)\. Add artboards with canvas_write_board; the person opens it from Canvases in the sidebar\. rev 1\.$/);
  const named = await canvasCreate({ title: "Other", project: "p_00000002", pages: [{ id: "m", name: "Mobile" }] }, env);
  assert.match(named, /project "Orion"/);
  assert.deepEqual((await readIndex(env, idIn(named))).pages, [{ id: "m", name: "Mobile" }]);
  const global = await canvasCreate({ title: "Loose", project: "none" }, env);
  assert.match(global, /"Loose", global\./);
  await assert.rejects(canvasCreate({ title: "x", project: "p_00000009" }, env), /No project p_00000009/);
  await assert.rejects(canvasCreate({ title: "x", project: "nova" }, env), /not a project id/);
  await assert.rejects(canvasCreate({}, env), /title is required/);
  const record = await readIndex(env, idIn(own));
  assert.equal(record.createdBy, "s_1");
  assert.equal(record.project, "p_00000001");
  const list = await canvasList({}, env);
  assert.equal(list.split("\n").length, 3);
  assert.match(list, /"Flow" · 0 artboards · project "Nova" \(p_00000001\) · updated just now · rev 1/);
  assert.equal((await canvasList({ project: "none" }, env)).split("\n").length, 1);
  assert.equal((await canvasList({ project: "p_00000002" }, env)).split("\n").length, 1);
  await done();
});

test("a conversation without a project, or without the projects package at all, makes a global canvas", async () => {
  const { env, done } = await makeEnv({ session: "s_9" });
  assert.match(await canvasCreate({ title: "Alone" }, env), /"Alone", global\. /);
  assert.equal(await canvasList({}, env), (await canvasList({}, env)).trim());
  await done();
});

test("write_board: a new artboard is placed to the right, sized by default, with its props read; a replaced one keeps its frame; warnings are said", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await canvasCreate({ title: "Flow" }, env));
  const first = await canvasWriteBoard({ canvas: id, file: "Main.html", html: page(), props: { accent: "#fff" } }, env);
  assert.match(first, /^Wrote Main.html \(1 KB\) at \(0,0\) 1440×900 on canvas c_[0-9a-f]{8}; props: accent \(color\), dark \(toggle\)\. rev 2\.$/);
  const second = await canvasWriteBoard({ canvas: "Flow", file: "Detail.html", html: page(390, 844), w: 390, h: 844, radius: 40, title: "Detail" }, env);
  assert.match(second, /Wrote Detail.html .* at \(1520,0\) 390×844/);
  let index = await readIndex(env, id);
  assert.deepEqual(index.boards["Main.html"], { x: 0, y: 0, w: 1440, h: 900, props: { accent: "#fff" } });
  assert.deepEqual(index.boards["Detail.html"], { x: 1520, y: 0, w: 390, h: 844, radius: 40, title: "Detail" });
  assert.deepEqual(index.order, ["Main.html", "Detail.html"]);
  assert.equal(readFileSync(resolve(env.cwd, "canvases", id, "Main.html"), "utf8"), page());
  const replaced = await canvasWriteBoard({ canvas: id, file: "Main.html", html: page(1440, 900, "<img src='https://cdn.example.com/x.png'>") }, env);
  assert.match(replaced, /^Replaced Main.html .* at \(0,0\) 1440×900/);
  assert.match(replaced, /Warnings:\n- It reaches cdn.example.com/);
  index = await readIndex(env, id);
  assert.deepEqual(index.boards["Main.html"].props, { accent: "#fff" }, "a replaced artboard keeps its overrides");
  const noDoctype = await canvasWriteBoard({ canvas: id, file: "Main.html", html: "<html><body>x</body></html>", x: 5, y: 6, props: { dark: true } }, env);
  assert.match(noDoctype, /does not start with <!doctype html>/);
  index = await readIndex(env, id);
  assert.deepEqual(index.boards["Main.html"], { x: 5, y: 6, w: 1440, h: 900, props: { dark: true } }, "props given replace the overrides whole");
  await assert.rejects(canvasWriteBoard({ canvas: id, file: "bad name.html", html: "x" }, env), /not an artboard file name/);
  await assert.rejects(canvasWriteBoard({ canvas: id, file: "Big.html", html: "x".repeat(512 * 1024 + 1) }, env), /at most 512 KB/);
  await assert.rejects(canvasWriteBoard({ canvas: id, file: "X.html", html: "x", page: "nope" }, env), /no page nope/);
  assert.ok(!existsSync(resolve(env.cwd, "canvases", id, "bad name.html")));
  await done();
});

test("read: the index, a line per artboard, the sources on request within the budget", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await canvasCreate({ title: "Flow" }, env));
  await canvasWriteBoard({ canvas: id, file: "Main.html", html: page() }, env);
  await canvasWriteBoard({ canvas: id, file: "Two.html", html: "<!doctype html><html><body>two</body></html>" }, env);
  const plain = await canvasRead({ canvas: id }, env);
  assert.match(plain, /^Canvas c_[0-9a-f]{8} "Flow" · global · rev 3\n/);
  assert.match(plain, /"boards": \{/);
  assert.match(plain, /\nMain.html: 1440×900 at \(0,0\), 1 KB, props: accent \(color\), dark \(toggle\)\n/);
  assert.match(plain, /\nTwo.html: 1440×900 at \(1520,0\), 1 KB, props: none/);
  assert.doesNotMatch(plain, /--- Main.html ---/);
  const withSources = await canvasRead({ canvas: id, sources: true, boards: ["Two.html"] }, env);
  assert.match(withSources, /--- Two.html ---\n<!doctype html><html><body>two<\/body><\/html>/);
  assert.doesNotMatch(withSources, /--- Main.html ---/);
  await assert.rejects(canvasRead({ canvas: "c_00000000" }, env), /No canvas c_00000000/);
  await assert.rejects(canvasRead({ canvas: "Nope" }, env), /No canvas named "Nope"/);
  await canvasCreate({ title: "flow" }, env);
  await assert.rejects(canvasRead({ canvas: "FLOW" }, env), /2 canvases are named "FLOW"/);
  await done();
});

test("layout applies a patch on a fresh read and says what it touched", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await canvasCreate({ title: "Flow" }, env));
  await canvasWriteBoard({ canvas: id, file: "Main.html", html: page() }, env);
  const out = await canvasLayout({ canvas: id, title: "Onboarding", boards: { "Main.html": { x: 100, title: "Home" } }, notes: { t: { x: 0, y: -150, text: "Row one", kind: "title1" } }, pages: [{ id: "m", name: "Mobile" }] }, env);
  assert.equal(out, "Applied: title, pages: 1, artboard Main.html, 1 note. rev 3.");
  const index = await readIndex(env, id);
  assert.equal(index.title, "Onboarding");
  assert.equal(index.boards["Main.html"].x, 100);
  assert.equal(index.notes.t.text, "Row one");
  await assert.rejects(canvasLayout({ canvas: id }, env), /Nothing to change/);
  await assert.rejects(canvasLayout({ canvas: id, boards: { "Nope.html": { x: 1 } } }, env), /No artboard Nope.html/);
  await done();
});

test("asset: from a path in the space or from base64, one or the other, within the caps, and the reference to use", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await canvasCreate({ title: "Flow" }, env));
  await env.writeFile("pics/hero.png", "PNGBYTES");
  const fromPath = await canvasAsset({ canvas: id, name: "hero.png", path: "pics/hero.png" }, env);
  assert.match(fromPath, /^Stored assets\/hero.png \(1 KB\) on canvas c_[0-9a-f]{8}\. Reference it from an artboard by that relative path, for example <img src="assets\/hero.png">\. rev 2\.$/);
  assert.equal(readFileSync(resolve(env.cwd, "canvases", id, "assets", "hero.png"), "utf8"), "PNGBYTES");
  await canvasAsset({ canvas: id, name: "dot.svg", base64: Buffer.from("<svg/>").toString("base64") }, env);
  assert.equal(readFileSync(resolve(env.cwd, "canvases", id, "assets", "dot.svg"), "utf8"), "<svg/>");
  await assert.rejects(canvasAsset({ canvas: id, name: "x.png" }, env), /exactly one of path/);
  await assert.rejects(canvasAsset({ canvas: id, name: "x.png", path: "a", base64: "b" }, env), /exactly one of path/);
  await assert.rejects(canvasAsset({ canvas: id, name: "x.exe", base64: "AA==" }, env), /not an asset name/);
  await assert.rejects(canvasAsset({ canvas: id, name: "x.png", base64: "not base64!" }, env), /not valid base64/);
  await assert.rejects(canvasAsset({ canvas: id, name: "x.png", path: "pics/none.png" }, env), /does not exist/);
  await assert.rejects(canvasAsset({ canvas: id, name: "x.png", path: "../../etc/passwd" }, env), /./, "a path outside the space is refused by tools-files");
  await assert.rejects(canvasAsset({ canvas: id, name: "big.png", base64: Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64") }, env), /at most 16384 KB/);
  await done();
});

test("delete: one artboard leaves the notes and fixes the launch; the whole canvas goes with its directory", async () => {
  const { env, done } = await makeEnv();
  const id = idIn(await canvasCreate({ title: "Flow" }, env));
  await canvasWriteBoard({ canvas: id, file: "Main.html", html: page() }, env);
  await canvasWriteBoard({ canvas: id, file: "Two.html", html: page() }, env);
  await canvasLayout({ canvas: id, launch: { view: "focused", file: "Two.html" }, notes: { n: { x: 0, y: 0, text: "keep" } } }, env);
  const one = await canvasDelete({ canvas: id, board: "Two.html" }, env);
  assert.match(one, /^Deleted artboard Two.html from canvas c_[0-9a-f]{8}; 1 left, the notes kept\. rev 5\.$/);
  const index = await readIndex(env, id);
  assert.deepEqual(Object.keys(index.boards), ["Main.html"]);
  assert.deepEqual(index.order, ["Main.html"]);
  assert.deepEqual(index.launch, { view: "canvas" });
  assert.equal(index.notes.n.text, "keep");
  assert.ok(!existsSync(resolve(env.cwd, "canvases", id, "Two.html")));
  await assert.rejects(canvasDelete({ canvas: id, board: "Two.html" }, env), /No artboard "Two.html"/);
  const all = await canvasDelete({ canvas: id }, env);
  assert.match(all, /^Deleted canvas c_[0-9a-f]{8} "Flow" \(1 artboard, its assets and notes\)\.$/);
  assert.ok(!existsSync(resolve(env.cwd, "canvases", id)));
  await done();
});

test("canvas_edit_board: exact edits in order, all or none, the frame and props kept", async (t) => {
  const { home, env, done } = await makeEnv();
  t.after(done);
  const id = idIn(await canvasCreate({ title: "Edits" }, env));
  await canvasWriteBoard({ canvas: id, file: "Main.html", html: page(390, 844, "<h1>Hello</h1><p>a</p><p>a</p>"), w: 390, h: 844, props: { accent: "#ff0000" } }, env);
  const file = resolve(home, "canvases", id, "Main.html");
  const before = readFileSync(file, "utf8");

  const out = await canvasEditBoard({ canvas: id, file: "Main.html", edits: [{ old_text: "<h1>Hello</h1>", new_text: "<h1>Welcome</h1>" }, { old_text: "<p>a</p>", new_text: "<p>b</p>", replace_all: true }] }, env);
  assert.match(out, /^Edited Main\.html on canvas c_[0-9a-f]{8} .*rev 3\.\nEdit 1: line 1\nEdit 2: 2 places from line 1$/);
  const after = readFileSync(file, "utf8");
  assert.equal(after, before.replace("<h1>Hello</h1>", "<h1>Welcome</h1>").replaceAll("<p>a</p>", "<p>b</p>"));
  const index = await readIndex(env, id);
  assert.deepEqual({ w: index.boards["Main.html"].w, h: index.boards["Main.html"].h, props: index.boards["Main.html"].props }, { w: 390, h: 844, props: { accent: "#ff0000" } });

  // A failing edit refuses the whole call: the first edit does not land either.
  await assert.rejects(canvasEditBoard({ canvas: id, file: "Main.html", edits: [{ old_text: "Welcome", new_text: "Hi" }, { old_text: "nowhere", new_text: "x" }] }, env), /Edit 2: old_text was not found in Main\.html after the edits before it/);
  await assert.rejects(canvasEditBoard({ canvas: id, file: "Main.html", edits: [{ old_text: "<p>b</p>", new_text: "<p>c</p>" }] }, env), /appears 2 times/);
  await assert.rejects(canvasEditBoard({ canvas: id, file: "Other.html", edits: [{ old_text: "a", new_text: "b" }] }, env), /No artboard "Other\.html"/);
  await assert.rejects(canvasEditBoard({ canvas: id, file: "Main.html", edits: [] }, env), /edits is required/);
  assert.equal(readFileSync(file, "utf8"), after, "nothing landed");
  assert.equal((await readIndex(env, id)).rev, 3);

  const warned = await canvasEditBoard({ canvas: id, file: "Main.html", edits: [{ old_text: "<h1>Welcome</h1>", new_text: '<img src="https://example.com/x.png">' }] }, env);
  assert.match(warned, /Warnings:\n- It reaches example\.com/);
});

// The commands the package's own page sends, run in the gateway as the person: the list for the sidebar,
// one canvas for a tab, a layout patch from a drag or a field, create, remove, assign to a project, an
// upload, and the frame that serves an artboard and its assets to the sandboxed iframe. Each answers
// `{ data }`; a refusal is a thrown Error the gateway answers as `400 { error }`. The frame export is the
// one place HTML leaves this package: it serves exactly one artboard file or one asset under the canvas the
// token was minted for, with the frame runtime put into the document, and 404s everything else.
import { createReadStream } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { applyPatch } from "./patch.js";
import { isProjectId, projectExists, projectNames } from "./projects.js";
import { declaredProps, injectRuntime } from "./props.js";
import { completeIndex } from "./schema.js";
import { assetList, assetPath, atomicWrite, boardFiles, boardPath, canvasBytes, fail, isAssetName, isBoardName, isCanvasId, LIMITS, listCanvases, newId, readIndex, removeCanvas, typeOf, writeIndex } from "./store.js";

const summary = (c, names) => ({
  id: c.id,
  title: c.title,
  project: c.project,
  projectName: c.project ? names.get(c.project) ?? null : null,
  projectMissing: Boolean(c.project) && !names.has(c.project),
  boards: Object.keys(c.boards).length,
  updatedAt: c.updatedAt,
  rev: c.rev,
});

/** The rows the sidebar and the watcher's snapshot share, with the project names read once. */
export async function summaries(env) {
  const all = await listCanvases(env);
  const names = await projectNames(env, all.map((c) => c.project).filter(Boolean));
  return { canvases: all.map((c) => summary(c, names)), projects: [...names].map(([id, name]) => ({ id, name })) };
}

/** list: every canvas (or one project's, or the global ones with "none") with its project's name, and every project there is, for the menus. */
export async function uiList(args, env) {
  const { canvases, projects } = await summaries(env);
  const project = args.project;
  const rows = project === undefined || project === null || project === "all" ? canvases : project === "none" ? canvases.filter((c) => !c.project) : canvases.filter((c) => c.project === project);
  return { data: { canvases: rows, projects } };
}

async function indexOrFail(env, id) {
  if (!isCanvasId(id)) fail("A canvas id looks like c_1a2b3c4d.");
  const index = await readIndex(env, id);
  if (!index) fail(`No canvas ${id}.`);
  return index;
}

/** get: one canvas's index, each artboard file's time, size and declared props, and the assets. */
export async function uiGet(args, env) {
  const index = await indexOrFail(env, args.id);
  const files = await boardFiles(env, index);
  for (const file of Object.keys(files)) {
    if (files[file].missing) continue;
    try {
      const { decl, problems } = declaredProps(await readFile(boardPath(env, index.id, file), "utf8"));
      files[file] = { ...files[file], decl, problems };
    } catch {
      files[file] = { missing: true };
    }
  }
  return { data: { canvas: index, files, assets: await assetList(env, index.id) } };
}

/** save: a layout patch on a fresh read. `base` is the revision the page last saw; a different one is applied anyway and answered `merged`. */
export async function uiSave(args, env) {
  const index = await indexOrFail(env, args.id);
  const { index: next } = applyPatch(index, args.patch ?? {});
  const written = await writeIndex(env, next);
  return { data: { rev: written.rev, canvas: written, ...(args.base !== undefined && args.base !== index.rev ? { merged: true } : {}) } };
}

/** create: an empty canvas, in the project the page chose (which must exist) or none. */
export async function uiCreate(args, env) {
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Untitled canvas";
  const project = args.project ?? null;
  if (project !== null) {
    if (!isProjectId(project)) fail("project must be a project id, or null.");
    if (!(await projectExists(env, project))) fail(`No project ${project}.`);
  }
  if ((await listCanvases(env)).length >= LIMITS.canvases) fail(`At most ${LIMITS.canvases} canvases; delete one first.`);
  const now = new Date().toISOString();
  const written = await writeIndex(env, completeIndex({ id: newId(), title, project, createdAt: now, updatedAt: now, rev: 0 }));
  return { data: { canvas: written } };
}

/** remove: one artboard (its file and frame; the notes stay) with `board`, else the whole canvas. */
export async function uiRemove(args, env) {
  const index = await indexOrFail(env, args.id);
  if (typeof args.board === "string" && args.board) {
    const file = args.board;
    if (!isBoardName(file) || !index.boards[file]) fail(`No artboard ${file} on this canvas.`);
    await unlink(boardPath(env, index.id, file)).catch((e) => {
      if (e?.code !== "ENOENT") throw e;
    });
    const boards = { ...index.boards };
    delete boards[file];
    const launch = index.launch.view === "focused" && index.launch.file === file ? { view: "canvas" } : index.launch;
    const written = await writeIndex(env, { ...index, boards, order: index.order.filter((f) => f !== file), launch });
    return { data: { removed: file, rev: written.rev, canvas: written } };
  }
  await removeCanvas(env, index.id);
  return { data: { removed: index.id } };
}

/** assign: the canvas's project, or null for global. */
export async function uiAssign(args, env) {
  const index = await indexOrFail(env, args.id);
  const project = args.project ?? null;
  if (project !== null) {
    if (!isProjectId(project)) fail("project must be a project id, or null.");
    if (!(await projectExists(env, project))) fail(`No project ${project}.`);
  }
  const written = await writeIndex(env, { ...index, project });
  return { data: { id: written.id, project: written.project, rev: written.rev } };
}

/**
 * asset (raw): `PUT` stores the body as `assets/<name>` under the canvas — `{ exists: true }` when a file of
 * that name is there and `replace` was not asked, else `{ name, size }` — and touches the index so watchers
 * notice; `GET` serves one asset, for a preview on the page.
 */
export async function uiAsset(args, env, req) {
  const index = await indexOrFail(env, args.id);
  if (!isAssetName(args.name)) fail(`${JSON.stringify(args.name)} is not an asset name: letters, digits, _ . and -, with one of the extensions png jpg jpeg gif webp svg css js json woff woff2 ttf otf mp4 webm mp3.`);
  const absolute = assetPath(env, index.id, args.name);
  if (req.method === "GET") {
    let st;
    try {
      st = await stat(absolute);
    } catch {
      return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "not here" };
    }
    return { headers: { "content-type": typeOf(args.name), "content-length": String(st.size), etag: `${Math.round(st.mtimeMs)}-${st.size}` }, body: createReadStream(absolute) };
  }
  const body = req.body ?? Buffer.alloc(0);
  if (!body.length) fail("The upload is empty.");
  if (body.length > LIMITS.asset) fail(`That file is larger than ${Math.round(LIMITS.asset / 1024 / 1024)} MB.`);
  const there = await stat(absolute).catch(() => null);
  if (there && !args.replace) return { exists: true, name: args.name, size: there.size };
  const held = (await canvasBytes(env, index.id)) - (there?.size ?? 0);
  if (held + body.length > LIMITS.canvas) fail(`This canvas holds ${Math.round(held / 1024 / 1024)} MB; another ${Math.round(body.length / 1024)} KB would pass its ${Math.round(LIMITS.canvas / 1024 / 1024)} MB.`);
  await atomicWrite(absolute, body);
  const written = await writeIndex(env, index);
  return { name: args.name, size: body.length, rev: written.rev };
}

const refuse = (what) => ({ status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: `not here: ${what}` });

/**
 * frame: what the sandboxed iframe fetches under its token, minted for `{ canvas }`. Exactly two shapes of
 * path are served — `<Board>.html`, an artboard with the runtime put in, and `assets/<name>` — and
 * everything else (the root, the index, dot-files, anything nested) is refused. A file is served by its
 * bytes on disk, so an artboard written a moment ago but not yet in the index previews all the same.
 */
export async function uiFrame(args, env, req) {
  if (!isCanvasId(args.canvas)) fail("A frame is minted for one canvas: { canvas: \"c_…\" }.");
  const id = args.canvas;
  if (!(await readIndex(env, id))) fail(`No canvas ${id}.`);
  const path = String(req?.path ?? "");
  const asset = /^assets\/([^/]+)$/.exec(path);
  if (asset && isAssetName(asset[1])) {
    const absolute = assetPath(env, id, asset[1]);
    let st;
    try {
      st = await stat(absolute);
      if (!st.isFile()) return refuse(path);
    } catch {
      return refuse(path);
    }
    return { headers: { "content-type": typeOf(asset[1]), "content-length": String(st.size), etag: `${Math.round(st.mtimeMs)}-${st.size}` }, body: createReadStream(absolute) };
  }
  if (isBoardName(path)) {
    let html;
    try {
      const st = await stat(boardPath(env, id, path));
      if (!st.isFile() || st.size > 2 * LIMITS.html) return refuse(path);
      html = await readFile(boardPath(env, id, path), "utf8");
    } catch {
      return refuse(path);
    }
    return { headers: { "content-type": "text/html; charset=utf-8" }, body: injectRuntime(html) };
  }
  return refuse(path);
}

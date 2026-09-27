// The seven tools, run in the person's fence. Each names its canvas by id or unique title (lib/resolve.js),
// answers one plain sentence with the revision it left, and refuses with a sentence. The layout rules live
// in lib/patch.js and lib/schema.js, shared with the page's commands; the authoring rules for an artboard's
// HTML are in the `canvases` skill, which the descriptions point the model to.
import { readFile, unlink } from "node:fs/promises";
import { resolveContained } from "@thetis/tools-files/lib/paths.js";
import { applyPatch } from "./patch.js";
import { isProjectId, projectExists, projectOfSession, readProject } from "./projects.js";
import { declaredProps, externalRefs } from "./props.js";
import { resolveCanvas } from "./resolve.js";
import { completeIndex } from "./schema.js";
import { assetPath, atomicWrite, boardPath, canvasBytes, fail, isAssetName, isBoardName, LIMITS, listCanvases, newId, removeCanvas, writeIndex } from "./store.js";
import { autoPlace } from "../ui/geometry.js";

const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** A project for a canvas: the id given (must exist), "none" for global, or the conversation's own when nothing was said. */
async function projectFor(env, given) {
  if (given === undefined || given === null || given === "") {
    const own = await projectOfSession(env, env.session?.id);
    return { project: own, defaulted: Boolean(own) };
  }
  if (given === "none" || given === "global") return { project: null, defaulted: false };
  if (!isProjectId(given)) fail(`${JSON.stringify(given)} is not a project id; one looks like p_1a2b3c4d. Say "none" for a global canvas.`);
  if (!(await projectExists(env, given))) fail(`No project ${given}.`);
  return { project: given, defaulted: false };
}

async function projectPhrase(env, id) {
  if (!id) return "global";
  const record = await readProject(env, id);
  return `project ${record ? `${JSON.stringify(record.name)} (${id})` : `${id} (no longer there)`}`;
}

const propsLine = (decl) => (decl && Object.keys(decl).length ? Object.entries(decl).map(([k, s]) => `${k} (${s.editor})`).join(", ") : "none");

export async function canvasCreate(args, env) {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) fail("title is required.");
  const { project, defaulted } = await projectFor(env, args.project);
  if ((await listCanvases(env)).length >= LIMITS.canvases) fail(`At most ${LIMITS.canvases} canvases; delete one first with canvas_delete.`);
  const now = new Date().toISOString();
  const draft = completeIndex({ id: newId(), title, project, createdBy: env.session?.id ?? null, launch: { view: "canvas" }, pages: [], createdAt: now, updatedAt: now, rev: 0 });
  const { index } = applyPatch(draft, { ...(args.pages !== undefined ? { pages: args.pages } : {}), ...(args.launch !== undefined && args.launch?.view !== "focused" ? { launch: args.launch } : {}) });
  const written = await writeIndex(env, index);
  const where = await projectPhrase(env, written.project);
  return `Created canvas ${written.id} ${JSON.stringify(written.title)}, ${where}${defaulted ? " (this conversation's project)" : ""}. Add artboards with canvas_write_board; the person opens it from Canvases in the sidebar. rev ${written.rev}.`;
}

export async function canvasList(args, env) {
  let all = await listCanvases(env);
  if (args.project !== undefined && args.project !== null && args.project !== "") {
    if (args.project === "none" || args.project === "global") all = all.filter((c) => !c.project);
    else if (isProjectId(args.project)) all = all.filter((c) => c.project === args.project);
    else fail(`${JSON.stringify(args.project)} is not a project id; say "none" for the global canvases.`);
  }
  if (!all.length) return "No canvases yet. canvas_create makes one.";
  const lines = [];
  for (const c of all) {
    const n = Object.keys(c.boards).length;
    lines.push(`${c.id} ${JSON.stringify(c.title)} · ${n} artboard${n === 1 ? "" : "s"} · ${await projectPhrase(env, c.project)} · updated ${ago(c.updatedAt)} · rev ${c.rev}`);
  }
  return lines.join("\n");
}

export async function canvasRead(args, env) {
  const index = await resolveCanvas(env, args.canvas);
  const only = Array.isArray(args.boards) ? args.boards.filter((f) => typeof f === "string") : null;
  const files = Object.keys(index.boards).filter((f) => !only || only.includes(f));
  const out = [`Canvas ${index.id} ${JSON.stringify(index.title)} · ${await projectPhrase(env, index.project)} · rev ${index.rev}`, "", JSON.stringify(index, null, 2), ""];
  const sources = [];
  let budget = 200 * 1024;
  for (const file of Object.keys(index.boards)) {
    const b = index.boards[file];
    let html = null;
    try {
      html = await readFile(boardPath(env, index.id, file), "utf8");
    } catch {
      out.push(`${file}: ${b.w}×${b.h} at (${b.x},${b.y}) — the file is MISSING; write it with canvas_write_board.`);
      continue;
    }
    const { decl, problems } = declaredProps(html);
    out.push(`${file}: ${b.w}×${b.h} at (${b.x},${b.y})${b.page ? ` on page ${b.page}` : ""}, ${kb(Buffer.byteLength(html))}, props: ${propsLine(decl)}${b.props ? `, set: ${JSON.stringify(b.props)}` : ""}${problems.length ? ` — ${problems.join(" ")}` : ""}`);
    if (args.sources && files.includes(file)) {
      if (budget <= 0) {
        sources.push(`--- ${file} --- [not included: over 200 KB of sources in this answer]`);
        continue;
      }
      const piece = html.length > budget ? `${html.slice(0, budget)}\n[truncated]` : html;
      budget -= html.length;
      sources.push(`--- ${file} ---`, piece);
    }
  }
  if (sources.length) out.push("", ...sources);
  return out.join("\n");
}

export async function canvasWriteBoard(args, env) {
  const index = await resolveCanvas(env, args.canvas);
  if (!isBoardName(args.file)) fail(`${JSON.stringify(args.file)} is not an artboard file name: letters, digits, _ . and -, ending in .html, like Main.html.`);
  if (typeof args.html !== "string" || !args.html.trim()) fail("html is required: the whole document.");
  const bytes = Buffer.byteLength(args.html);
  if (bytes > LIMITS.html) fail(`The HTML is ${kb(bytes)}; at most ${kb(LIMITS.html)}. Move pictures and fonts to canvas_asset.`);
  const file = args.file;
  const existing = index.boards[file];
  if (!existing && Object.keys(index.boards).length >= LIMITS.boards) fail(`A canvas holds at most ${LIMITS.boards} artboards.`);
  const warnings = [];
  if (!/^\s*<!doctype html>/i.test(args.html)) warnings.push("The document does not start with <!doctype html>.");
  const hosts = externalRefs(args.html);
  if (hosts.length) warnings.push(`It reaches ${hosts.join(", ")}, which the frame will not load: only Google Fonts is allowed; store pictures with canvas_asset and reference them as assets/<name>.`);
  const { decl, problems } = declaredProps(args.html);
  warnings.push(...problems);

  await atomicWrite(boardPath(env, index.id, file), args.html);
  const page = args.page === undefined ? existing?.page : args.page;
  const w = args.w ?? existing?.w ?? 1440;
  const h = args.h ?? existing?.h ?? 900;
  const placed = existing ? { x: existing.x, y: existing.y } : autoPlace(index, page ?? null, w, h);
  const change = {
    x: args.x ?? placed.x,
    y: args.y ?? placed.y,
    w,
    h,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.page !== undefined ? { page: args.page } : {}),
    ...(args.expand !== undefined ? { expand: args.expand } : {}),
    ...(args.radius !== undefined ? { radius: args.radius } : {}),
  };
  const draft = existing ? index : { ...index, boards: { ...index.boards, [file]: { x: 0, y: 0, w, h } }, order: [...index.order, file] };
  let { index: next } = applyPatch(draft, { boards: { [file]: change } });
  if (args.props !== undefined) {
    if (!args.props || typeof args.props !== "object" || Array.isArray(args.props)) fail("props must be an object of values by prop name.");
    const cleared = Object.fromEntries(Object.keys(next.boards[file].props ?? {}).map((k) => [k, null]));
    next = applyPatch(next, { boards: { [file]: { props: { ...cleared, ...args.props } } } }).index;
  }
  const written = await writeIndex(env, next);
  const b = written.boards[file];
  const head = `${existing ? "Replaced" : "Wrote"} ${file} (${kb(bytes)}) at (${b.x},${b.y}) ${b.w}×${b.h}${b.page ? ` on page ${b.page}` : ""} on canvas ${written.id}; props: ${propsLine(decl)}. rev ${written.rev}.`;
  return warnings.length ? `${head}\nWarnings:\n- ${warnings.join("\n- ")}` : head;
}

export async function canvasLayout(args, env) {
  const { canvas, ...patch } = args;
  const index = await resolveCanvas(env, canvas);
  if (!Object.keys(patch).length) fail("Nothing to change: give a title, launch, pages, boards, order or notes.");
  const { index: next, touched } = applyPatch(index, patch);
  const written = await writeIndex(env, next);
  return `Applied: ${touched.join(", ")}. rev ${written.rev}.`;
}

export async function canvasAsset(args, env) {
  const index = await resolveCanvas(env, args.canvas);
  if (!isAssetName(args.name)) fail(`${JSON.stringify(args.name)} is not an asset name: letters, digits, _ . and -, with one of the extensions png jpg jpeg gif webp svg css js json woff woff2 ttf otf mp4 webm mp3.`);
  const hasPath = typeof args.path === "string" && args.path;
  const hasBytes = typeof args.base64 === "string" && args.base64;
  if (Boolean(hasPath) === Boolean(hasBytes)) fail("Give exactly one of path (a file in your space) or base64 (the bytes).");
  let bytes;
  if (hasPath) {
    const { absolute } = await resolveContained(env, args.path);
    try {
      bytes = await readFile(absolute);
    } catch (e) {
      fail(e?.code === "ENOENT" ? `${args.path} does not exist.` : `${args.path} could not be read: ${e?.message ?? e}`);
    }
  } else {
    const clean = args.base64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) fail("base64 is not valid base64.");
    bytes = Buffer.from(clean, "base64");
  }
  if (!bytes.length) fail("The asset is empty.");
  if (bytes.length > LIMITS.asset) fail(`The asset is ${kb(bytes.length)}; at most ${kb(LIMITS.asset)}.`);
  const held = await canvasBytes(env, index.id);
  if (held + bytes.length > LIMITS.canvas) fail(`This canvas holds ${kb(held)}; another ${kb(bytes.length)} would pass its ${kb(LIMITS.canvas)}.`);
  await atomicWrite(assetPath(env, index.id, args.name), bytes);
  const written = await writeIndex(env, index);
  return `Stored assets/${args.name} (${kb(bytes.length)}) on canvas ${written.id}. Reference it from an artboard by that relative path, for example <img src="assets/${args.name}">. rev ${written.rev}.`;
}

export async function canvasDelete(args, env) {
  const index = await resolveCanvas(env, args.canvas);
  if (args.board !== undefined && args.board !== null && args.board !== "") {
    const file = args.board;
    if (!isBoardName(file) || !index.boards[file]) fail(`No artboard ${JSON.stringify(file)} on canvas ${index.id}.`);
    await unlink(boardPath(env, index.id, file)).catch((e) => {
      if (e?.code !== "ENOENT") throw e;
    });
    const boards = { ...index.boards };
    delete boards[file];
    const launch = index.launch.view === "focused" && index.launch.file === file ? { view: "canvas" } : index.launch;
    const written = await writeIndex(env, { ...index, boards, order: index.order.filter((f) => f !== file), launch });
    return `Deleted artboard ${file} from canvas ${written.id}; ${Object.keys(written.boards).length} left, the notes kept. rev ${written.rev}.`;
  }
  const n = Object.keys(index.boards).length;
  await removeCanvas(env, index.id);
  return `Deleted canvas ${index.id} ${JSON.stringify(index.title)} (${n} artboard${n === 1 ? "" : "s"}, its assets and notes).`;
}

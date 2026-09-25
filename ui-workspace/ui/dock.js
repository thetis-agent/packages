/* The Files dock beside the chat: the explorer in compact mode with the current conversation's project
 * directories first, then Home and Shared, a one-line legend, and two actions (open the Workspace,
 * refresh the roots). The explorer instance is kept across redraws for one session and rebuilt when the
 * conversation changes, so expanding a folder survives the dock closing and opening. The subtitle comes
 * from the roots data, read once per session and re-read when the model says the roots changed; a redraw
 * is asked only when the subtitle it would show differs from the one on the page. */

import { mountExplorer } from "./explorer.js";
import { bindDialogs } from "./dialogs.js";

const OPEN = ["M8.5 4H5.5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-3", "M11.5 4H16v4.5", "M16 4l-7.5 7.5"];
const REFRESH = ["M15.5 10a5.5 5.5 0 1 1-1.6-3.9", "M15.5 3.5v3.5H12"];

let cached = null;              // { session, explorer, body }
let watching = null;            // the model whose `watch` feeds the roots cache
const rootsBySession = new Map(); // session key → roots data (or { error })
const shown = new Map();          // session key → the subtitle last drawn
const pending = new Set();        // session keys with a roots read in flight

const keyOf = (session) => session ?? "";
const unwrap = (x) => (x && typeof x === "object" && x.data !== undefined ? x.data : x);

function subtitleOf(roots) {
  const project = roots?.projects?.find?.((p) => p.current) ?? null;
  if (!project) return "Home and Shared";
  const dirs = project.directories ?? [];
  const ready = typeof project.summary?.ready === "number" ? project.summary.ready : dirs.filter((d) => d.state === "ready" || d.state === "bound").length;
  const broken = typeof project.summary?.broken === "number" ? project.summary.broken : dirs.length - ready;
  const parts = [`${ready} ${ready === 1 ? "directory" : "directories"} ready`];
  if (broken > 0) parts.push(`${broken} ${broken === 1 ? "needs" : "need"} attention`);
  return `${project.name || "Project"} · ${parts.join(", ")}`;
}

function fetchRoots(ext, model, session, force) {
  const key = keyOf(session);
  if (pending.has(key) && !force) return;
  pending.add(key);
  Promise.resolve()
    .then(() => model.roots({ session: session ?? undefined, force }))
    .then((r) => rootsBySession.set(key, unwrap(r) ?? null), (err) => rootsBySession.set(key, { error: err?.message || "no answer" }))
    .finally(() => {
      pending.delete(key);
      if (subtitleOf(rootsBySession.get(key)) !== shown.get(key)) ext.redraw("files");
    });
}

function watchRoots(ext, model) {
  if (watching === model || typeof model?.watch !== "function") return;
  watching = model;
  model.watch((change) => {
    if (change?.kind !== "roots") return;
    fetchRoots(ext, model, ext.conversation.current ?? null, false);
  });
}

function legend(el) {
  return el(
    "div",
    { class: "ws-dock-legend" },
    el("span", { class: "ws-dock-legend-item" }, el("span", { class: "ws-mode is-rw" }, "rw"), " writable"),
    el("span", { class: "ws-dock-legend-item" }, el("span", { class: "ws-mode is-ro" }, "ro"), " read-only"),
    el("span", { class: "ws-dock-legend-item" }, el("span", { class: "ws-dot is-err", "aria-hidden": "true" }), " needs attention")
  );
}

function ensureExplorer(ext, model, session) {
  if (cached && cached.session === session && cached.explorer) return cached;
  if (cached) {
    try { cached.explorer?.destroy?.(); } catch (err) { console.warn("ui-workspace: the dock explorer did not destroy cleanly:", err); }
    cached = null;
  }
  const { el } = ext.dom;
  const tree = el("div", { class: "ws-dock-tree" });
  const body = el("div", { class: "ws-dock" }, tree, legend(el));
  const explorer = mountExplorer(tree, {
    model,
    ext,
    session,
    compact: true,
    order: "project-first",
    onOpen: (entry) => {
      if (!entry?.path) return;
      ext.open.place("workspace", entry.kind === "dir" ? { dir: entry.path } : { path: entry.path });
    },
  });
  cached = { session, explorer, body };
  return cached;
}

/** What the dock's `draw()` answers: `{ title, subtitle, body, actions }`. */
export function drawDock(ext, model) {
  bindDialogs(ext, model);
  watchRoots(ext, model);
  const { el, icon } = ext.dom;
  const session = ext.conversation.current ?? null;
  const key = keyOf(session);
  const view = ensureExplorer(ext, model, session);
  // The model's own cache answers at once when the roots were already read (the explorer asks first).
  if (!rootsBySession.has(key)) {
    const known = typeof model.rootsCached === "function" ? model.rootsCached(session ?? undefined) : null;
    if (known) rootsBySession.set(key, known);
    else fetchRoots(ext, model, session, false);
  }
  const subtitle = subtitleOf(rootsBySession.get(key));
  shown.set(key, subtitle);
  try { view.explorer?.update?.(); } catch (err) { console.warn("ui-workspace: the dock explorer did not update:", err); }
  const openBtn = el("button", { type: "button", class: "icon-btn sm ws-dock-open", title: "Open the Workspace", "aria-label": "Open the Workspace", onClick: () => ext.open.place("workspace", {}) }, icon(OPEN, { size: 16, width: 1.6 }));
  const refreshBtn = el("button", {
    type: "button",
    class: "icon-btn sm ws-dock-refresh",
    title: "Refresh the directories",
    "aria-label": "Refresh the directories",
    onClick: async () => {
      refreshBtn.disabled = true;
      try {
        const r = await model.roots({ session: session ?? undefined, force: true });
        rootsBySession.set(key, unwrap(r) ?? null);
      } catch (err) {
        rootsBySession.set(key, { error: err?.message || "no answer" });
        ext.toast(`The directories could not be refreshed: ${err?.message || "the workspace did not answer"}`, { tone: "error" });
      }
      try { cached?.explorer?.update?.(); } catch { /* the redraw below rebuilds what it can */ }
      ext.redraw("files");
    },
  }, icon(REFRESH, { size: 16, width: 1.6 }));
  return { title: "Files", subtitle, body: view.body, actions: [openBtn, refreshBtn] };
}

/** Opens the Files dock and scrolls its row for `path` into view (the explorer's `reveal`). */
export function revealInDock(ext, path) {
  ext.open.dock("files");
  const go = () => { try { cached?.explorer?.reveal?.(path); } catch (err) { console.warn("ui-workspace: reveal failed:", err); } };
  queueMicrotask(() => {
    if (cached?.explorer) go();
    else if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
    else setTimeout(go, 16);
  });
}

/** Forgets the cached explorer (tests, or a session that is gone). */
export function resetDock() {
  try { cached?.explorer?.destroy?.(); } catch { /* nothing to keep */ }
  cached = null;
}

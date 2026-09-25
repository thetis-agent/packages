/* File links in the transcript. The renderer registered here never answers a Node (that would replace
 * the shell's card); it declines every event and decorates the card the shell has drawn a microtask later:
 * the path in a files tool's gist becomes a link, an Open pill joins the head, and once a run has a
 * result a "Files in this run" strip lists every distinct path the run touched. Clicks open the
 * Workspace at the path (and line); a right-click asks `resolve` whether the path is reachable and
 * offers the file menu. `findPaths` and `linkifyText` are the prose half, pure and ready for the
 * message hook the shell does not offer yet. `menu.js`, `file-menu.js` and `dock.js` are imported on
 * the first right-click, not at load, so this module stands alone in tests and while they land. */

import { bindDialogs, basename, confirmDelete, copyPath, downloadFile, downloadZip } from "./dialogs.js";

export const FILE_TOOLS = new Set(["read_path", "edit_path", "write_path", "get_directory", "find_files", "search_files"]);

const runPaths = new WeakMap(); // details.tool-run → Set of paths, first-seen order
let wired = null;               // the ext the document listeners were bound for

// ---- pure: finding path-shaped runs of text ----

// An absolute or home path: `/x/y`, `~/x`, an optional `:line`; never the tail of a URL or a word.
const ABS = /(?<![\w:/.~-])(?:~|\/)[^\s"'`<>()[\]{}]+/g;
// A relative path with at least one `/` and a file extension: `src/tide.ts`, `docs/a-b.md:7`.
const REL = /(?<![\w/.:~@-])[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8}(?::\d+)?(?![\w/])/g;
const TRAIL = /[.,;:!?]+$/;

/** Every candidate path in `text`: `[{ raw, path, line }]`, deduplicated by `raw`, in order of appearance. */
export function findPaths(text) {
  const out = [];
  const seen = new Set();
  const take = (m) => {
    let raw = m.replace(TRAIL, "");
    if (!raw || raw === "/" || raw === "~" || raw === "~/") return;
    if (/^\/\//.test(raw)) return;
    let line = null;
    const at = /:(\d+)$/.exec(raw);
    let path = raw;
    if (at) { line = Number(at[1]); path = raw.slice(0, at.index); }
    path = path.replace(TRAIL, "");
    if (!path || path === "/" || path === "~" || path === "~/") return;
    if (!/[\w.]/.test(path.slice(1))) return;
    if (seen.has(raw)) return;
    seen.add(raw);
    out.push({ raw, path, line });
  };
  const s = String(text ?? "");
  for (const m of s.matchAll(ABS)) take(m[0]);
  for (const m of s.matchAll(REL)) take(m[0]);
  // Order by position in the text, so relative and absolute hits interleave as written.
  return out
    .map((c) => ({ ...c, at: s.indexOf(c.raw) }))
    .sort((a, b) => a.at - b.at)
    .map(({ at, ...c }) => c);
}

const lookup = (resolved, key) => {
  if (!resolved) return null;
  if (typeof resolved.get === "function") return resolved.get(key) ?? null;
  return Object.prototype.hasOwnProperty.call(resolved, key) ? resolved[key] ?? null : null;
};

/**
 * Splits one text run into `{ text }` and `{ link: { raw, path, line, absolute } }` segments, linking only
 * the candidates `resolved` (a Map or object keyed by `path`, values the `resolve` answer or truthy) confirms.
 */
export function splitText(text, resolved) {
  const s = String(text ?? "");
  const hits = findPaths(s).filter((c) => lookup(resolved, c.path));
  if (!hits.length) return [{ text: s }];
  const out = [];
  let i = 0;
  const used = [];
  const overlaps = (start, end) => used.some((u) => start < u.end && u.start < end);
  const spots = [];
  // The longer candidate claims its spot first, so `src/a.js:9` is one link, not `src/a.js` and `:9`.
  for (const hit of [...hits].sort((a, b) => b.raw.length - a.raw.length)) {
    let from = 0;
    for (;;) {
      const at = s.indexOf(hit.raw, from);
      if (at < 0) break;
      const end = at + hit.raw.length;
      const before = s[at - 1];
      const after = s[end];
      const clean = !(before && /[\w/.~-]/.test(before)) && !(after && /[\w/]/.test(after));
      if (clean && !overlaps(at, end)) { spots.push({ at, end, hit }); used.push({ start: at, end }); }
      from = end;
    }
  }
  spots.sort((a, b) => a.at - b.at);
  for (const { at, end, hit } of spots) {
    if (at > i) out.push({ text: s.slice(i, at) });
    const answer = lookup(resolved, hit.path);
    out.push({ link: { raw: hit.raw, path: hit.path, line: hit.line, absolute: (answer && typeof answer === "object" && answer.absolute) || hit.path } });
    i = end;
  }
  if (i < s.length) out.push({ text: s.slice(i) });
  return out;
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

/** The `a.ws-link[data-path][data-line?]` every link in the transcript is. */
export function makeLink(text, path, line) {
  const n = line != null && Number.isFinite(Number(line)) && Number(line) > 0 ? Number(line) : null;
  return h("a", { class: "ws-link", href: "#", "data-path": path, "data-line": n == null ? null : String(n), title: n ? `${path}:${n}` : path }, text);
}

const SKIP = new Set(["A", "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "BUTTON", "SVG"]);

/**
 * Walks the text nodes under `node` and turns confirmed paths into `a.ws-link`, leaving links, scripts and
 * form controls alone. Returns the links made, so the caller can wire them if it is not the document.
 */
export function linkifyText(node, resolved) {
  const made = [];
  const walk = (n) => {
    if (!n) return;
    if (n.nodeType === 3) {
      const parts = splitText(n.nodeValue ?? n.data ?? "", resolved);
      if (parts.length === 1 && parts[0].text !== undefined) return;
      const nodes = parts.map((p) => (p.text !== undefined ? document.createTextNode(p.text) : makeLink(p.link.raw, p.link.absolute, p.link.line)));
      made.push(...nodes.filter((x) => x.nodeType === 1));
      if (typeof n.replaceWith === "function") n.replaceWith(...nodes);
      else if (n.parentNode) { for (const x of nodes) n.parentNode.insertBefore(x, n); n.parentNode.removeChild(n); }
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 11) return;
    const tag = String(n.tagName ?? n.nodeName ?? "").toUpperCase();
    if (SKIP.has(tag)) return;
    if (n.classList && (n.classList.contains("ws-link") || n.classList.contains("ws-touched"))) return;
    for (const child of Array.from(n.childNodes ?? [])) walk(child);
  };
  walk(node);
  return made;
}

// ---- pure: where the path sits in the shell's gist line ----

const CUT = 60;   // a value longer than this is shown as 59 chars + …
const LINE = 90;  // and the whole line at 90

function gistValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return null;
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > CUT ? one.slice(0, CUT - 1) + "…" : one;
}

/**
 * The `{ start, end, full }` of the `key` argument's value inside the gist text the shell drew from `args`,
 * rebuilt the way the shell builds it (`key: value  ·  key: value`, values cut at 60, the line at 90), and
 * checked against the text; `full` is false when the line cut it short. Null when it is not on the line.
 */
export function gistSpan(text, args, key = "path") {
  const s = String(text ?? "");
  if (!args || typeof args !== "object" || typeof args[key] !== "string") return null;
  const shown = gistValue(args[key]);
  if (!shown) return null;
  const before = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === key) break;
    const one = gistValue(v);
    if (one !== null) before.push(`${k}: ${one}`);
  }
  const start = (before.length ? before.join("  ·  ") + "  ·  " : "") + `${key}: `;
  const from = start.length;
  if (from < s.length && s.startsWith(start)) {
    const avail = s.slice(from);
    if (avail.startsWith(shown)) return { start: from, end: from + shown.length, full: true };
    if (avail.endsWith("…") && avail.length > 1 && shown.startsWith(avail.slice(0, -1))) return { start: from, end: s.length, full: false };
  }
  const at = s.indexOf(`${key}: ${shown}`);
  if (at >= 0) return { start: at + key.length + 2, end: at + key.length + 2 + shown.length, full: true };
  return null;
}

// ---- the renderer and the decoration ----

const esc = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, "\\$&"));

function cardFor(session, id) {
  if (!session || !id) return null;
  return document.querySelector(`.pane[data-session="${esc(session)}"] details.tool[data-tool="${esc(id)}"]`);
}

/** Runs `fn` after the shell has drawn; once more on the next frame if the card was not there yet. */
function later(fn) {
  queueMicrotask(() => {
    if (fn()) return;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fn());
    else setTimeout(fn, 16);
  });
}

function pathOf(call) {
  const path = call?.args?.path;
  return typeof path === "string" && path.trim() ? path.trim() : null;
}

function lineOf(call) {
  if (call?.name !== "read_path") return null;
  const offset = Number(call?.args?.offset);
  return Number.isFinite(offset) && offset > 1 ? offset : null;
}

function wrapGist(gistEl, args, path, line) {
  const textNode = Array.from(gistEl.childNodes).find((n) => n.nodeType === 3);
  if (!textNode) return false;
  const span = gistSpan(textNode.data, args);
  if (!span) return false;
  const mid = textNode.splitText(span.start);
  mid.splitText(span.end - span.start);
  const link = makeLink(mid.data, path, line);
  if (!span.full) link.classList.add("is-cut");
  mid.replaceWith(link);
  return true;
}

function decorateCall(session, call, path) {
  const card = cardFor(session, call.id);
  if (!card) return false;
  if (card.dataset.wsLinked) return true;
  card.dataset.wsLinked = "1";
  const line = lineOf(call);
  const head = card.querySelector(":scope > .tool-head");
  const gistEl = head?.querySelector(".tool-gist");
  if (gistEl) wrapGist(gistEl, call.args, path, line);
  if (head) {
    const open = h("button", { type: "button", class: "ws-open", "data-path": path, "data-line": line == null ? null : String(line), title: `Open ${path}${line ? `:${line}` : ""} in the Workspace` }, "Open");
    const status = head.querySelector(".tool-status");
    if (status) status.before(open);
    else head.append(open);
  }
  const run = card.closest("details.tool-run");
  if (run) {
    let set = runPaths.get(run);
    if (!set) runPaths.set(run, (set = new Set()));
    set.add(path);
  }
  return true;
}

/** Appends or refreshes the run's `.ws-touched` strip after `.tool-run-body`. Idempotent. */
function refreshTouched(session, id) {
  const card = cardFor(session, id);
  if (!card) return true; // a card the shell made from the result has no path of ours
  const run = card.closest("details.tool-run");
  const set = run && runPaths.get(run);
  if (!set?.size) return true;
  let strip = run.querySelector(":scope > .ws-touched");
  if (!strip) {
    strip = h("div", { class: "ws-touched" }, h("span", { class: "ws-touched-label" }, "Files in this run:"));
    const body = run.querySelector(":scope > .tool-run-body");
    if (body) body.after(strip);
    else run.append(strip);
  }
  for (const old of strip.querySelectorAll(":scope > a.ws-link")) old.remove();
  for (const path of set) strip.append(makeLink(path, path, null));
  strip.dataset.count = String(set.size);
  return true;
}

// ---- clicks and the right-click menu ----

function openAt(ext, node) {
  const path = node.dataset.path;
  if (!path) return;
  const line = node.dataset.line ? Number(node.dataset.line) : undefined;
  ext.open.place("workspace", line ? { path, line } : { path });
}

async function contextMenu(ext, model, link, at) {
  const path = link.dataset.path;
  const line = link.dataset.line ? Number(link.dataset.line) : undefined;
  let answer = null;
  try {
    // The model answers the `{ [given]: … | null }` map itself; a raw command answer still carries `results`.
    const out = await model.resolve([path]);
    const data = out && typeof out === "object" && out.results === undefined && out.data ? out.data : out;
    const results = data && typeof data === "object" && data.results && typeof data.results === "object" ? data.results : data;
    answer = results?.[path] ?? null;
  } catch (err) {
    ext.toast(`${path} could not be checked: ${err?.message || "the workspace did not answer"}`, { tone: "error" });
    return;
  }
  if (!answer) {
    ext.toast(`${path} is not reachable from this workspace: it is outside your home, the shared directory and your project directories.`, { tone: "warn" });
    return;
  }
  const absolute = answer.absolute || path;
  const entry = { path: absolute, name: basename(absolute), kind: answer.kind === "dir" ? "dir" : "file", mode: answer.mode === "rw" ? "rw" : "ro", root: answer.root, display: answer.display };
  let fileMenu, openMenu, dock;
  try {
    [{ fileMenu }, { openMenu }, dock] = await Promise.all([import("./file-menu.js"), import("./menu.js"), import("./dock.js")]);
  } catch (err) {
    console.warn("ui-workspace: the file menu could not load:", err);
    openAt(ext, link);
    return;
  }
  const actions = {
    open: () => ext.open.place("workspace", line ? { path: entry.path, line } : { path: entry.path }),
    reveal: () => dock.revealInDock(ext, entry.path),
    download: () => (entry.kind === "dir" ? downloadZip(ext, model, entry) : downloadFile(ext, entry)),
    copyPath: () => copyPath(ext, entry.path),
    remove: entry.mode === "rw" ? () => confirmDelete(link, ext, model, entry) : undefined,
    // Rename needs a row to type in: the place opens on the entry and starts the rename there.
    rename: entry.mode === "rw" ? () => ext.open.place("workspace", { path: entry.path, rename: true }) : undefined,
  };
  openMenu(at, fileMenu(entry, "chat", actions));
}

function wireDocument(ext, model) {
  if (wired === ext) return;
  wired = ext;
  document.addEventListener("click", (event) => {
    const node = event.target?.closest?.("a.ws-link, button.ws-open");
    if (!node) return;
    event.preventDefault(); // an anchor in a summary would navigate, and the summary would toggle
    event.stopPropagation();
    openAt(ext, node);
  });
  document.addEventListener("contextmenu", (event) => {
    const node = event.target?.closest?.("a.ws-link");
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    void contextMenu(ext, model, node, { x: event.clientX, y: event.clientY });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const node = document.activeElement?.closest?.("a.ws-link");
    if (!node) return;
    event.preventDefault();
    const r = node.getBoundingClientRect();
    void contextMenu(ext, model, node, { x: r.left, y: r.bottom + 4 });
  });
}

/** Registers the transcript renderer and the document listeners. Returns the renderer for tests. */
export function installLinks(ext, model) {
  bindDialogs(ext, model);
  wireDocument(ext, model);
  const render = (event, ctx) => {
    if (!event || !ctx?.session) return undefined;
    if (event.type === "tool.call") {
      const call = event.call ?? {};
      if (!FILE_TOOLS.has(call.name) || !call.id) return undefined;
      const path = pathOf(call);
      if (!path) return undefined;
      later(() => decorateCall(ctx.session, call, path));
    } else if (event.type === "tool.result" && event.id) {
      later(() => refreshTouched(ctx.session, event.id));
    }
    return undefined; // never a Node: the shell's card stays
  };
  ext.transcript(render);
  return render;
}

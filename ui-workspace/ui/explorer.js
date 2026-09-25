/* The explorer: the tree of everything the fence can see, drawn from the shared model. Home and Shared,
 * then the projects, each holding its directories at their real state; a directory the agent cannot
 * reach gets a sentence under its row and the repair (Bind for an admin, the exact command for anyone
 * else), and a project with a broken directory says how many at the top of its group. Folders load when
 * they open (`model.list`), and every listing, every open folder, the selection and the filter live in
 * the model, so the place and the Files dock (`compact: true`, `order: "project-first"`) show the same
 * tree. The rows carry the shell's tree classes so its keyboard pattern and look apply, plus the `.ws-*`
 * extras: a pill for the mode, a dot for the state or a dirty tab, a hover ⋯ that opens the shared file
 * menu, and an inline field for a rename or a new entry. Drop files on a folder to upload them; the host
 * supplies `actions.upload` (and `download`, `remove`, `count`, `reveal`), each called as
 * `fn(entry, { anchor, files? })`; the explorer's own `open`, `newFile`, `newFolder`, `rename` and
 * `copyPath` can be overridden the same way.
 *
 * `mountExplorer(host, { model, ext, session, onOpen, compact, order, actions })` → `{ update(),
 * reveal(path), newEntry(dir, kind), rename(entry | path), select(path), destroy() }`. */

import { ICONS, iconFor } from "./icons.js";
import { openMenu } from "./menu.js";
import { fileMenu } from "./file-menu.js";
import { confirmDelete, downloadFile, downloadZip, upload } from "./dialogs.js";
import { formatBytes, isWithin, joinPath, nameOf, parentOf, rootOf } from "./model.js";

/** What each broken state says, and whether a bind repairs it. The words are `stateOf`'s. */
export const STATE_SENTENCES = Object.freeze({
  unmounted: Object.freeze({ tone: "err", text: "Not mounted. An agent cannot read this directory.", fix: true }),
  skipped: Object.freeze({ tone: "err", text: "Bound, but the host path is gone.", fix: false }),
  "empty-path": Object.freeze({ tone: "warn", text: "Reachable, but nothing is at this path.", fix: false }),
  "not-a-directory": Object.freeze({ tone: "warn", text: "Reachable, but this is a file, not a directory.", fix: false }),
});

/** The CLI line a member hands to an admin: `thetis mounts add <user> <path>`, with `--ro` for read-only. */
export const bindCommand = (user, path, mode = "rw") => `thetis mounts add ${user || "<user>"} ${path}${mode === "ro" ? " --ro" : ""}`;

/** The state word of one project directory in a `roots` answer, or null when no project names the path. */
export function directoryState(roots, path) {
  for (const project of roots?.projects ?? []) for (const dir of project.directories ?? []) if (dir?.path === path) return dir.state ?? null;
  return null;
}

/**
 * Whether a failed bind request is the bind itself closing the fence: the gateway serving the page goes
 * with it, so the request dies with a 502 (or no connection at all) before an answer. That is the expected
 * shape of a bind that worked, not a refusal, and the row is watched until the workspace is back.
 */
export function isRestartError(err) {
  const status = Number(err?.status);
  if (status === 502 || status === 0) return true;
  return /bad gateway|not connected|ended/i.test(String(err?.message ?? ""));
}

/** What to say once the roots answer again after a bind: bound, or the state's own sentence. */
export function bindOutcome(name, state) {
  if (state === "ready" || state === "bound") return { text: `${name} is bound.`, tone: "ok" };
  const spec = STATE_SENTENCES[state];
  if (spec) return { text: `${name}: ${spec.text}`, tone: spec.tone === "err" ? "error" : "warn" };
  return { text: `${name} is not in the roots any more; refresh to see what the workspace has.`, tone: "warn" };
}

const BIND_POLL_MS = 2000;
const BIND_POLL_LIMIT_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Project groups already opened for their broken directories in this page's lifetime, per person. */
const openedForBroken = new Set();

/**
 * The note under a directory row: `{ tone, text, bind, command }`, or null when the directory is ready.
 * An admin gets the Bind button (`bind` is the path); a member gets the command line to hand over.
 */
export function sentenceFor(dir, { admin = false, user = "" } = {}) {
  const spec = STATE_SENTENCES[dir?.state];
  if (!spec) return null;
  const fix = spec.fix && !dir.home;
  return { tone: spec.tone, text: spec.text, bind: fix && admin ? dir.path : null, command: fix && !admin ? bindCommand(user, dir.path) : null };
}

/** The project's own line when some of its directories are not usable, in the project page's words. */
export function summarySentence(summary, total) {
  const broken = Number(summary?.broken ?? 0);
  const all = Number(total ?? (Number(summary?.ready ?? 0) + broken));
  if (!broken || !all) return null;
  const of = all === 1 ? `${broken} of 1 directory` : `${broken} of ${all} directories`;
  return `${of} ${broken === 1 ? "is" : "are"} not usable. An agent in this project cannot read ${broken === 1 ? "it" : "them"}.`;
}

const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

export function mountExplorer(host, { model, ext, session = null, onOpen, compact = false, order = "roots-first", actions = {} } = {}) {
  const { el, icon } = ext.dom;
  let alive = true;
  let roots = null;
  let rootsError = null;
  let editing = null; // { type: "rename", path, value } | { type: "new", dir, kind, value }
  let focused = null; // the row key holding the tab stop
  let scheduled = false;
  let seeded = false;
  const loading = new Set();
  const errors = new Map(); // path -> sentence
  const nodesByKey = new Map(); // key -> node, from the last draw

  host.classList.add("ws-explorer");
  if (compact) host.classList.add("is-compact");

  // ---- the chrome above the tree ----

  const iconBtn = (paths, title, onClick) => el("button", { type: "button", class: "icon-btn sm", title, "aria-label": title, onClick }, icon(paths, { size: 16, width: 1.6 }));

  const head = compact
    ? null
    : el(
        "div",
        { class: "ws-head" },
        el("span", { class: "ws-head-title" }, "Files"),
        el(
          "span",
          { class: "ws-head-actions" },
          iconBtn(ICONS.newfile, "New file", () => startNew(targetDir(), "file")),
          iconBtn(ICONS.newfolder, "New folder", () => startNew(targetDir(), "dir")),
          iconBtn(ICONS.refresh, "Refresh", refresh),
          iconBtn(ICONS.collapse, "Collapse all", () => model.collapseAll())
        )
      );

  const filterInput = el("input", {
    class: "input ws-filter-input",
    type: "search",
    placeholder: "Filter",
    "aria-label": "Filter the files shown",
    value: model.filter,
    spellcheck: "false",
    autocomplete: "off",
    onInput: () => model.setFilter(filterInput.value),
    onKeydown: (event) => {
      if (event.key === "Escape" && filterInput.value) {
        event.stopPropagation();
        filterInput.value = "";
        model.setFilter("");
      }
    },
  });
  const dotfiles = el("input", { type: "checkbox", class: "ws-check-input", checked: model.hidden ? true : null, onChange: () => model.setHidden(dotfiles.checked) });
  const filter = el("div", { class: "ws-filter" }, filterInput, el("label", { class: "ws-check", title: "Show dotfiles" }, dotfiles, el("span", {}, "dotfiles")));

  const tree = el("div", { class: "tree ws-tree", role: "tree", "aria-label": "Files" });
  const scroller = el("div", { class: "ws-scroll" }, tree);
  host.append(head, filter, scroller);

  // ---- nodes: what the tree is made of, rebuilt from the caches on every draw ----

  const isAdmin = () => Boolean(roots?.admin) || (typeof ext.can === "function" && ext.can("bind"));

  function rootEntry(path, name, mode, rootKind, extra = {}) {
    return { path, name, kind: "dir", mode, root: path, rootKind, ...extra };
  }

  function homeNode() {
    return { t: "entry", key: roots.home.path, isRoot: true, icon: ICONS.home, sub: roots.home.path, entry: rootEntry(roots.home.path, "Home", roots.home.mode ?? "rw", "home") };
  }

  function sharedNode() {
    return { t: "entry", key: roots.shared.path, isRoot: true, icon: ICONS.shared, sub: roots.shared.path, entry: rootEntry(roots.shared.path, "Shared", roots.shared.mode ?? "ro", "shared") };
  }

  /** A project directory as a root row, with its note when it is not ready. */
  function directoryNodes(project, dir) {
    const ready = dir.state === "ready";
    const note = sentenceFor(dir, { admin: isAdmin(), user: roots.user });
    const entry = rootEntry(dir.path, dir.name || nameOf(dir.path), ready ? dir.mode ?? "rw" : "ro", "project", { project: project.id, state: dir.state });
    const node = { t: "entry", key: dir.path, isRoot: true, broken: !ready, icon: ready ? ICONS.folder : ICONS.warn, sub: dir.parent ?? parentOf(dir.path), dot: ready ? "ok" : note?.tone ?? "warn", entry };
    return note ? [node, { t: "note", ...note, path: dir.path }] : [node];
  }

  /** The project's summary sentence as a note, or null when every directory is usable. */
  function summaryNode(project) {
    const summary = summarySentence(project.summary, (project.directories ?? []).length);
    return summary ? { t: "note", tone: "warn", text: summary, summary: true } : null;
  }

  function projectChildren(project, { withSummary = true } = {}) {
    const dirs = project.directories ?? [];
    const out = [];
    const summary = withSummary ? summaryNode(project) : null;
    if (summary) out.push(summary);
    if (!dirs.length) out.push({ t: "note", tone: "info", text: "No directories in this project." });
    for (const dir of dirs) out.push(...directoryNodes(project, dir));
    return out;
  }

  function projectNode(project) {
    const dirs = project.directories ?? [];
    const broken = Number(project.summary?.broken ?? 0);
    return { t: "project", key: `project:${project.id}`, project, dot: broken ? "err" : dirs.length ? "ok" : null, count: `${dirs.length} director${dirs.length === 1 ? "y" : "ies"}` };
  }

  function topLevel() {
    const projects = roots.projects ?? [];
    if (order === "project-first") {
      const current = projects.filter((p) => p.current);
      const others = projects.filter((p) => !p.current);
      const out = [];
      for (const project of current) out.push({ t: "head", label: project.name, hint: "this conversation's project" }, ...projectChildren(project));
      out.push({ t: "head", label: "Workspace" });
      if (roots.home?.path) out.push(homeNode());
      if (roots.shared?.path) out.push(sharedNode());
      for (const project of others) out.push({ t: "head", label: project.name }, ...projectChildren(project));
      return out;
    }
    const out = [];
    if (roots.home?.path) out.push(homeNode());
    if (roots.shared?.path) out.push(sharedNode());
    if (projects.length) out.push({ t: "head", label: "Projects" }, ...projects.map(projectNode));
    return out;
  }

  const term = () => model.filter.trim().toLowerCase();
  const matches = (name) => !term() || name.toLowerCase().includes(term());

  /** Whether a loaded descendant of a folder matches the filter, so the folder stays in view. */
  function anyBelow(path, depth = 0) {
    if (depth > 12) return false;
    const listing = model.listing(path);
    if (!listing) return false;
    for (const e of listing.entries ?? []) {
      if (matches(e.name)) return true;
      if ((e.kind === "dir" || e.target === "dir") && anyBelow(joinPath(path, e.name), depth + 1)) return true;
    }
    return false;
  }

  function childrenOf(node) {
    const { entry } = node;
    if (entry.kind !== "dir" || node.broken || !model.isExpanded(entry.path)) return null;
    const out = [];
    if (editing?.type === "new" && editing.dir === entry.path) out.push({ t: "input", dir: entry.path, kind: editing.kind, entry });
    const listing = model.listing(entry.path);
    if (!listing) {
      if (errors.has(entry.path)) out.push({ t: "note", tone: "err", text: errors.get(entry.path), retry: entry.path });
      else {
        load(entry.path);
        out.push({ t: "loading" });
      }
      return out;
    }
    for (const e of listing.entries ?? []) {
      const path = joinPath(entry.path, e.name);
      // A symlink to a directory opens like one; a dangling one is a file with nothing behind it.
      const kind = e.kind === "dir" || (e.kind === "symlink" && e.target === "dir") ? "dir" : "file";
      if (kind === "dir" ? !matches(e.name) && !anyBelow(path) : !matches(e.name)) continue;
      const child = { path, name: e.name, kind, type: e.kind, target: e.target, size: e.size, mtime: e.mtime, etag: e.etag, hidden: Boolean(e.hidden), mode: entry.mode, root: entry.root, rootKind: entry.rootKind, project: entry.project };
      out.push({ t: "entry", key: path, entry: child, icon: iconFor(child, { open: model.isExpanded(path) }) });
    }
    if (listing.more) out.push({ t: "note", tone: "info", text: "The first 500 entries are shown; the filter narrows only these." });
    if (!out.length) out.push({ t: "empty", text: term() ? "Nothing here matches the filter." : "Empty." });
    return out;
  }

  // ---- rows ----

  const depth = (node, level) => node.style.setProperty("--depth", String(level - 1));

  function faintRow(text, level, cls = "") {
    const row = el("div", { class: `tree-hidden ws-faint ${cls}`.trim(), "aria-hidden": "true" }, el("span", { class: "tree-toggle is-leaf" }), el("span", { class: "tree-label" }, text));
    depth(row, level);
    return row;
  }

  function noteRow(node, level) {
    const parts = [el("span", { class: "ws-note-text" }, node.text)];
    if (node.bind) {
      const bind = ext.ui.button("Bind now", { tone: "primary", title: `Bind ${node.bind} read-write`, onClick: () => bindNow(node.bind, bind) });
      parts.push(bind);
    } else if (node.command) {
      parts.push(el("span", { class: "ws-note-ask" }, "Ask an admin for: ", el("code", { class: "ws-note-cmd" }, node.command)));
    }
    if (node.retry) parts.push(ext.ui.button("Retry", { onClick: () => load(node.retry, true) }));
    const row = el("div", { class: `ws-note is-${node.tone || "info"}${node.summary ? " ws-summary" : ""}`, role: "note" }, icon(node.tone === "info" ? ICONS.link : ICONS.warn, { size: 13, width: 1.7 }), el("span", { class: "ws-note-body" }, ...parts));
    depth(row, level);
    return row;
  }

  function inlineField(state, { onCommit, onCancel, label }) {
    const input = el("input", { class: "input mono ws-inline-input", type: "text", value: state.value ?? "", placeholder: label, "aria-label": label, spellcheck: "false", autocomplete: "off" });
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) onCommit(input.value.trim());
      else onCancel();
    };
    input.addEventListener("input", () => (state.value = input.value));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    // Leaving the field cancels. A redraw that replaces the field (a listing answering while the field is up)
    // keeps `editing`, so the field comes back with its text: the check waits a tick, by which time a field a
    // redraw removed is disconnected, and a field still on the page without the focus really was left.
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (!done && input.isConnected && document.activeElement !== input) finish(false);
      }, 0);
    });
    return el("span", { class: "field mono ws-inline" }, input);
  }

  function inputRow(node, level) {
    const isDir = node.kind === "dir";
    const field = inlineField(editing, {
      label: isDir ? "New folder name" : "New file name",
      onCommit: (name) => commitNew(node.entry, node.kind, name),
      onCancel: () => {
        editing = null;
        scheduleDraw();
      },
    });
    const row = el("div", { class: "tree-item ws-row is-editing", role: "treeitem", "aria-level": String(level), tabindex: "-1" }, el("span", { class: "tree-toggle is-leaf", "aria-hidden": "true" }), el("span", { class: "ws-ic" }, icon(isDir ? ICONS.folder : ICONS.file, { size: 14, width: 1.6 })), field);
    depth(row, level);
    return row;
  }

  function moreButton(node) {
    const button = el("button", { type: "button", class: "ws-more", title: "More…", "aria-label": `More for ${node.t === "project" ? node.project.name : node.entry.name}`, tabindex: "-1" }, icon(ICONS.more, { size: 14, width: 2.2 }));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      menuFor(node, button);
    });
    return button;
  }

  function toggleSpan(node, expandable, open) {
    if (!expandable) return el("span", { class: "tree-toggle is-leaf", "aria-hidden": "true" });
    return el("span", { class: `tree-toggle${open ? " is-open" : ""}`, "aria-hidden": "true", onClick: (event) => { event.stopPropagation(); toggle(node); } }, icon(ICONS.chevron, { size: 12, width: 1.8 }));
  }

  function projectRow(node, level) {
    const open = model.isExpanded(node.key);
    const selected = model.selected === node.key;
    const row = el(
      "div",
      {
        class: `tree-item ws-row ws-project has-children${selected ? " is-selected" : ""}`,
        role: "treeitem",
        "aria-level": String(level),
        "aria-expanded": String(open),
        "aria-selected": String(selected),
        tabindex: focused === node.key ? "0" : "-1",
        "data-key": node.key,
        title: node.project.name,
        onClick: () => {
          model.select(node.key);
          toggle(node);
        },
        onKeydown: (event) => onKey(event, node),
      },
      toggleSpan(node, true, open),
      el("span", { class: "ws-ic" }, icon(ICONS.project, { size: 14, width: 1.6 })),
      el("span", { class: "tree-label" }, node.project.name),
      node.project.current ? el("span", { class: "ws-mode is-current", title: "The project of the open conversation" }, "current") : null,
      node.dot ? el("span", { class: `ws-dot is-${node.dot}`, "aria-hidden": "true" }) : null,
      el("span", { class: "tree-count" }, node.count)
    );
    depth(row, level);
    return row;
  }

  function entryRow(node, level, tab) {
    const { entry } = node;
    const expandable = entry.kind === "dir" && !node.broken;
    const open = expandable && model.isExpanded(entry.path);
    const selected = model.selected === entry.path;
    const renaming = editing?.type === "rename" && editing.path === entry.path;
    const droppable = expandable && entry.mode === "rw";
    const dropUpload = typeof actions.upload === "function" ? actions.upload : uploadTo;
    const row = el(
      "div",
      {
        class: `tree-item ws-row${node.isRoot ? " ws-root" : ""}${expandable ? " has-children" : ""}${node.broken ? " is-broken" : ""}${entry.hidden ? " is-hidden" : ""}${selected ? " is-selected" : ""}${renaming ? " is-editing" : ""}`,
        role: "treeitem",
        "aria-level": String(level),
        "aria-expanded": expandable ? String(open) : null,
        "aria-selected": String(selected),
        tabindex: focused === node.key ? "0" : "-1",
        "data-key": node.key,
        "data-path": entry.path,
        title: node.isRoot ? entry.path : null,
        onClick: () => activate(node, { fromClick: true }),
        onKeydown: (event) => onKey(event, node),
        onContextmenu: (event) => {
          event.preventDefault();
          event.stopPropagation();
          model.select(entry.path);
          menuFor(node, { x: event.clientX, y: event.clientY }, row);
        },
        onDragover: droppable
          ? (event) => {
              if (!hasFiles(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              row.classList.add("is-drop");
            }
          : null,
        onDragleave: droppable ? () => row.classList.remove("is-drop") : null,
        onDrop: droppable
          ? (event) => {
              if (!hasFiles(event)) return;
              event.preventDefault();
              event.stopPropagation();
              row.classList.remove("is-drop");
              const files = [...event.dataTransfer.files];
              if (files.length) dropUpload(entry, { anchor: row, files });
            }
          : null,
      },
      toggleSpan(node, expandable, open),
      el("span", { class: "ws-ic" }, icon(node.icon ?? iconFor(entry, { open }), { size: 14, width: 1.6 })),
      renaming
        ? inlineField(editing, { label: "New name", onCommit: (name) => commitRename(entry.path, name), onCancel: () => { editing = null; scheduleDraw(); } })
        : el("span", { class: "tree-label" }, entry.name),
      node.sub && !renaming ? el("span", { class: "ws-sub", title: node.sub }, node.sub) : null,
      node.isRoot && !node.broken ? el("span", { class: `ws-mode is-${entry.mode}`, title: entry.mode === "rw" ? "Read and write" : "Read-only" }, entry.mode) : null,
      tab?.dirty ? el("span", { class: "ws-dot is-dirty", title: "Unsaved changes" }) : node.dot ? el("span", { class: `ws-dot is-${node.dot}`, "aria-hidden": "true" }) : null,
      !renaming && !node.broken ? moreButton(node) : null
    );
    depth(row, level);
    return row;
  }

  function group(children, level) {
    const g = el("div", { class: "tree-group", role: "group" }, ...children.flatMap((child) => render(child, level + 1)));
    depth(g, level);
    return g;
  }

  function render(node, level) {
    switch (node.t) {
      case "head":
        return [el("div", { class: "ws-group", role: "presentation" }, el("span", { class: "ws-group-label" }, node.label), node.hint ? el("span", { class: "ws-group-hint" }, node.hint) : null)];
      case "note":
        return [noteRow(node, level)];
      case "loading":
        return [faintRow("Reading…", level, "is-loading")];
      case "empty":
        return [faintRow(node.text, level)];
      case "input":
        return [inputRow(node, level)];
      case "project": {
        nodesByKey.set(node.key, node);
        const open = model.isExpanded(node.key);
        // The summary sits under the project row, outside the collapsible group: a project whose directories
        // are all broken still says so when its group is closed.
        const summary = summaryNode(node.project);
        return [projectRow(node, level), summary ? noteRow(summary, level + 1) : null, open ? group(projectChildren(node.project, { withSummary: false }), level) : null].filter(Boolean);
      }
      case "entry": {
        nodesByKey.set(node.key, node);
        const children = childrenOf(node);
        return [entryRow(node, level, tabsByPath.get(node.entry.path)), children ? group(children, level) : null].filter(Boolean);
      }
      default:
        return [];
    }
  }

  let tabsByPath = new Map();

  function draw() {
    scheduled = false;
    if (!alive) return;
    const hadFocus = tree.contains(document.activeElement);
    const scrollTop = scroller.scrollTop;
    nodesByKey.clear();
    tabsByPath = new Map(model.tabs.list().map((t) => [t.path, t]));
    let rows;
    if (!roots) rows = [rootsError ? noteRow({ tone: "err", text: rootsError }, 1) : faintRow("Reading the roots…", 1, "is-loading")];
    else rows = topLevel().flatMap((node) => render(node, 1));
    tree.replaceChildren(...rows);
    const present = (key) => key && tree.querySelector(`.tree-item[data-key="${CSS.escape(key)}"]`);
    if (!present(focused)) focused = present(model.selected) ? model.selected : tree.querySelector(".tree-item[data-key]")?.dataset.key ?? null;
    for (const item of tree.querySelectorAll(".tree-item[data-key]")) item.tabIndex = item.dataset.key === focused ? 0 : -1;
    scroller.scrollTop = scrollTop;
    if (editing) {
      const input = tree.querySelector(".ws-inline-input");
      if (input) {
        // The field may be a fresh node drawn from `editing` (a listing landed under it): the focus comes
        // back without the tree scrolling sideways, a rename keeps its name selected, a new entry keeps its
        // caret at the end of what was typed so far.
        input.focus({ preventScroll: true });
        input.closest(".tree-item")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        if (editing.type === "rename") {
          const dotAt = input.value.lastIndexOf(".");
          input.setSelectionRange(0, dotAt > 0 ? dotAt : input.value.length);
        } else input.setSelectionRange(input.value.length, input.value.length);
      } else if (editing.type === "new" && canHoldNew(editing.dir)) {
        // The folder is drawn but closed (a redraw folded it): open it again and the field returns from state.
        model.setExpanded(editing.dir, true, { silent: true });
        scheduleDraw();
      } else editing = null; // the row is gone (filtered, deleted): nothing to edit
    } else if (hadFocus && focused) present(focused)?.focus();
  }

  /** Whether a drawn folder row can carry the pending new-entry field. */
  function canHoldNew(dir) {
    const node = nodesByKey.get(dir);
    return Boolean(node && node.t === "entry" && node.entry.kind === "dir" && !node.broken);
  }

  function scheduleDraw() {
    if (scheduled || !alive) return;
    scheduled = true;
    queueMicrotask(draw);
  }

  // ---- behaviour ----

  function load(path, force = false) {
    if (loading.has(path)) return;
    loading.add(path);
    errors.delete(path);
    model
      .list(path, { force })
      .catch((err) => errors.set(path, err?.message || `${path} could not be listed.`))
      .finally(() => {
        loading.delete(path);
        scheduleDraw();
      });
  }

  function toggle(node) {
    const key = node.key;
    const open = model.toggleExpanded(key);
    if (open && node.t === "entry" && !model.listing(node.entry.path)) load(node.entry.path);
  }

  function expand(node) {
    if (model.isExpanded(node.key)) return;
    model.setExpanded(node.key, true);
    if (node.t === "entry" && !model.listing(node.entry.path)) load(node.entry.path);
  }

  const collapse = (node) => model.setExpanded(node.key, false);

  const openEntry = (entry) => {
    if (typeof actions.open === "function") actions.open(entry, {});
    else onOpen?.(entry);
  };

  /** A click or Enter on a row: select it, open a folder, open a file. */
  function activate(node, { fromClick = false } = {}) {
    if (node.t === "project") {
      model.select(node.key);
      return toggle(node);
    }
    const { entry } = node;
    model.select(entry.path);
    focused = node.key;
    if (node.broken) return;
    if (entry.kind === "dir") return fromClick ? (model.isExpanded(entry.path) ? collapse(node) : expand(node)) : toggle(node);
    openEntry(entry);
  }

  const dirOf = (node) => (node.t === "project" ? null : node.entry.kind === "dir" && !node.broken ? node.entry.path : parentOf(node.entry.path));

  function targetDir() {
    const node = model.selected ? nodesByKey.get(model.selected) : null;
    const path = node ? dirOf(node) : roots?.home?.path;
    return path ?? roots?.home?.path ?? null;
  }

  function focusRow(row) {
    if (!row) return;
    focused = row.dataset.key;
    for (const item of tree.querySelectorAll(".tree-item[data-key]")) item.tabIndex = item === row ? 0 : -1;
    row.focus();
  }

  function onKey(event, node) {
    if (editing) return;
    const rows = [...tree.querySelectorAll(".tree-item[data-key]")];
    const row = event.currentTarget;
    const at = rows.indexOf(row);
    if (at < 0) return;
    const go = (index) => {
      event.preventDefault();
      focusRow(rows[Math.max(0, Math.min(rows.length - 1, index))]);
    };
    const expandable = node.t === "project" || (node.entry.kind === "dir" && !node.broken);
    const open = expandable && model.isExpanded(node.key);
    const entry = node.t === "entry" ? node.entry : null;
    switch (event.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(rows.length - 1);
      case "ArrowRight":
        if (!expandable) return;
        event.preventDefault();
        if (!open) return expand(node);
        return go(at + 1);
      case "ArrowLeft": {
        event.preventDefault();
        if (expandable && open) return collapse(node);
        const parentGroup = row.parentElement;
        if (parentGroup?.classList.contains("tree-group")) focusRow(parentGroup.previousElementSibling);
        return;
      }
      case "Enter":
        event.preventDefault();
        return activate(node);
      case " ":
        event.preventDefault();
        return model.select(node.key);
      case "F2":
        if (entry && entry.mode === "rw" && !node.isRoot) {
          event.preventDefault();
          startRename(entry.path);
        }
        return;
      case "Delete":
        if (entry && entry.mode === "rw" && !node.isRoot && !node.broken) {
          event.preventDefault();
          actionsFor(node, row).remove?.(entry);
        }
        return;
      case "n":
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        return startNew(dirOf(node) ?? roots?.home?.path, "file");
      case "ContextMenu":
        event.preventDefault();
        return menuFor(node, row, row);
      case "F10":
        if (!event.shiftKey) return;
        event.preventDefault();
        return menuFor(node, row, row);
      default:
        return;
    }
  }

  /** A file picker for "Upload files here…", when the menu rather than a drop brings the files. */
  function pickFiles(entry, anchor) {
    const input = el("input", { type: "file", multiple: true, class: "ws-file-input", "aria-hidden": "true", tabindex: "-1" });
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.remove();
      if (files.length) uploadTo(entry, { anchor, files });
    });
    document.body.append(input);
    input.click();
  }

  const uploadTo = (entry, { anchor, files } = {}) => {
    if (!files?.length) return pickFiles(entry, anchor);
    return upload(ext, model, { dir: entry.path, files, onDone: () => model.invalidate(entry.path) });
  };

  /** The actions bound to one entry for the file menu, the host's first and the explorer's own after. */
  function actionsFor(node, anchor) {
    const defaults = {
      open: (e) => openEntry(e),
      newFile: (e) => startNew(e.path, "file"),
      newFolder: (e) => startNew(e.path, "dir"),
      rename: (e) => startRename(e.path),
      copyPath: (e) => copyPath(e.path),
      upload: (e, ctx) => uploadTo(e, ctx),
      download: (e) => (e.kind === "dir" ? downloadZip(ext, model, e) : downloadFile(ext, e)),
      remove: (e, ctx) => confirmDelete(ctx?.anchor ?? tree, ext, model, e),
      count: (e) => model.count(e.path),
    };
    const bound = {};
    for (const name of ["open", "reveal", "newFile", "newFolder", "upload", "download", "copyPath", "rename", "remove", "count"]) {
      const fn = typeof actions[name] === "function" ? actions[name] : defaults[name];
      if (typeof fn !== "function") continue;
      if (node.isRoot && (name === "rename" || name === "remove")) continue;
      if (node.broken && name !== "copyPath") continue;
      bound[name] = (e) => fn(e, { anchor });
    }
    return bound;
  }

  function menuFor(node, at, anchor = at instanceof Element ? at : null) {
    if (node.t === "project") return;
    const host = compact ? "dock" : "explorer";
    const items = fileMenu(node.entry, host, actionsFor(node, anchor ?? tree));
    if (!items.length) return;
    openMenu(at, items, { onClose: () => anchor?.focus?.() });
  }

  async function copyPath(path) {
    try {
      await navigator.clipboard.writeText(path);
      ext.toast(`Copied ${path}`);
    } catch {
      ext.toast(`The path could not be copied: ${path}`, { tone: "warn" });
    }
  }

  /**
   * Binds a directory. The bind closes the person's fence, and the gateway serving this page with it, so the
   * request normally dies with a 502 before an answer: that is the workspace restarting, not a refusal. One
   * toast says so, then the roots are asked every 2 s (for up to 90 s) until the row's state changes, or the
   * roots answer twice with the same state after the restart; the tree redraws on every fresh answer and a
   * toast names the outcome. A genuine refusal (a 400 with a sentence) shows the sentence.
   */
  async function bindNow(path, button) {
    const name = nameOf(path) || path;
    const before = directoryState(roots, path);
    button.disabled = true;
    try {
      await model.bind(path, "rw");
    } catch (err) {
      if (!isRestartError(err)) {
        ext.toast(err?.message || `${path} could not be bound.`, { tone: "error" });
        button.disabled = false;
        return;
      }
    }
    ext.toast(`Binding ${name}… your workspace restarts; the row updates when it is back.`);
    const outcome = await waitForBind(path, before);
    if (!alive) return;
    if (outcome === undefined) ext.toast(`${name} is still ${before === "unmounted" ? "not mounted" : before} after 90 s. Refresh the tree once the workspace is back.`, { tone: "warn" });
    else {
      const said = bindOutcome(name, outcome);
      ext.toast(said.text, { tone: said.tone });
    }
  }

  /** Polls the roots until `path`'s state moves from `before`, or settles after a restart; undefined on timeout. */
  async function waitForBind(path, before) {
    const started = Date.now();
    let failed = false;
    let last = null;
    while (alive && Date.now() - started < BIND_POLL_LIMIT_MS) {
      await sleep(BIND_POLL_MS);
      if (!alive) return undefined;
      let state;
      try {
        state = directoryState(await model.roots({ session, force: true }), path);
      } catch {
        failed = true; // the workspace is still down; keep asking
        continue;
      }
      if (state !== before) return state;
      if (failed && last === state) return state; // back up, and twice the same: that is the answer
      last = state;
    }
    return undefined;
  }

  async function startRename(target) {
    const path = typeof target === "string" ? target : target?.path;
    if (!path) return;
    let node = nodesByKey.get(path);
    if (!node) {
      // Asked from a tab or a link: the row has to be on the page before it can hold the field.
      await reveal(path);
      node = nodesByKey.get(path);
      if (!node) return ext.toast(`${nameOf(path)} is not in the tree, so it cannot be renamed here.`, { tone: "warn" });
    }
    if (node.isRoot || node.broken) return;
    if (node && node.entry.mode !== "rw") return ext.toast(`${node.entry.name} is on a read-only root and cannot be renamed.`, { tone: "warn" });
    editing = { type: "rename", path, value: nameOf(path) };
    draw();
  }

  async function commitRename(path, name) {
    editing = null;
    if (!name || name === nameOf(path)) return draw();
    if (name.includes("/")) {
      ext.toast("A name cannot contain a slash.", { tone: "warn" });
      return draw();
    }
    try {
      const out = await model.rename(path, name);
      model.select(out.path);
      focused = out.path;
    } catch (err) {
      ext.toast(err?.message || `${nameOf(path)} could not be renamed.`, { tone: "error" });
    }
    draw();
  }

  function startNew(dir, kind) {
    if (!dir || !roots) return;
    const root = rootOf(roots, dir);
    if (!root) return ext.toast(`${dir} is not under a root of this workspace.`, { tone: "warn" });
    if (root.mode !== "rw") return ext.toast(`${root.name} is read-only, so nothing can be made in it.`, { tone: "warn" });
    editing = { type: "new", dir, kind: kind === "dir" ? "dir" : "file", value: "" };
    if (!model.isExpanded(dir)) model.setExpanded(dir, true, { silent: true });
    if (!model.listing(dir)) load(dir);
    draw();
  }

  async function commitNew(dirEntry, kind, name) {
    const dir = dirEntry.path;
    if (!name) {
      editing = null;
      return draw();
    }
    if (name.includes("/") || name === "." || name === "..") {
      ext.toast("A name cannot contain a slash, and cannot be . or ..", { tone: "warn" });
      return draw();
    }
    const taken = (model.listing(dir)?.entries ?? []).some((e) => e.name === name);
    if (taken) {
      ext.toast(`${name} is already in ${nameOf(dir) || dir}. Choose another name.`, { tone: "warn" });
      return draw();
    }
    editing = null;
    const path = joinPath(dir, name);
    try {
      if (kind === "dir") await model.mkdir(path);
      else await model.write(path, "");
      model.setExpanded(dir, true, { silent: true });
      model.select(path);
      focused = path;
      if (kind !== "dir") openEntry({ path, name, kind: "file", mode: dirEntry.mode, root: dirEntry.root, rootKind: dirEntry.rootKind, project: dirEntry.project });
    } catch (err) {
      ext.toast(err?.message || `${name} could not be created.`, { tone: "error" });
    }
    draw();
  }

  function refresh() {
    errors.clear();
    model.invalidateAll();
    model.roots({ session, force: true }).catch((err) => {
      rootsError = err?.message || "The roots could not be read.";
      scheduleDraw();
    });
  }

  /** Opens every folder on the way to `path`, loads them, selects the row and scrolls it into view. */
  async function reveal(path) {
    if (!alive || typeof path !== "string") return false;
    const data = roots ?? (await model.roots({ session }).catch(() => null));
    if (!alive || !data) return false;
    const root = rootOf(data, path);
    if (!root) return false;
    if (root.project) model.setExpanded(`project:${root.project.id}`, true, { silent: true });
    const chain = [];
    let p = path === root.path ? null : parentOf(path);
    while (p && isWithin(p, root.path)) {
      chain.unshift(p);
      if (p === root.path) break;
      p = parentOf(p);
    }
    for (const dir of chain) {
      model.setExpanded(dir, true, { silent: true });
      try {
        await model.list(dir);
      } catch (err) {
        errors.set(dir, err?.message || `${dir} could not be listed.`);
        break;
      }
      if (!alive) return false;
    }
    model.select(path);
    focused = path;
    draw();
    const row = tree.querySelector(`.tree-item[data-key="${CSS.escape(path)}"]`);
    row?.scrollIntoView({ block: "nearest" });
    return Boolean(row);
  }

  // ---- lifecycle ----

  function refreshRoots() {
    model
      .roots({ session })
      .then((data) => {
        if (!alive) return;
        roots = data;
        rootsError = null;
        if (!seeded) {
          seeded = true;
          // The first visit opens Home and every project group; after that the person's choices stand,
          // except that a project with a broken directory opens once per page load so its sentence is seen.
          if (!model.expanded.size) {
            if (data.home?.path) model.setExpanded(data.home.path, true, { silent: true });
            for (const project of data.projects ?? []) model.setExpanded(`project:${project.id}`, true, { silent: true });
          }
          for (const project of data.projects ?? []) {
            const mark = `${data.user ?? ""}:${project.id}`;
            if (!Number(project.summary?.broken ?? 0) || openedForBroken.has(mark)) continue;
            openedForBroken.add(mark);
            model.setExpanded(`project:${project.id}`, true, { silent: true });
          }
        }
        scheduleDraw();
      })
      .catch((err) => {
        if (!alive) return;
        rootsError = err?.message || "The roots could not be read.";
        scheduleDraw();
      });
  }

  const stop = model.watch((event) => {
    if (!alive) return;
    if (event.kind === "roots") return refreshRoots();
    if (event.kind === "explorer" && event.path === null) {
      // Dotfiles or the filter changed: the filter box may have been changed from elsewhere.
      if (filterInput.value !== model.filter) filterInput.value = model.filter;
      dotfiles.checked = model.hidden;
    }
    scheduleDraw();
  });

  refreshRoots();
  draw();

  return {
    update: () => draw(),
    reveal,
    newEntry: (dir, kind) => startNew(dir, kind),
    beginNew: (dir, kind) => startNew(dir, kind),
    rename: (target) => startRename(target),
    beginRename: (target) => startRename(target),
    select(path) {
      model.select(path);
      focused = path;
    },
    /** The row for a path, if it is drawn. */
    rowOf: (path) => tree.querySelector(`.tree-item[data-key="${CSS.escape(path)}"]`),
    element: host,
    destroy() {
      alive = false;
      stop();
      host.replaceChildren();
      host.classList.remove("ws-explorer", "is-compact");
    },
  };
}

export { formatBytes };

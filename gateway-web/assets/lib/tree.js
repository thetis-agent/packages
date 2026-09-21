/* A tree view: nodes that expand and collapse behind a disclosure toggle, nested to any depth, one of
 * them selected. The WAI-ARIA tree pattern: the host is `role="tree"`, every row a `treeitem` with its
 * level, `aria-expanded` when it has children, `aria-selected` when it is the one shown; the children sit
 * in a `group`. One row is in the tab order at a time, and the arrow keys move between the rows that are
 * showing: Down and Up walk them, Right expands a closed node or steps into an open one, Left collapses an
 * open node or steps out to its parent, Home and End jump, Enter and Space select. A click on the toggle
 * only opens or closes; a click on the row selects it, and opens it when it was closed, because a closed
 * parent is how the reader finds what is under it. Which nodes are open is remembered under `storageKey`
 * when one is given, so the tree comes back the way it was left.
 *
 * `nodes` are `{ key, label, title?, kind?, mark?, marks?, count?, children?, data? }`. `mark` is `err` or
 * `warn` for a dot before the label; `marks` is a list of `{ glyph, tone, title }` drawn after it, each a
 * small square with the glyph in it and its sentence as the tooltip. A node with a `warn` or `err` mark
 * "needs a look", and the tree can be narrowed to those (`setFocus`): a parent whose children were hidden
 * says how many, in a faint row nobody can select; the selected node is never hidden. `count` is
 * `{ total, look }` the owner worked out for a parent, drawn after its label as "28 · 6 need a look": the
 * tree draws what it is handed and knows nothing of what a mark means. `kind: "page"` marks a child that
 * is a page rather than a thing named in code, drawn in the sans face. `update(nodes, selected)` redraws
 * from new nodes, keeping what is open and where the focus is. */

import { el, icon } from "./dom.js";

const CHEVRON = ["M7.5 5.5 12 10l-4.5 4.5"];

export function createTree(host, { nodes = [], selected = null, onSelect, storageKey = null, openByDefault = true } = {}) {
  host.setAttribute("role", "tree");
  host.classList.add("tree");
  const open = new Map(); // key -> boolean, what the reader chose
  let current = selected;
  let focused = null; // the key that holds the tab stop
  let list = nodes;
  let only = false; // narrowed to what needs a look
  const FOCUS = "$focus"; // the storage entry that is not a node's

  try {
    if (storageKey) {
      for (const [key, on] of Object.entries(JSON.parse(localStorage.getItem(storageKey) || "{}"))) {
        if (key === FOCUS) only = Boolean(on);
        else open.set(key, Boolean(on));
      }
    }
  } catch {
    /* no storage: the tree opens by default */
  }

  function remember() {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ...Object.fromEntries(open), [FOCUS]: only }));
    } catch {
      /* no storage */
    }
  }

  const isOpen = (node) => (open.has(node.key) ? open.get(node.key) : openByDefault);
  const hasKids = (node) => Array.isArray(node.children) && node.children.length > 0;
  const needsLook = (node) => node.mark === "warn" || node.mark === "err" || (Array.isArray(node.marks) && node.marks.some((m) => m && (m.tone === "warn" || m.tone === "err")));
  /** A child stays in view when it needs a look, is selected, is a page, or has a child that stays. */
  const shown = (node, level) => !only || level === 1 || node.key === current || node.kind === "page" || needsLook(node) || (hasKids(node) && node.children.some((c) => shown(c, level + 1)));

  /** The rows that are showing, in reading order, each with its node, its level and its parent. */
  function visible(from = list, level = 1, parent = null, out = []) {
    for (const node of from) {
      if (!shown(node, level)) continue;
      out.push({ node, level, parent });
      if (hasKids(node) && isOpen(node)) visible(node.children, level + 1, node, out);
    }
    return out;
  }

  function setOpen(node, on) {
    if (!hasKids(node)) return;
    open.set(node.key, on);
    remember();
    draw();
  }

  function select(node) {
    current = node.key;
    if (hasKids(node) && !isOpen(node)) setOpen(node, true);
    else draw();
    onSelect?.(node);
  }

  function row(node, level) {
    const kids = hasKids(node);
    const marks = (Array.isArray(node.marks) ? node.marks : []).filter((m) => m && typeof m.glyph === "string");
    const item = el(
      "div",
      {
        class: `tree-item${node.key === current ? " is-selected" : ""}${kids ? " has-children" : ""}${node.kind === "page" ? " is-page" : ""}`,
        role: "treeitem",
        "aria-level": String(level),
        "aria-selected": node.key === current ? "true" : "false",
        "aria-expanded": kids ? (isOpen(node) ? "true" : "false") : null,
        tabindex: node.key === focused ? "0" : "-1",
        title: node.title ?? null,
        "data-key": node.key,
        onClick: () => select(node),
        onKeydown: (event) => key(event, node),
      },
      kids
        ? el("span", { class: `tree-toggle${isOpen(node) ? " is-open" : ""}`, "aria-hidden": "true", onClick: (event) => { event.stopPropagation(); setOpen(node, !isOpen(node)); } }, icon(CHEVRON, { size: 12, width: 1.8 }))
        : el("span", { class: "tree-toggle is-leaf", "aria-hidden": "true" }),
      node.mark ? el("span", { class: `tree-mark is-${node.mark}`, "aria-hidden": "true" }) : null,
      el("span", { class: "tree-label" }, node.label ?? node.key),
      node.count && typeof node.count === "object"
        ? el("span", { class: "tree-count" }, String(node.count.total ?? ""), node.count.look ? el("span", { class: "tree-count-look" }, ` · ${node.count.look} need${node.count.look === 1 ? "s" : ""} a look`) : null)
        : null,
      marks.length ? el("span", { class: "tree-marks" }, ...marks.map((m) => el("span", { class: `tree-glyph is-${m.tone || "dim"}`, title: m.title ?? null, "aria-label": m.title ?? null }, m.glyph))) : null
    );
    item.style.setProperty("--depth", String(level - 1));
    return item;
  }

  /** The faint row that stands for the children the narrowing hid: a count, nothing to select. */
  function hiddenRow(n, level) {
    const r = el("div", { class: "tree-hidden", "aria-hidden": "true" }, el("span", { class: "tree-toggle is-leaf" }), el("span", { class: "tree-label" }, `${n} without a look`));
    r.style.setProperty("--depth", String(level - 1));
    return r;
  }

  function group(node, level) {
    const kids = node.children.filter((c) => shown(c, level + 1));
    const hidden = node.children.length - kids.length;
    const g = el("div", { class: "tree-group", role: "group" }, ...branch(kids, level + 1), hidden ? hiddenRow(hidden, level + 1) : null);
    g.style.setProperty("--depth", String(level - 1)); // the guide line hangs from the parent's toggle
    return g;
  }

  function branch(from, level) {
    return from.flatMap((node) => [row(node, level), hasKids(node) && isOpen(node) ? group(node, level) : null]).filter(Boolean);
  }

  function focus(key) {
    focused = key;
    for (const item of host.querySelectorAll(".tree-item")) item.tabIndex = item.dataset.key === key ? 0 : -1;
    host.querySelector(`.tree-item[data-key="${CSS.escape(key)}"]`)?.focus();
  }

  function key(event, node) {
    const rows = visible();
    const at = rows.findIndex((r) => r.node.key === node.key);
    if (at < 0) return;
    const go = (index) => { event.preventDefault(); focus(rows[Math.max(0, Math.min(rows.length - 1, index))].node.key); };
    switch (event.key) {
      case "ArrowDown": return go(at + 1);
      case "ArrowUp": return go(at - 1);
      case "Home": return go(0);
      case "End": return go(rows.length - 1);
      case "ArrowRight":
        if (!hasKids(node)) return;
        event.preventDefault();
        if (!isOpen(node)) return setOpen(node, true), focus(node.key);
        return go(at + 1);
      case "ArrowLeft":
        event.preventDefault();
        if (hasKids(node) && isOpen(node)) return setOpen(node, false), focus(node.key);
        if (rows[at].parent) return focus(rows[at].parent.key);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        return select(node);
      default:
        return;
    }
  }

  function draw() {
    const keys = new Set(visible().map((r) => r.node.key));
    if (!focused || !keys.has(focused)) focused = keys.has(current) ? current : visible()[0]?.node.key ?? null;
    const had = document.activeElement && host.contains(document.activeElement);
    host.replaceChildren(...branch(list, 1));
    if (had && focused) host.querySelector(`.tree-item[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  draw();
  return {
    /** New nodes, and the key to show as selected (null keeps the current one). What is open and focused is kept. */
    update(next, selectedKey) {
      list = next;
      if (selectedKey !== undefined) current = selectedKey;
      draw();
    },
    select(key) {
      current = key;
      draw();
    },
    /** Narrows the tree to the nodes that need a look (and their parents), or shows everything again. Remembered. */
    setFocus(on) {
      only = Boolean(on);
      remember();
      draw();
    },
    get focus() {
      return only;
    },
    /** Opens every node on the way to `key`, so a selected page is never hidden under a closed parent. */
    reveal(key) {
      const path = (from) => {
        for (const node of from) {
          if (node.key === key) return [node];
          if (hasKids(node)) {
            const below = path(node.children);
            if (below) return [node, ...below];
          }
        }
        return null;
      };
      const found = path(list) ?? [];
      for (const node of found.slice(0, -1)) if (!isOpen(node)) open.set(node.key, true);
      if (found.length > 1) remember();
      draw();
    },
  };
}

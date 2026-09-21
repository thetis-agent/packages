/* The control panel: somewhere you go and read rather than a dialog you dismiss. It is the first place:
 * registered through the built-in `ext` under `@thetis/gateway-web`, so its item in the sidebar's menu
 * and its frame come from the same slots a package would use. Inside, a tree of sections on the left
 * (`lib/tree.js`: disclosure toggles, nesting, the arrow keys, what is open remembered) and one page
 * mounted at a time. The one built-in section, Packages, is a `panel` entry too, with a low order so it
 * sorts first; the server's `api/panel` still says which built-in sections this person may see. Every
 * other section (People, Models, Mounts, Activity, Overview from `@thetis/ui-admin`) is listed as its
 * package declared it, and only when `api/ui` listed it for the person's role.
 *
 * A `panel` entry declared with `under: <section id>` is not a node of its own: it hangs pages under that
 * section, the nodes its module answers from `children()` (`{ id, label, note?, mark?, children? }`, to
 * any depth), and selecting one mounts the entry with `child` naming it. That is how the packages with
 * configuration sit under Packages, each with a page of its own, without the shell knowing what
 * configuration is. The children are read when the panel opens, when a module registers late, when the
 * parent section is shown, and when a page asks through `refresh`. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import * as registry from "../lib/registry.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { createTree } from "../lib/tree.js";
import { mountPackages } from "./panel-packages.js";

export const GEAR = ["M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z", "M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"];

/** The built-in sections. The note is the sentence under the title; the order sorts them before a package's (default 100). */
export const PANEL_SECTIONS = [{ id: "packages", label: "Packages", note: "What is installed here, and what each package brings.", order: 10, mount: mountPackages }];

export const PANEL_PLACE = { id: "panel", label: "Control panel", hint: "How this place is set up", icon: GEAR, order: 10 };

/** Where the tree keeps what the reader opened and closed. */
const TREE_STATE = "thetis.panel.tree";

/** Registers the sections and the place with the shell. `shell.openPlace(key, params)` lets a built-in section link to another package's place. */
export function installPanel(ext, shell) {
  for (const section of PANEL_SECTIONS) ext.panel(section.id, { mount: (root, who) => section.mount(root, who, shell) });
  ext.place(PANEL_PLACE.id, { open: openPanel });
}

/** Whether an entry declared `under` hangs beneath `section`: by the built-in id, or by the full key of a package's section. */
const hangsUnder = (entry, section) => entry.decl.under === section.id || entry.decl.under === section.key;

/** A tree node's key: the entry's, or the entry's and the page's. */
const nodeKey = (entryKey, child) => (child ? `${entryKey}:${child}` : entryKey);

/** Draws the panel into a place's body. `params.section` names the entry key to show first, `params.child` a page under it. */
function openPanel(root, params) {
  const treeHost = el("div", { class: "panel-tree" });
  const foot = el("div", { class: "panel-nav-foot" });
  const nav = el("nav", { class: "panel-nav", "aria-label": "Control panel sections" }, treeHost, foot);
  const main = el("div", { class: "panel-main" });
  root.append(el("div", { class: "panel-shell" }, nav, main));
  let sections = [];            // the nav's own items, in order
  let hung = [];                // entries with `under`: pages beneath a section
  const children = new Map();   // hung entry key -> what its module answered
  let current = { key: null, child: null };
  let role = null;
  let unmount = null;
  let closed = false;
  const tree = createTree(treeHost, { storageKey: TREE_STATE, onSelect: (node) => show(node.data.entryKey, node.data.child) });

  /** The pages a hung entry answered, as tree nodes, to any depth. A page's marks travel as the module gave them. */
  function pages(entry, list) {
    return (Array.isArray(list) ? list : [])
      .filter((k) => k && typeof k.id === "string")
      .map((k) => ({ key: nodeKey(entry.key, k.id), label: k.label || k.id, title: k.note ?? null, kind: k.kind === "page" ? "page" : null, mark: k.mark ?? null, marks: Array.isArray(k.marks) ? k.marks : [], data: { entryKey: entry.key, child: k.id }, children: pages(entry, k.children) }));
  }

  /** A node needs a look when a package said so with a warn or err mark. The count on a section is of its pages, not of pages of pages. */
  const looks = (node) => node.mark === "warn" || node.mark === "err" || node.marks.some((m) => m && (m.tone === "warn" || m.tone === "err"));

  /** The legend at the foot: every glyph in use, once, with the first sentence it came with. */
  function drawFoot(nodes) {
    clear(foot);
    const seen = new Map();
    const walk = (list) => { for (const n of list) { for (const m of n.marks ?? []) if (m?.glyph && !seen.has(m.glyph)) seen.set(m.glyph, m); walk(n.children ?? []); } };
    walk(nodes);
    if (!seen.size) return;
    const legend = el("div", { class: "tree-legend" }, ...[...seen.values()].map((m) => el("span", { class: "tree-legend-item" }, el("span", { class: `tree-glyph is-${m.tone || "dim"}`, "aria-hidden": "true" }, m.glyph), el("span", {}, legendWord(m)))));
    const box = el("input", { type: "checkbox", checked: tree.focus ? "" : null, onChange: () => tree.setFocus(box.checked) });
    foot.append(legend, el("label", { class: "tree-focus" }, box, "only what needs a look"));
  }

  /** The legend's word for a mark: the sentence's first clause, so "update 0.2.0 on offer" reads "update on offer". */
  const legendWord = (m) => String(m.title || "").replace(/\s+\S*\d\S*/g, "").split(/[:;,(]/)[0].trim().toLowerCase() || m.glyph;

  function drawNav() {
    const nodes = sections.map((section) => {
      const kids = hung.filter((e) => hangsUnder(e, section)).flatMap((e) => pages(e, children.get(e.key)));
      const counted = kids.filter((k) => k.kind !== "page");
      return {
        key: section.key,
        label: section.decl.label || section.id,
        data: { entryKey: section.key, child: null },
        count: counted.length ? { total: counted.length, look: counted.filter(looks).length } : null,
        children: kids,
      };
    });
    tree.update(nodes, nodeKey(current.key, current.child));
    drawFoot(nodes);
  }

  /** Asks every hung entry (or the ones under `section`) for its children again, and redraws the nav. */
  async function refreshChildren(section) {
    const asked = hung.filter((e) => e.impl?.children && (!section || hangsUnder(e, section)));
    await Promise.all(
      asked.map(async (entry) => {
        const out = registry.guard(entry.package, "panel", entry.impl.children);
        let list = [];
        try {
          list = out.ok ? await out.value : [];
        } catch (err) {
          toast(`${entry.package}: ${err.message}`, { tone: "error" });
        }
        if (!closed) children.set(entry.key, list);
      })
    );
    if (!closed) drawNav();
  }

  function show(key, child = null) {
    unmount?.();
    unmount = null;
    current = { key: key ?? null, child };
    drawNav();
    clear(main);
    const entry = [...sections, ...hung].find((e) => e.key === current.key);
    if (!entry || (hung.includes(entry) && !child)) {
      main.append(el("div", { class: "panel-empty" }, "Nothing to set up here."));
      return;
    }
    if (entry.decl.note) main.append(el("p", { class: "panel-note" }, entry.decl.note));
    if (!entry.impl?.mount) return main.append(registry.failureOf(entry.package) ? registry.broken(entry.package) : el("div", { class: "panel-empty" }, "Loading…"));
    // `open(child)` lets a page of a hung entry send the reader to a sibling page (a fleet row to its package).
    const who = { role, user: store.get("user")?.user, child, refresh: () => void refreshChildren(), open: (next) => { show(key, next); tree.reveal(nodeKey(key, next)); } };
    const out = registry.guard(entry.package, "panel", entry.impl.mount, main, who);
    if (!out.ok) return main.append(registry.broken(entry.package));
    unmount = typeof out.value === "function" ? out.value : null;
    if (!child && hung.some((e) => hangsUnder(e, entry))) void refreshChildren(entry);
  }

  /** The declared entries, split into the nav's items and the pages hung under them; a page under an absent section is dropped. */
  function collect(allowed) {
    const entries = registry.entries("panel").filter((e) => e.package !== registry.BUILTIN || allowed.includes(e.id));
    sections = entries.filter((e) => !e.decl.under);
    hung = entries.filter((e) => e.decl.under && sections.some((s) => hangsUnder(e, s)));
  }

  const stops = [];

  async function load() {
    let allowed = [];
    try {
      const p = await api("/api/panel");
      allowed = p.sections;
      role = p.role;
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
    if (closed) return;
    collect(allowed);
    const wanted = params?.section && [...sections, ...hung].some((e) => e.key === params.section) ? params.section : sections[0]?.key;
    const child = typeof params?.child === "string" ? params.child : null;
    show(wanted, child);
    // Showing a section reads the children under it; the rest are read here, once.
    const shown = sections.find((s) => s.key === wanted);
    if (!shown || !hung.some((e) => hangsUnder(e, shown))) await refreshChildren();
    if (child) tree.reveal(nodeKey(wanted, child));
    // A module that registers after the panel opened: its pages appear, and a page waiting on it is drawn.
    const stop = registry.watch((change) => {
      if (change.kind !== "register" || change.slot !== "panel") return;
      collect(allowed);
      if (current.key === registry.keyOf(change.package, change.id) && !unmount) show(current.key, current.child);
      void refreshChildren();
    });
    if (closed) stop();
    else stops.push(stop);
  }

  void load();
  return () => {
    closed = true;
    for (const stop of stops) stop();
    unmount?.();
    unmount = null;
  };
}

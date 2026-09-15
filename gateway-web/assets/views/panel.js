/* The control panel: somewhere you go and read rather than a dialog you dismiss. It is the first place:
 * registered through the built-in `ext` under `@thetis/gateway-web`, so its launcher in the sidebar
 * footer and its frame come from the same slots a package would use. Inside, a navigation of sections
 * and one section mounted at a time. The built-in sections (Packages, and for admins People, Models,
 * Activity, Overview) are `panel` entries too; the server's `api/panel` still says which of them this
 * person may see. A section a package registers is listed as it was declared. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import * as registry from "../lib/registry.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { mountActivity } from "./panel-activity.js";
import { mountModels } from "./panel-models.js";
import { mountOverview } from "./panel-overview.js";
import { mountPackages } from "./panel-packages.js";
import { mountPeople } from "./panel-people.js";

export const GEAR = ["M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z", "M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"];

/** The built-in sections, in the order the panel lists them. The notes are the sentence under each title. */
export const PANEL_SECTIONS = [
  { id: "packages", label: "Packages", note: "What is installed, what the registries offer, and what each one brings.", mount: mountPackages },
  { id: "people", label: "People", note: "Who can sign in, and what they may do.", mount: mountPeople },
  { id: "models", label: "Models", note: "Which model answers by default, and what the providers serve.", mount: mountModels },
  { id: "activity", label: "Activity", note: "What happened: who did what, and when.", mount: mountActivity },
  { id: "overview", label: "Overview", note: "How this installation is set up.", mount: mountOverview },
];

export const PANEL_PLACE = { id: "panel", label: "Control panel", hint: "How this place is set up", icon: GEAR };

/** Registers the sections and the place with the shell. */
export function installPanel(ext) {
  for (const section of PANEL_SECTIONS) ext.panel(section.id, { mount: section.mount });
  ext.place(PANEL_PLACE.id, { open: openPanel });
}

/** Draws the panel into a place's body. `params.section` names the entry key to show first. */
function openPanel(root, params) {
  const nav = el("nav", { class: "panel-nav", "aria-label": "Control panel sections" });
  const main = el("div", { class: "panel-main" });
  root.append(el("div", { class: "panel-shell" }, nav, main));
  let entries = [];
  let current = null;
  let role = null;
  let unmount = null;
  let closed = false;

  function drawNav() {
    clear(nav);
    for (const entry of entries) {
      nav.append(el("button", { type: "button", class: `panel-nav-item${entry.key === current ? " is-active" : ""}`, "aria-current": entry.key === current ? "page" : null, onClick: () => show(entry.key) }, entry.decl.label || entry.id));
    }
  }

  function show(key) {
    unmount?.();
    unmount = null;
    current = key ?? null;
    drawNav();
    clear(main);
    const entry = entries.find((e) => e.key === current);
    if (!entry) {
      main.append(el("div", { class: "panel-empty" }, "Nothing to set up here."));
      return;
    }
    if (entry.decl.note) main.append(el("p", { class: "panel-note" }, entry.decl.note));
    if (!entry.impl?.mount) return main.append(registry.failureOf(entry.package) ? registry.broken(entry.package) : el("div", { class: "panel-empty" }, "Loading…"));
    const out = registry.guard(entry.package, "panel", entry.impl.mount, main, { role, user: store.get("user")?.user });
    if (!out.ok) return main.append(registry.broken(entry.package));
    unmount = typeof out.value === "function" ? out.value : null;
  }

  async function load() {
    let sections = [];
    try {
      const p = await api("/api/panel");
      sections = p.sections;
      role = p.role;
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
    if (closed) return;
    entries = registry.entries("panel").filter((e) => e.package !== registry.BUILTIN || sections.includes(e.id));
    show(params?.section && entries.some((e) => e.key === params.section) ? params.section : entries[0]?.key);
  }

  void load();
  return () => {
    closed = true;
    unmount?.();
    unmount = null;
  };
}

/* The control panel: somewhere you go and read rather than a dialog you dismiss. It takes over the main
 * pane, lists the sections the server offers for this person, and mounts one at a time. The launcher sits
 * in the sidebar footer beside Log out. */

import { api } from "../lib/api.js";
import { $, clear, el, icon } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { mountMarketplace } from "./panel-marketplace.js";
import { mountModels } from "./panel-models.js";
import { mountOverview } from "./panel-overview.js";
import { mountPackages } from "./panel-packages.js";
import { mountPeople } from "./panel-people.js";

const GEAR = ["M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z", "M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"];
const X = ["M5 5l10 10", "M15 5l-10 10"];

const SECTIONS = {
  packages: { label: "Packages", note: "What is installed for you, and what each one brings.", mount: mountPackages },
  marketplace: { label: "Marketplace", note: "Packages the registries offer, ready to install.", mount: mountMarketplace },
  people: { label: "People", note: "Who can sign in, and what they may do.", mount: mountPeople },
  models: { label: "Models", note: "Which model answers by default, and what the providers serve.", mount: mountModels },
  overview: { label: "Overview", note: "How this installation is set up.", mount: mountOverview },
};

export function mountPanel() {
  const actions = document.querySelector(".foot-actions");
  const launcher = el("button", { type: "button", class: "quiet-link foot-action", title: "How this place is set up", onClick: () => open() }, icon(GEAR, { size: 14 }), "Control panel");
  actions?.prepend(launcher);

  let node = null;
  let nav = null;
  let main = null;
  let sub = null;
  let sections = [];
  let current = null;
  let unmount = null;

  function onKey(e) {
    if (e.key === "Escape" && !document.querySelector(".popover")) close();
  }

  async function open(id) {
    if (!node) {
      nav = el("nav", { class: "panel-nav", "aria-label": "Control panel sections" });
      main = el("div", { class: "panel-main" });
      sub = el("span", { class: "panel-sub" });
      node = el(
        "section",
        { class: "panel", "aria-label": "Control panel" },
        el("div", { class: "panel-head" }, el("div", {}, el("h1", { class: "panel-title" }, "Control panel"), sub), el("button", { type: "button", class: "icon-btn", title: "Close (Esc)", "aria-label": "Close the control panel", onClick: close }, icon(X, { size: 14, width: 1.9 }))),
        el("div", { class: "panel-shell" }, nav, main)
      );
      document.querySelector(".main").append(node);
      $("app").classList.add("is-panel");
      document.addEventListener("keydown", onKey);
    }
    try {
      const p = await api("/api/panel");
      sections = p.sections.filter((s) => SECTIONS[s]);
      store.set({ panelRole: p.role });
    } catch (err) {
      toast(err.message, { tone: "error" });
      sections = [];
    }
    show(id && sections.includes(id) ? id : sections[0]);
  }

  function close() {
    if (!node) return;
    unmount?.();
    unmount = null;
    node.remove();
    node = null;
    current = null;
    $("app").classList.remove("is-panel");
    document.removeEventListener("keydown", onKey);
    store.set({ panel: null });
  }

  function drawNav() {
    clear(nav);
    for (const id of sections) {
      nav.append(el("button", { type: "button", class: `panel-nav-item${id === current ? " is-active" : ""}`, "aria-current": id === current ? "page" : null, onClick: () => show(id) }, SECTIONS[id].label));
    }
  }

  function show(id) {
    unmount?.();
    unmount = null;
    current = id ?? null;
    store.set({ panel: current });
    drawNav();
    clear(main);
    if (!current) {
      sub.textContent = "";
      main.append(el("div", { class: "panel-empty" }, "Nothing to set up here."));
      return;
    }
    sub.textContent = SECTIONS[current].note;
    const result = SECTIONS[current].mount(main, { role: store.get("panelRole"), user: store.get("user")?.user, open });
    unmount = typeof result === "function" ? result : null;
  }

  return { open, close };
}

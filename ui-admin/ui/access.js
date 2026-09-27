/* Access: what a workspace can reach outside itself, on one page with a tab each. Mounts are host
 * directories bound into a workspace; SSH keys are the keys it may use and the hosts it may reach. A person
 * sees their own, and an admin everyone's (each tab branches on `who.role`, as before). Registries, where
 * extensions come from, and their repository keys belong to the installation; they live on the
 * Marketplace's Registries page, and an admin's third tab says so rather than keeping a second copy here. */

import { mountMounts } from "./mounts.js";
import { mountSsh } from "./ssh.js";

const TABS = [
  ["mounts", "Mounts", null],
  ["ssh", "SSH keys", null],
  ["registries", "Registries", "admin"],
];

/** The tab this page opened on last, for as long as the page is open: coming back to Access lands on it. */
let remembered = "mounts";

/** The tabs a person sees: the admin's third is left out for a user. */
export const tabsFor = (role) => TABS.filter(([, , need]) => !need || role === "admin").map(([id, label]) => ({ id, label }));

export function mountAccess(ext, root, who = {}) {
  const { el, clear } = ext.dom;
  const { card, put } = ext.ui;
  const tabs = tabsFor(who.role);
  let tab = tabs.some((t) => t.id === remembered) ? remembered : tabs[0].id;
  let unmount = null;
  const strip = el("div", { class: "ua-pkg-tabs ua-access-tabs", role: "tablist" });
  const body = el("div", { class: "ua-access-body" });
  root.append(el("div", { class: "ua-access" }, strip, body));

  function registries(host) {
    const node = el(
      "div",
      { class: "panel-cols" },
      el(
        "div",
        { class: "panel-col" },
        card(
          "Registries and repository keys",
          el("p", {}, "The registries extensions are installed from, and the key each private one is read with, are on the Marketplace's Registries page: open the Marketplace from the menu, then Registries."),
          el("p", { class: "text-faint" }, "They belong to the installation, not to one person, so they are kept apart from people's SSH keys.")
        )
      )
    );
    host.append(node);
  }

  function show(id) {
    tab = id;
    remembered = id;
    unmount?.();
    unmount = null;
    clear(strip);
    for (const t of tabs) put(strip, el("button", { type: "button", role: "tab", class: `ua-pkg-tab${t.id === tab ? " is-on" : ""}`, "aria-selected": t.id === tab ? "true" : "false", "data-tab": t.id, onClick: () => show(t.id) }, t.label));
    clear(body);
    const out = id === "mounts" ? mountMounts(ext, body, who) : id === "ssh" ? mountSsh(ext, body, who) : registries(body);
    unmount = typeof out === "function" ? out : null;
  }

  show(tab);
  return () => {
    unmount?.();
    unmount = null;
  };
}

/* Advanced: the troubleshooting half of the control panel, for an admin. Three pages hang under it (the
 * manifest's `advanced-pages` entry, `under: "advanced"`): Workspaces (each workspace's code, restart and
 * force, the Thetis server's own card), Extensions by person (the full matrix, one column per person) and
 * Server settings (the configuration as the kernel reports it, secrets hidden). An extension opened from the
 * matrix is drawn here too, as its full page. The section itself is a short index of the three. */

import { mountFleet } from "./fleet.js";
import { mountPackagePage } from "./package-page.js";
import { mountWorkspaces } from "./workspaces.js";
import { failedCard } from "./failed.js";

export const PAGES = Object.freeze([
  { id: "workspaces", label: "Workspaces", kind: "page", note: "Each workspace's code, and restarting one" },
  { id: "fleet", label: "Extensions by person", kind: "page", note: "Every extension in every workspace" },
  { id: "server", label: "Server settings", kind: "page", note: "The configuration as Thetis reads it, secrets hidden" },
]);

/** The pages under Advanced, for the tree. */
export const advancedChildren = () => PAGES.map((p) => ({ ...p }));

/** The Advanced section: an index of its pages, each opening through the tree's `open`. */
export function mountAdvanced(ext, root, who = {}) {
  if (who.child) return mountAdvancedPage(ext, root, who);
  const { el } = ext.dom;
  const { button, card, heading, put } = ext.ui;
  const wrap = el("div", { class: "panel-col ua-advanced" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  put(
    wrap,
    heading("Advanced", "for troubleshooting"),
    ...PAGES.map((p) => card(p.label, el("p", { class: "text-dim" }, p.note), el("div", { class: "card-actions" }, button("Open", { onClick: () => who.open?.(p.id) })))),
    el("p", { class: "panel-hint" }, "Everyday updating is on the Overview and under Extensions. These pages are for when one workspace or one extension needs a hand.")
  );
}

/** One page under Advanced, or an extension's page opened from the matrix. */
export function mountAdvancedPage(ext, root, { child, refresh, user, open } = {}) {
  if (!child) return mountAdvanced(ext, root, { refresh, user, open });
  if (child === "workspaces") return mountWorkspaces(ext, root, { user });
  if (child === "fleet") return mountFleet(ext, root, { mode: "full", refresh, onOpen: (name) => open?.(name), ...(user ? { user } : {}) });
  if (child === "server") return mountServerSettings(ext, root);
  return mountPackagePage(ext, root, { name: child, refresh, advanced: true, ...(user ? { user } : {}) });
}

/** Server settings: the configuration as the kernel reports it, with secrets hidden. Read only; the file is where it changes. */
export function mountServerSettings(ext, root) {
  const { el, clear } = ext.dom;
  const { busy, card, heading, kv, put } = ext.ui;
  const wrap = el("div", { class: "panel-col ua-server" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  let alive = true;
  const code = (text) => el("code", { class: "ua-wrap" }, text);

  async function load() {
    const stop = busy(wrap, "Reading the configuration…");
    let config = null;
    let failed = null;
    try {
      config = (await ext.request("config")).data ?? null;
    } catch (err) {
      failed = err;
    } finally {
      stop();
    }
    if (!alive) return;
    clear(wrap);
    if (failed || !config) return void put(wrap, heading("Server settings"), failedCard(ext, "The configuration", failed ?? new Error("no answer"), { admin: true, retry: () => void load() }));
    const { packages, systemPackages, fence, ...kernel } = config;
    put(
      wrap,
      heading("Server settings", "as Thetis read them; secrets are hidden"),
      card("Server", kv(Object.entries(kernel).map(([k, v]) => [k, code(typeof v === "object" ? JSON.stringify(v) : String(v))]))),
      card("Extensions everyone gets", kv(Object.entries(systemPackages ?? {}).map(([k, v]) => [k === "*" ? "everyone" : k, code((v ?? []).join(", ") || "none")]))),
      card("Workspace sandbox", kv(Object.entries(fence ?? {}).map(([k, v]) => [k, code(Array.isArray(v) ? v.join("\n") : String(v))]))),
      card(
        "Extension settings in the file",
        el("p", { class: "text-faint" }, "Secrets are hidden. Edit thetis.config.json on the host to change these, or use an extension's Settings tab."),
        ...Object.entries(packages ?? {}).map(([name, cfg]) => el("div", { class: "ua-kv-block" }, el("div", { class: "ua-kv-title" }, el("code", {}, name)), el("pre", { class: "ua-pre" }, JSON.stringify(cfg, null, 2))))
      )
    );
  }

  void load();
  return () => {
    alive = false;
  };
}

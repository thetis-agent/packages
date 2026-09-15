/* Loads the UI of every installed package that declares one. `GET api/ui` lists them; for each, in order:
 * the declaration goes into the registry (which draws the rail button, the panel nav item, the place
 * link, the chip, the statusbar item before any code runs), the stylesheet is linked, the entry module
 * is imported and its default export called with an `ext` bound to the package. A module that fails to
 * import or throws on install is one toast, and its static entries stay with a "could not load" tooltip.
 * A gateway without the route, or a failed request, means no extensions and no complaint. */

import { api } from "./api.js";
import { createExt } from "./ext.js";
import * as registry from "./registry.js";
import { toast } from "./toast.js";

async function fetchUi() {
  try {
    const ui = await api("/api/ui");
    return { extensions: Array.isArray(ui?.extensions) ? ui.extensions : [], refused: Array.isArray(ui?.refused) ? ui.refused : [] };
  } catch {
    return { extensions: [], refused: [] };
  }
}

function linkStyle(href) {
  if (document.querySelector(`link[rel="stylesheet"][href="${CSS.escape(href)}"]`)) return;
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href }));
}

async function load(extension) {
  const pkg = extension.package;
  const base = extension.base || `ext/${pkg}/`;
  registry.declare(extension);
  if (extension.style) linkStyle(new URL(base + extension.style, document.baseURI).href);
  if (!extension.entry) return;
  try {
    const mod = await import(new URL(base + extension.entry, document.baseURI).href);
    if (typeof mod.default !== "function") throw new Error("the entry module has no default export");
    await mod.default(createExt(extension));
  } catch (err) {
    console.error(`${pkg} could not load its UI:`, err);
    registry.fail(pkg, err?.message || "could not load");
    toast(`${pkg} could not load its UI`, { tone: "error" });
  }
}

/** Runs after the built-in views have mounted. Resolves when every extension has been tried. */
export async function loadExtensions() {
  const { extensions, refused } = await fetchUi();
  for (const r of refused) console.warn(`${r.package}: its UI was refused: ${r.message}`);
  for (const extension of extensions) {
    if (typeof extension?.package !== "string") continue;
    await load(extension);
  }
}

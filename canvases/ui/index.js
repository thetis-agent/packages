/* The browser module of @thetis/canvases. The shell calls `install(ext)` once after the page has mounted.
 * It needs three things of the gateway — a frame seam (`ext.frame`), tab kinds (`ext.tab`) and the sidebar
 * section — and says so on the console when one is missing rather than half-mounting. It builds the page's
 * canvas model, mounts the Canvases section, and registers the tab kind. Nothing runs at import. */

import { createModel } from "./model.js";
import { mountSidebar } from "./sidebar.js";
import { openCanvasTab } from "./tab.js";

export default function install(ext) {
  if (!ext.frame?.url || typeof ext.tab !== "function" || typeof ext.sidebar !== "function" || !ext.open?.tab) {
    console.warn("@thetis/canvases needs a newer web gateway: one with frames and tab kinds.");
    return;
  }
  const model = createModel(ext);
  ext.sidebar("canvases", { mount: (body, tools) => mountSidebar(ext, model, body, tools) });
  ext.tab("canvas", { open: (root, handle) => openCanvasTab(ext, model, root, handle) });
  model.start();
}

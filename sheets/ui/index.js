/* The browser module of @thetis/sheets. The shell calls `install(ext)` once after the page has mounted. It
 * needs tab kinds (`ext.tab`, `ext.open.tab`) and the sidebar section, and says so on the console when one
 * is missing rather than half-mounting; the raw seam (import and download) is optional, and the places that
 * use it say so when it is missing. It builds the page's sheet model, mounts the Sheets section, and
 * registers the tab kind. Nothing runs at import. */

import { createModel } from "./model.js";
import { mountSidebar } from "./sidebar.js";
import { openSheetTab } from "./tab.js";

export default function install(ext) {
  if (typeof ext.tab !== "function" || typeof ext.sidebar !== "function" || !ext.open?.tab) {
    console.warn("@thetis/sheets needs a newer web gateway: one with tab kinds and sidebar sections.");
    return;
  }
  const model = createModel(ext);
  ext.sidebar("sheets", { mount: (body, tools) => mountSidebar(ext, model, body, tools) });
  ext.tab("sheet", { open: (root, handle) => openSheetTab(ext, model, root, handle) });
  model.start();
}

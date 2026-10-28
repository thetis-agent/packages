/* The browser module of @bitmuse/moo-maps: the Maps section of the sidebar and the map tab kind. The tab
 * hosts the cartographer in a sandboxed frame; the tools in the chat and the tab edit the same file. */

import { createModel } from "./model.js";
import { mountSidebar } from "./sidebar.js";
import { openMapTab } from "./tab.js";

export default function install(ext) {
  if (typeof ext.tab !== "function" || typeof ext.sidebar !== "function" || !ext.open?.tab) {
    console.warn("@bitmuse/moo-maps needs a newer web gateway: one with tab kinds and sidebar sections.");
    return;
  }
  const model = createModel(ext);
  ext.sidebar("maps", { mount: (body, tools) => mountSidebar(ext, model, body, tools) });
  ext.tab("map", { open: (root, handle) => openMapTab(ext, model, root, handle) });
  model.start();
}

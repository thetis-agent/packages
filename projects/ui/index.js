/* The browser module of @thetis/projects. The shell calls `install(ext)` once after the page has
 * mounted. It builds the page's project state, puts the switcher in the sidebar's head slot, and
 * registers the settings place. Nothing runs at import. */

import { openPlace } from "./place.js";
import { createState } from "./state.js";
import { mountSwitcher } from "./switcher.js";

export default function install(ext) {
  const state = createState(ext);
  ext.sidebar("head", (root) => mountSwitcher(ext, state, root));
  ext.place("project", { open: (root, params) => openPlace(ext, state, root, params ?? {}) });
  state.refresh();
}

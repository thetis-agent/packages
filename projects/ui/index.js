/* The browser module of @thetis/projects. The shell calls `install(ext)` once after the page has
 * mounted. It builds the page's project state, which is the shell's space provider, puts the switcher in
 * the sidebar's head slot and the project pill in the composer, and registers the settings place.
 * Nothing runs at import. */

import { mountPill } from "./pill.js";
import { openPlace } from "./place.js";
import { createState } from "./state.js";
import { mountSwitcher } from "./switcher.js";

export default function install(ext) {
  const state = createState(ext);
  ext.sidebar("head", (root) => mountSwitcher(ext, state, root));
  ext.composer("project", { mount: (root) => mountPill(ext, state, root) });
  ext.place("project", { open: (root, params) => openPlace(ext, state, root, params ?? {}) });
  state.refresh();
}

/* The browser module of @thetis/ui-marketplace. The shell calls `install(ext)` once after the page has
 * mounted and registers the one place the manifest declares. Opened with `{ name }` the place is that
 * extension's page; opened with nothing it is the store (Updates, Installed, Discover); opened with
 * `{ view: "updates" }` it is the store scrolled to its Updates section, which is where the card's Review
 * goes. A card in the store re-opens the place with the name, and the crumb on a page re-opens it without
 * one, so the shell's own place mechanism is the only navigation. Opened with `{ view: "registries" }` it
 * is the admins' Registries page, which the store's toolbar offers only where the person may send the verbs.
 *
 * `install` also starts the "Updates ready" card (updates-notice.js). This package is a default for everyone,
 * so every page has the card, whether or not the place is ever opened. Nothing runs at import. */

import { openGallery } from "./gallery.js";
import { openPage } from "./page.js";
import { openRegistries } from "./registries.js";
import { createUpdater, extDeps, setUpdater } from "./updates-notice.js";

export default function install(ext) {
  ext.place("marketplace", {
    open: (root, params) => {
      if (params?.view === "registries" && ext.can("registries")) return openRegistries(ext, root);
      return typeof params?.name === "string" && params.name ? openPage(ext, root, params) : openGallery(ext, root, params);
    },
  });
  if (ext.can("updates")) {
    const updater = createUpdater(extDeps(ext));
    setUpdater(updater);
    updater.start();
  }
}

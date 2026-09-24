/* The browser module of @thetis/ui-marketplace. The shell calls `install(ext)` once after the page has
 * mounted and registers the one place the manifest declares. Opened with `{ name }` the place is that
 * package's page; opened with nothing it is the gallery. A card in the gallery re-opens the place with
 * the name, and the crumb on a page re-opens it without one, so the shell's own place mechanism is the
 * only navigation. Opened with `{ view: "registries" }` it is the admins' Registries page, which the
 * gallery's toolbar offers only where the person may send the verbs. Nothing runs at import. */

import { openGallery } from "./gallery.js";
import { openPage } from "./page.js";
import { openRegistries } from "./registries.js";

export default function install(ext) {
  ext.place("marketplace", {
    open: (root, params) => {
      if (params?.view === "registries" && ext.can("registries")) return openRegistries(ext, root);
      return typeof params?.name === "string" && params.name ? openPage(ext, root, params) : openGallery(ext, root);
    },
  });
}

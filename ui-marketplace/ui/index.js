/* The browser module of @thetis/ui-marketplace. The shell calls `install(ext)` once after the page has
 * mounted and registers the one place the manifest declares. Opened with `{ name }` the place is that
 * extension's page; opened with nothing it is the store (Updates, Installed, Discover); opened with
 * `{ view: "updates" }` it is the store scrolled to its Updates section, which is where the card's Review
 * goes. A card in the store re-opens the place with the name, and the crumb on a page re-opens it without
 * one, so the shell's own place mechanism is the only navigation. Opened with `{ view: "registries" }` it
 * is the admins' Registries page, which the store's toolbar offers only where the person may send the verbs.
 *
 * The place stays open across a page reload: while it is open, what it shows is kept in this tab's
 * sessionStorage, taken away when it closes, and opened again when the page comes back -- after the page has
 * opened its conversation, which closes whatever place is open.
 *
 * `install` also starts the "Updates ready" card (updates-notice.js). This package is a default for everyone,
 * so every page has the card, whether or not the place is ever opened. Nothing runs at import. */

import { openGallery } from "./gallery.js";
import { openPage } from "./page.js";
import { openRegistries } from "./registries.js";
import { createUpdater, extDeps, setUpdater } from "./updates-notice.js";

const OPEN = "thetis.extensions.open";

/** This tab's sessionStorage, or null where a private window or blocked site data has none. */
function session() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** What the place shows, as it is kept: the extension, or the store's view, never the transient tab or anything else. */
const keep = (params) => JSON.stringify(typeof params?.name === "string" && params.name ? { name: params.name } : params?.view ? { view: params.view } : {});

function remember(params) {
  try {
    session()?.setItem(OPEN, keep(params));
  } catch {
    /* a convenience, not state */
  }
}

function forget() {
  try {
    session()?.removeItem(OPEN);
  } catch {
    /* a convenience, not state */
  }
}

/** What was open when the page went away, or null. */
function remembered() {
  try {
    const raw = session()?.getItem(OPEN);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Opens the place again after a reload. The page opens its conversation once its connection is up, and that
 * closes any place, so the place waits for the conversation (or a few seconds, on a page with none).
 */
function reopen(ext, params) {
  let done = false;
  let unwatch = null;
  const go = () => {
    if (done) return;
    done = true;
    unwatch?.();
    ext.open.place("marketplace", params);
  };
  if (ext.conversation?.current) return void setTimeout(go, 0);
  unwatch = typeof ext.conversation?.watch === "function" ? ext.conversation.watch((id) => id && setTimeout(go, 0)) : null;
  setTimeout(go, 4000);
}

export default function install(ext) {
  ext.place("marketplace", {
    open: (root, params) => {
      remember(params);
      let close;
      if (params?.view === "registries" && ext.can("registries")) close = openRegistries(ext, root);
      else close = typeof params?.name === "string" && params.name ? openPage(ext, root, params) : openGallery(ext, root, params);
      return () => {
        forget();
        if (typeof close === "function") close();
      };
    },
  });
  const again = remembered();
  if (again) reopen(ext, again);
  if (ext.can("updates")) {
    const updater = createUpdater(extDeps(ext));
    setUpdater(updater);
    updater.start();
  }
}

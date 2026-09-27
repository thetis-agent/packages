/* What Escape closes: the layer opened last. The page has several things that sit over or beside the
 * conversation — the dock, a place, the sidebar drawer on a narrow screen — and each used to listen for
 * Escape on its own, so one press could close the wrong one: on a phone, a place opened from the menu
 * under the drawer closed the place and left the drawer. Now each of them says when it opens and closes,
 * and one listener closes the top one. A floating menu, a picker's list and a popover are above all of
 * these; they handle their own Escape, and while one is open this stack is left alone.
 *
 * A place is never closed by Escape: it is somewhere a person went (the Extensions place, the Control
 * panel), and one Escape too many — after a menu or a confirm had already closed, or in the search box —
 * used to throw away the whole page they were reading. Its ✕ and the menu leave it. Escape closes what sits
 * over it (a menu, a popover, the drawer) and, with no place on top, the dock.
 *
 * Kept free of the DOM (the listener is `onEscape`) so it runs under `node:test`. */

/** The layers Escape never closes: somewhere a person went, left by its own ✕. */
export const KEPT = Object.freeze(["place"]);

export function createLayers({ kept = KEPT } = {}) {
  const stack = []; // [{ id, close }], bottom first

  const at = (id) => stack.findIndex((layer) => layer.id === id);

  return {
    /** `id` is open now and on top; `close()` is how Escape closes it. Opening an open id moves it to the top. */
    open(id, close) {
      const i = at(id);
      if (i >= 0) stack.splice(i, 1);
      stack.push({ id, close });
    },
    /** `id` closed by some other way (its ✕, a click): it leaves the stack. Unknown ids are ignored. */
    remove(id) {
      const i = at(id);
      if (i >= 0) stack.splice(i, 1);
    },
    /** The id Escape would close now, or null. */
    top: () => stack.at(-1)?.id ?? null,
    /** The open ids, bottom first. */
    list: () => stack.map((layer) => layer.id),
    /** Closes the top layer, unless it is one Escape never closes. Answers whether one closed. */
    escape() {
      const layer = stack.at(-1);
      if (!layer || kept.includes(layer.id)) return false;
      stack.pop();
      layer.close();
      return true;
    },
  };
}

/** The page's one stack. */
export const layers = createLayers();

/** Something that takes Escape for itself is open: a floating menu, a picker's list, a popover or dialog. */
const OWN_ESCAPE = ".popover, .menu, .picker-menu";

/**
 * The page's one Escape listener. Registered once by app.js before anything else listens, so a popover's
 * own listener, added later, still finds its node in place when this one looks.
 */
export function listenForEscape(doc = document, stack = layers) {
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    if (doc.querySelector(OWN_ESCAPE)) return;
    if (stack.escape()) event.preventDefault();
  });
}

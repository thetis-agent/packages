/* The shelf: the bottom dock under the conversation. It is the legacy terminal drawer's chrome made
 * generic — a grip to resize it, a head with the entry's label and the tenant's buttons, then collapse
 * and hide, and a body the package mounts into — so that a package which watches something while the
 * agent works (a terminal, a log) has a home that shortens the transcript rather than covering it.
 *
 * Deliberately *not* a rail tab. Every inspector is a rail tab because an inspector is something you
 * consult; a terminal is something you watch while the agent works, in parallel with reading the
 * transcript. The rail is one panel at a time, so putting it there would mean choosing between
 * watching the build and watching the branch graph.
 *
 * The shell owns the grip, the title, collapse, hide, the height, the animation and its persistence.
 * The package owns the body. A tenant stays mounted while the shelf is hidden, so reopening costs it
 * nothing; it is unmounted only when another entry takes the shelf. */

import { $, clear, setHidden } from "../lib/dom.js";
import * as registry from "../lib/registry.js";

// Height of the drawer, remembered across conversations and reloads. In
// localStorage rather than the store: it is a property of this screen, not of
// the conversation, and following you between conversations is the point.
const HEIGHT_KEY = "thetis.shelf.height";
const DEFAULT_H = 300;
const MIN_H = 140;
const maxH = () => Math.round(window.innerHeight * 0.72);
// The close animation's `transitionend` is what puts `hidden` back on; a scheme with motion switched
// off never fires one, so this backstop does the same a little later.
const HIDE_FALLBACK_MS = 400;

function storedHeight() {
  let raw = NaN;
  try {
    raw = Number(localStorage.getItem(HEIGHT_KEY));
  } catch {
    /* storage refused (a private window, a locked-down profile): the default height */
  }
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_H;
  return Math.min(Math.max(raw, MIN_H), maxH());
}

function rememberHeight(px) {
  try {
    localStorage.setItem(HEIGHT_KEY, String(Math.round(px)));
  } catch {
    /* not remembered; the next open uses the default */
  }
}

export function mountShelf() {
  const shelf = $("shelf");
  const grip = shelf.querySelector(".shelf-grip");
  const title = shelf.querySelector(".shelf-title");
  const actions = shelf.querySelector(".shelf-actions");
  const collapseBtn = shelf.querySelector(".shelf-collapse");
  const hideBtn = shelf.querySelector(".shelf-close");
  const body = shelf.querySelector(".shelf-body");
  let tenant = null; // { key, unmount, nodes: Node[], fits: Set<fn> }
  /* Anything that reads "is it open?" reads `openState`, not the `hidden` attribute: the element must
   * stay in the layout while its height animates, so the attribute lags the state at both ends. */
  let openState = false;
  let collapsed = false;
  let hideTimer = null;

  // The height is set through the CSSOM, never as an inline style attribute, which the page's policy refuses.
  const setHeight = (px) => shelf.style.setProperty("height", px === null ? "" : `${px}px`);

  hideBtn.addEventListener("click", () => setOpen(false));
  collapseBtn.addEventListener("click", () => setCollapsed(!collapsed));
  grip.addEventListener("pointerdown", beginDrag);

  /* `hidden` goes back on only once the closing animation has finished — set
   * during the transition it would snap the drawer out of the layout instead of
   * letting the transcript grow back into the space. */
  shelf.addEventListener("transitionend", (event) => {
    if (event.target !== shelf || event.propertyName !== "height") return;
    settle();
  });

  function settle() {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!openState) setHidden(shelf, true);
    fit();
  }

  /* Open and close animate the drawer's height, which means the element must stay
   * in the layout while it moves — so `hidden` goes on only once the transition
   * has finished, and comes off a frame before it starts. */
  function setOpen(open) {
    if (open === openState) return;
    openState = open;
    clearTimeout(hideTimer);
    if (open) {
      setHidden(shelf, false);
      setHeight(0);
      // Two frames: one for `hidden` to stop suppressing layout, one for the
      // browser to have a starting height to animate from. Collapsing these into
      // one makes the drawer appear at full height with no motion.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!openState) return;
          shelf.classList.add("is-open");
          setHeight(collapsed ? null : storedHeight());
          if (collapsed) fit();
        })
      );
    } else {
      shelf.classList.remove("is-open");
      setHeight(0);
      hideTimer = setTimeout(settle, HIDE_FALLBACK_MS);
    }
  }

  function setCollapsed(next) {
    collapsed = next;
    shelf.classList.toggle("is-collapsed", collapsed);
    collapseBtn.title = collapsed ? "Expand" : "Collapse to the title strip";
    collapseBtn.setAttribute("aria-label", collapsed ? "Expand the shelf" : "Collapse the shelf");
    setHeight(collapsed ? null : storedHeight());
    fit();
  }

  function beginDrag(event) {
    if (collapsed || !openState) return;
    event.preventDefault();
    const startY = event.clientY;
    const startH = shelf.getBoundingClientRect().height;
    shelf.classList.add("is-dragging");
    const move = (e) => {
      const next = Math.min(Math.max(startH + (startY - e.clientY), MIN_H), maxH());
      setHeight(next);
    };
    const done = () => {
      shelf.classList.remove("is-dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      rememberHeight(shelf.getBoundingClientRect().height);
      fit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
  }

  /** What the tenant asked to be told after a drag, a collapse, the open animation, or a close. */
  function fit() {
    if (!tenant) return;
    for (const fn of tenant.fits) {
      try {
        fn();
      } catch (err) {
        console.error("a shelf entry threw while fitting:", err);
      }
    }
  }

  function mount(entry) {
    unmount();
    const nodes = [];
    const fits = new Set();
    const handle = Object.freeze({
      /** The tenant's buttons, placed before collapse and hide. */
      actions(...list) {
        for (const node of list.flat()) {
          if (!(node instanceof Node)) continue;
          nodes.push(node);
          actions.insertBefore(node, collapseBtn);
        }
      },
      fit(fn) {
        if (typeof fn === "function") fits.add(fn);
        return () => fits.delete(fn);
      },
    });
    title.textContent = entry.decl.label || entry.id;
    shelf.setAttribute("aria-label", entry.decl.label || entry.id);
    clear(body);
    let out = { ok: false };
    if (!entry.impl?.mount) body.append(registry.failureOf(entry.package) ? registry.broken(entry.package) : "");
    else {
      out = registry.guard(entry.package, "shelf", entry.impl.mount, body, handle);
      if (!out.ok) body.append(registry.broken(entry.package));
    }
    tenant = { key: entry.key, unmount: out.ok && typeof out.value === "function" ? out.value : null, nodes, fits };
  }

  function unmount() {
    if (!tenant) return;
    try {
      tenant.unmount?.();
    } catch (err) {
      console.error("a shelf entry threw while closing:", err);
    }
    for (const node of tenant.nodes) node.remove();
    tenant = null;
    clear(body);
  }

  function show(key) {
    const entry = registry.entry("shelf", key);
    if (!entry) return;
    if (tenant?.key !== key) mount(entry);
    setOpen(true);
    if (collapsed) setCollapsed(false);
  }

  function close() {
    setOpen(false);
  }

  return { open: show, close, isOpen: () => openState, current: () => tenant?.key ?? null };
}

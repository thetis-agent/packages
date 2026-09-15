/* The shelf: the bottom dock under the conversation, the terminal's home in the canvas. Hidden until a
 * shelf registration is opened; then a grip to resize it, a header with the entry's label and a ✕, and
 * a body the package mounts into. The shell owns the grip and the close; the package owns the body. */

import { $, clear, setHidden } from "../lib/dom.js";
import * as registry from "../lib/registry.js";

const MIN_H = 120;

export function mountShelf() {
  const shelf = $("shelf");
  const grip = shelf.querySelector(".shelf-grip");
  const title = shelf.querySelector(".shelf-title");
  const body = shelf.querySelector(".shelf-body");
  let open = null; // { key, unmount }

  shelf.querySelector(".shelf-close").addEventListener("click", () => close());

  grip.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    const startY = down.clientY;
    const startH = shelf.getBoundingClientRect().height;
    const move = (e) => {
      const h = Math.max(MIN_H, Math.min(window.innerHeight * 0.7, startH + (startY - e.clientY)));
      shelf.style.setProperty("--shelf-h", `${Math.round(h)}px`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  function show(key) {
    const entry = registry.entry("shelf", key);
    if (!entry) return;
    if (open) close();
    title.textContent = entry.decl.label || entry.id;
    clear(body);
    let unmount = null;
    if (!entry.impl?.mount) body.append(registry.failureOf(entry.package) ? registry.broken(entry.package) : "");
    else {
      const out = registry.guard(entry.package, "shelf", entry.impl.mount, body);
      if (!out.ok) body.append(registry.broken(entry.package));
      else if (typeof out.value === "function") unmount = out.value;
    }
    open = { key, unmount };
    setHidden(shelf, false);
  }

  function close() {
    if (!open) return;
    try {
      open.unmount?.();
    } catch (err) {
      console.error("a shelf entry threw while closing:", err);
    }
    open = null;
    clear(body);
    setHidden(shelf, true);
  }

  return { open: show, close, current: () => open?.key ?? null };
}

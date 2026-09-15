/* Places: the surfaces that are not a conversation. A place takes over the main, rail and dock region
 * with the sidebar kept, has a header (title and subtitle from its declaration, a ✕) and a body the
 * registering package draws. Escape closes it unless a popover is open, and closing returns to the
 * tabs exactly as they were, because the panes were only hidden. The control panel is the first place;
 * a package's page and the marketplace are places too. The links in the sidebar footer are drawn from
 * the registry's `places` slot, so they exist before the package's module has loaded. */

import { $, clear, el, icon, setHidden } from "../lib/dom.js";
import * as registry from "../lib/registry.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];

export function mountPlaces() {
  const app = $("app");
  const node = $("place");
  const links = $("sidebar-places");
  const title = node.querySelector(".place-title");
  const sub = node.querySelector(".place-sub");
  const body = node.querySelector(".place-body");
  let open = null; // { key, unmount }

  node.querySelector(".place-close").addEventListener("click", () => close());

  function onKey(e) {
    if (e.key === "Escape" && !document.querySelector(".popover")) close();
  }

  function drawLinks() {
    clear(links);
    for (const entry of registry.entries("places")) {
      const failed = registry.failureOf(entry.package);
      const label = entry.decl.label || entry.id;
      links.append(
        el(
          "button",
          { type: "button", class: `quiet-link foot-action${failed ? " is-broken" : ""}${open?.key === entry.key ? " is-active" : ""}`, "data-place": entry.key, title: failed ? `${entry.package} could not load` : entry.decl.hint || label, onClick: () => show(entry.key) },
          entry.decl.icon ? icon(entry.decl.icon, { size: 14 }) : null,
          label
        )
      );
    }
  }

  function show(key, params = {}) {
    const entry = registry.entry("places", key);
    if (!entry) return;
    if (open) close();
    title.textContent = entry.decl.label || entry.id;
    sub.textContent = entry.decl.hint || "";
    clear(body);
    let unmount = null;
    if (!entry.impl?.open) {
      body.append(registry.failureOf(entry.package) ? registry.broken(entry.package) : el("div", { class: "panel-empty" }, "Loading…"));
    } else {
      const out = registry.guard(entry.package, "places", entry.impl.open, body, params);
      if (!out.ok) body.append(registry.broken(entry.package));
      else if (typeof out.value === "function") unmount = out.value;
    }
    open = { key, unmount };
    app.classList.add("is-place");
    setHidden(node, false);
    document.addEventListener("keydown", onKey);
    drawLinks();
  }

  function close() {
    if (!open) return;
    try {
      open.unmount?.();
    } catch (err) {
      console.error("a place threw while closing:", err);
    }
    open = null;
    clear(body);
    app.classList.remove("is-place");
    setHidden(node, true);
    document.removeEventListener("keydown", onKey);
    drawLinks();
  }

  registry.watch((change) => {
    if (change.kind === "declare" || change.kind === "fail") drawLinks();
    // The module registered after the place was opened on its static entry: draw it now.
    if (change.kind === "register" && change.slot === "places" && open?.key === registry.keyOf(change.package, change.id)) show(open.key);
  });
  drawLinks();

  return { open: show, close, current: () => open?.key ?? null };
}

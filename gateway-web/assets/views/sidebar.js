/* The sidebar's slots for packages. Two hosts: the head strip under the brand, where a package mounts one
 * thing (the project switcher), and the sections between it and the conversations, where a package mounts
 * a list of its own (the canvases). A section's chrome is the shell's — a heading that folds, remembered
 * per section, a count and a strip for the package's own actions — and its body is the package's, mounted
 * once with `mount(body, { setCount, setActions, expand })`. Each registered entry is mounted once, in
 * declared order; a package that fails to load leaves a named gap; a throwing mount shows the broken note.
 * The skeleton draws nothing here. */

import { $, el, icon, setHidden } from "../lib/dom.js";
import * as registry from "../lib/registry.js";

const CARET = "M6 8l4 4 4-4";

function remembered(key) {
  try {
    return localStorage.getItem(`thetis.sidebar.section:${key}`) !== "0";
  } catch {
    return true;
  }
}

function remember(key, open) {
  try {
    if (open) localStorage.removeItem(`thetis.sidebar.section:${key}`);
    else localStorage.setItem(`thetis.sidebar.section:${key}`, "0");
  } catch {
    /* no storage: the fold lasts the page */
  }
}

export function mountSidebarSlot() {
  const head = $("sidebar-head");
  const sections = $("sidebar-sections");
  const mounted = new Map(); // key -> { node, unmount }

  /** A section's chrome: the folding heading, the count, the actions strip, and the body handed to the package. */
  function section(entry) {
    const label = el("span", { class: "sidebar-section-label" }, entry.decl.label || entry.id);
    const count = el("span", { class: "sidebar-section-count" });
    const actions = el("span", { class: "sidebar-section-actions", onClick: (event) => event.stopPropagation() });
    const body = el("div", { class: "sidebar-section-body", role: "region" });
    const toggle = el("button", { type: "button", class: "sidebar-section-head", onClick: () => expand() }, icon(CARET, { size: 10, width: 2 }), label, count);
    const node = el("section", { class: "sidebar-section", "data-item": entry.key }, el("div", { class: "sidebar-section-bar" }, toggle, actions), body);
    let open = remembered(entry.key);
    function expand(to = !open) {
      open = Boolean(to);
      remember(entry.key, open);
      node.classList.toggle("is-collapsed", !open);
      toggle.setAttribute("aria-expanded", String(open));
      setHidden(body, !open);
    }
    expand(open);
    const tools = {
      setCount: (n) => { count.textContent = n === null || n === undefined ? "" : String(n); },
      setActions: (...nodes) => { actions.replaceChildren(...nodes.filter(Boolean)); },
      expand,
    };
    return { node, body, tools };
  }

  function draw() {
    for (const entry of registry.entries("sidebar")) {
      if (mounted.has(entry.key)) continue;
      const failed = registry.failureOf(entry.package);
      if (!failed && !entry.impl?.mount) continue; // declared, not yet registered: wait for the module
      const isSection = entry.decl.slot === "section";
      const made = isSection ? section(entry) : null;
      const node = made ? made.node : el("div", { class: "sidebar-slot-item", "data-item": entry.key });
      const body = made ? made.body : node;
      let unmount = null;
      if (failed) {
        node.classList.add("is-broken");
        node.title = `The ${entry.package} extension could not load`;
      } else {
        const out = registry.guard(entry.package, "sidebar", entry.impl.mount, body, made?.tools);
        if (!out.ok) body.replaceChildren(registry.broken(entry.package));
        else unmount = typeof out.value === "function" ? out.value : null;
      }
      mounted.set(entry.key, { node, unmount });
      (isSection ? sections : head).append(node);
    }
    // In declared order, whatever order the modules registered in: each host's nodes are put back in place.
    for (const host of [head, sections]) {
      for (const entry of registry.entries("sidebar")) {
        const node = mounted.get(entry.key)?.node;
        if (node && node.parentElement === host) {
          node.remove();
          host.append(node);
        }
      }
    }
  }

  registry.watch((change) => {
    if (change.kind === "fail" || (change.kind === "register" && change.slot === "sidebar")) draw();
  });
  draw();
  return { draw };
}

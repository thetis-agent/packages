/* The sidebar head slot: the strip under the brand where a package mounts one thing (the project
 * switcher). Each registered `sidebar` entry gets its own node and is mounted once; a package that fails
 * to load leaves a named gap; a throwing mount shows the broken note. The skeleton draws nothing here. */

import { $, el } from "../lib/dom.js";
import * as registry from "../lib/registry.js";

export function mountSidebarSlot() {
  const root = $("sidebar-head");
  const mounted = new Map(); // key -> { node, unmount }

  function draw() {
    for (const entry of registry.entries("sidebar")) {
      if (entry.id !== "head" || mounted.has(entry.key)) continue;
      const node = el("div", { class: "sidebar-slot-item", "data-item": entry.key });
      const failed = registry.failureOf(entry.package);
      if (failed) {
        node.classList.add("is-broken");
        node.title = `${entry.package} could not load`;
      } else if (entry.impl?.mount) {
        const out = registry.guard(entry.package, "sidebar", entry.impl.mount, node);
        if (!out.ok) node.replaceChildren(registry.broken(entry.package));
        else mounted.set(entry.key, { node, unmount: typeof out.value === "function" ? out.value : null });
      } else continue; // declared, not yet registered: wait for the module
      root.append(node);
    }
  }

  registry.watch((change) => {
    if (change.kind === "fail" || (change.kind === "register" && change.slot === "sidebar")) draw();
  });
  draw();
  return { draw };
}

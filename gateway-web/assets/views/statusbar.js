/* The status bar: a 26px row under everything, drawn only when a package has declared an entry. Each
 * entry is one node the package fills through `draw(node)`; entries sit left to right by `order`.
 * The skeleton contributes nothing of its own. */

import { $, clear, el, setHidden } from "../lib/dom.js";
import * as registry from "../lib/registry.js";

export function mountStatusbar() {
  const bar = $("statusbar");

  function draw() {
    clear(bar);
    const list = registry.entries("statusbar");
    setHidden(bar, !list.length);
    for (const entry of list) {
      const node = el("span", { class: "statusbar-item", "data-item": entry.key });
      const failed = registry.failureOf(entry.package);
      if (failed) {
        node.classList.add("is-broken");
        node.title = `${entry.package} could not load`;
        node.textContent = entry.decl.label || entry.id;
      } else if (entry.impl?.draw) {
        const out = registry.guard(entry.package, "statusbar", entry.impl.draw, node);
        if (!out.ok) node.replaceChildren(registry.broken(entry.package));
      }
      bar.append(node);
    }
  }

  registry.watch((change) => {
    if (change.kind === "declare" || change.kind === "fail" || change.kind === "redraw" || (change.kind === "register" && change.slot === "statusbar")) draw();
  });
  draw();
  return { draw };
}

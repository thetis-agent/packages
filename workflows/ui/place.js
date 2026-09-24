/* The Workflows place: one state machine over three views (library, editor, run), with no URL of its
 * own. It owns what the views share for as long as the place is open: the service client, the one `watch`
 * feed, and the catalog (models, projects, tools), asked once and asked again only after a failure. A view
 * is a function `(host, ctx, params) => unmount`; switching views unmounts the old one first, and closing
 * the place unmounts the view and stops the feed. */

import { openEditor } from "./editor.js";
import { openLibrary } from "./library.js";
import { openRun } from "./run-view.js";
import { createService } from "./service.js";

export function openPlace(ext, root, params) {
  const { el, clear } = ext.dom;
  const svc = createService(ext);
  const feed = svc.createFeed();
  let unmount = null;
  let catalog = null;
  let alive = true;

  const ctx = {
    ext,
    call: svc.call,
    feed,
    /** The catalog, asked once per open place; a failure is not remembered, so the next ask tries again. */
    catalog() {
      if (!catalog) {
        catalog = svc.call("catalog").then(
          (c) => ({ models: c?.models ?? [], defaultModel: c?.defaultModel ?? "", projects: c?.projects ?? [], tools: c?.tools ?? [] }),
          (err) => {
            catalog = null;
            throw err;
          }
        );
      }
      return catalog;
    },
    go: {
      library: () => show(openLibrary, {}),
      editor: (id) => show(openEditor, { id }),
      run: (id) => show(openRun, { id }),
    },
  };

  function show(view, viewParams) {
    if (!alive) return;
    try {
      unmount?.();
    } catch (err) {
      console.error("workflows: a view threw while closing", err);
    }
    unmount = null;
    clear(root);
    const host = el("div", { class: "wf-root" });
    root.append(host);
    const out = view(host, ctx, viewParams);
    unmount = typeof out === "function" ? out : null;
  }

  feed.start();
  if (typeof params.run === "string" && params.run) ctx.go.run(params.run);
  else if (typeof params.workflow === "string" && params.workflow) ctx.go.editor(params.workflow);
  else ctx.go.library();

  return () => {
    alive = false;
    try {
      unmount?.();
    } finally {
      feed.close();
    }
  };
}

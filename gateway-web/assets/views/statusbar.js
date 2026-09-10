/* The status bar along the foot of the page.
 *
 * The legacy status bar polled the host every ten seconds with a
 * `system-status` frame and drew trunk position, the served UI's own build,
 * the worker fleet and machine load from the reply. This wire has no
 * `system-status` — no outbound send by that name, no inbound frame either
 * (wire.ts's outbound list is exactly hello/list/new/open/send/turn-cancel/
 * env-reset) — so there is nothing to poll. What is left is the one piece of
 * systemic state the wire does push unprompted: `env-status`, already held in
 * `store.env` for views/environment.js. This bar is just a quieter echo of it,
 * visible without opening the rail.
 */

import { $, clear, el } from "../lib/dom.js";
import { store } from "../lib/store.js";

export function mountStatusbar() {
  const bar = $("statusbar");
  draw(bar);
  store.watch("env", () => draw(bar));
}

function draw(bar) {
  const env = store.env;
  clear(bar);
  if (!env) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.append(
    el("span", { class: `statusbar-dot is-${env.ready ? "ok" : "bad"}` }),
    el("span", { class: "statusbar-text" }, `${env.target || "environment"} — ${env.state || (env.ready ? "ready" : "not ready")}`)
  );
}

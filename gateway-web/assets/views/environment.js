/* The rail's one inspector: the environment the open conversation runs in.
 *
 * Shows `env-status` as last received — how often it has been rebuilt, whether it is ready, the
 * kernel's own state word — and a "Start fresh" button that sends
 * `env-reset`. `hello` advertises the `env-reset` capability unconditionally
 * (wire.ts's capability list is not filtered by what the kernel actually
 * negotiated), so the button is always offered; a kernel that has not
 * negotiated `env.reset` refuses the send with an `unsupported` error, which
 * app.js surfaces as an ordinary toast rather than something this view needs
 * to predict.
 *
 * An unready environment shows the kernel's own `reason` verbatim, in a
 * warning banner — never reworded, because a reason this view paraphrased
 * could disagree with what actually went wrong.
 */

import { el } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { popover } from "../lib/toast.js";
import { section } from "./panel.js";
import * as rail from "./rail.js";

const ID = "environment";

export function mountEnvironment({ sendFrame }) {
  store.watch("env", () => {
    if (rail.isOpen(ID)) draw();
  });

  // Tearing down and rebuilding the environment loses whatever state was
  // live inside it, so it gets the same anchored two-step every other
  // destructive control here uses, rather than firing on the first click.
  function confirmReset(event) {
    popover(event.currentTarget, {
      message: "Start this workspace fresh?",
      detail: "Throws away everything in this conversation's workspace and builds it again. Anything running there now stops.",
      confirmLabel: "Start fresh",
      danger: true,
      onConfirm: () => sendFrame({ type: "env-reset" }),
    });
  }

  function draw() {
    const env = store.env;
    if (!env) {
      rail.open({ id: ID, title: "Environment", items: [], empty: "No environment status yet." });
      return;
    }

    const blocks = [];
    if (!env.ready && env.reason) {
      blocks.push(el("div", { class: "panel-warning" }, env.reason));
    }
    /* The count is how many times this environment has been rebuilt, which is a true and useful
     * thing to know and reads as nothing at all when it is called a generation number. It is left
     * out entirely rather than printed as a question mark when the host did not say. */
    blocks.push(
      section({
        title: env.state || (env.ready ? "Ready" : "Not ready"),
        ...(typeof env.generation === "number" && env.generation > 1 ? { note: `Rebuilt ${String(env.generation - 1)} time${env.generation === 2 ? "" : "s"}` } : {}),
      })
    );
    blocks.push(
      el(
        "button",
        { type: "button", class: "ghost-btn", title: "Throw this conversation's workspace away and start it fresh", onClick: confirmReset },
        "Start fresh"
      )
    );

    rail.open({ id: ID, title: "Environment", subtitle: env.target, blocks });
  }

  return { id: ID, label: "Environment", hint: "The environment this conversation runs in", icon: rail.ICONS.environment, activate: draw };
}

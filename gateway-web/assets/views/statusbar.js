/* The system resources bar: one line across the foot of the whole page.
 *
 * Everything on it answers a question nobody should have to open a panel for — is anything
 * running, is the environment my conversations live in healthy, how much room is left on the
 * machine, and what version of Thetis am I looking at. The wording is deliberately ordinary: this
 * bar is on screen all the time, including for people who will never read a design document, and
 * the vocabulary the system uses for itself stops at lib/status.js.
 *
 * It is derived state with no event of its own, so it declares its own invalidation. The host
 * pushes `env-status` when a conversation opens or the environment is reset; everything else this
 * bar shows comes from asking. A poll from here rather than a push from the host is the cheaper
 * shape by a good margin: it runs only while the tab is actually on screen, it stops dead when the
 * tab is hidden, and the host coalesces the one part of the answer that costs a kernel call
 * (wire.ts's `#status`). A pushed frame would tick against every open socket whether or not anyone
 * was looking at it.
 *
 * Nothing here draws a placeholder. Each item is built from its own datum and simply absent when
 * the host did not send one — a deployment may withhold environment status entirely, a platform
 * may have no load average, and no version of this bar should imply a measurement it did not take.
 */

import { $, clear, el, icon, setHidden } from "../lib/dom.js";
import { store } from "../lib/store.js";
import {
  LOG_ROWS, POLL_MS, canShowLogs, describeAgent, describeCounts, describeEnv, describeLoad,
  describeLogs, describeMemory, describeOverall, describeSetup,
} from "../lib/status.js";

const LIST = ["M4 5.5h12", "M4 10h12", "M4 14.5h8"];
const X = ["M5 5l10 10", "M15 5l-10 10"];

export function mountStatusbar({ sendFrame }) {
  const bar = $("statusbar");
  let timer = null;
  let panel = null;

  const refresh = () => sendFrame({ type: "status" });

  function start() {
    stop();
    timer = setInterval(refresh, POLL_MS);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // --- recent activity ---------------------------------------------------------

  /* The log panel is built on open and thrown away on close rather than kept hidden, so a bar that
   * is never asked for output carries no list, no listeners and no stale rows. `store.logs` is
   * cleared with it for the same reason: the next opening should show what the environment is
   * doing now, not what it was doing an hour ago. */
  function closeLogs() {
    if (!panel) return;
    panel.dispose();
    panel = null;
    store.set({ logs: null });
    drawBar();
  }

  function openLogs() {
    if (panel) {
      closeLogs();
      return;
    }
    const body = el("div", { class: "log-body" });
    const note = el("span", { class: "log-note" });
    const node = el(
      "section",
      { class: "log-panel", role: "dialog", "aria-label": "Recent environment activity" },
      el(
        "header",
        { class: "log-head" },
        el("span", { class: "log-title" }, "Recent activity"),
        note,
        el(
          "button",
          { type: "button", class: "icon-btn sm", title: "Close", "aria-label": "Close", onClick: () => closeLogs() },
          icon(X, { size: 11, width: 1.9 })
        )
      ),
      body
    );

    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeLogs();
    };
    const onClick = (event) => {
      if (!node.contains(event.target) && !bar.contains(event.target)) closeLogs();
    };
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => document.addEventListener("click", onClick, true), 0);
    document.body.append(node);

    panel = {
      body,
      note,
      dispose() {
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("click", onClick, true);
        node.remove();
      },
    };
    drawLogs();
    drawBar();
    sendFrame({ type: "env-logs", limit: LOG_ROWS });
  }

  /* Rows are appended verbatim and the newest is scrolled to, because a log is read from its end.
   * The host already bounded what arrives (wire.ts caps the ask, the kernel caps the answer by
   * rows and by bytes), so this can render everything it was given without a second budget of its
   * own — but it renders it into a fixed-height scroller, never into the page. */
  function drawLogs() {
    if (!panel) return;
    const { note, rows } = describeLogs(store.logs);
    panel.note.textContent = note;
    clear(panel.body);
    for (const row of rows) {
      panel.body.append(
        el(
          "div",
          { class: "log-row" },
          el("span", { class: "log-at" }, row.at),
          el("span", { class: "log-kind" }, row.kind),
          el("span", { class: "log-detail" }, row.detail)
        )
      );
    }
    panel.body.scrollTop = panel.body.scrollHeight;
  }

  // --- the bar itself ----------------------------------------------------------

  function drawBar() {
    const env = store.env;
    const system = store.system;
    // Both counts, because they know different things: this client sees only the conversations it
    // has open and sees them the instant a turn starts, while the host counts every conversation on
    // the connection but only as of the last poll. The larger is the true one either way.
    const overall = describeOverall(env, Math.max(store.busyIds.size, system?.turns ?? 0));
    const items = [
      el(
        "span",
        { class: "sb-item", title: overall.title },
        el("span", { class: `sb-dot${overall.tone ? ` is-${overall.tone}` : ""}` }),
        el("span", { class: "sb-strong" }, overall.word)
      ),
      setupItem(system),
      environmentItem(env),
      conversationsItem(system),
      meterItem("mem", describeMemory(system?.host), "sb-drop-2"),
      meterItem("load", describeLoad(system?.host), "sb-drop-3"),
      logsItem(env),
      agentItem(system),
    ];
    clear(bar).append(...items.filter(Boolean));
    bar.hidden = false;
  }

  function setupItem(system) {
    const setup = describeSetup(system);
    if (!setup) return null;
    return el(
      "span",
      { class: "sb-item", title: `The version of the setup this deployment runs: ${setup}.` },
      el("span", { class: "sb-label" }, "setup"),
      el("span", { class: "sb-mono" }, setup)
    );
  }

  function environmentItem(env) {
    const shown = describeEnv(env);
    if (!shown) return null;
    return el(
      "span",
      { class: "sb-item sb-drop-1", title: shown.title },
      el("span", { class: "sb-label" }, "environment"),
      // An unnamed environment draws no name rather than repeating the label beside itself.
      shown.name ? el("span", { class: `sb-mono${shown.tone === "err" ? " is-err" : ""}` }, shown.name) : null,
      el("span", { class: `sb-flag${shown.tone ? ` is-${shown.tone}` : ""}` }, shown.word)
    );
  }

  function conversationsItem(system) {
    const counts = describeCounts(system);
    if (!counts) return null;
    return el(
      "span",
      { class: "sb-item sb-drop-1", title: counts.title },
      el("span", { class: "sb-label" }, counts.label),
      el("span", { class: "sb-mono" }, counts.open),
      counts.busy && el("span", { class: "sb-flag is-warn" }, counts.busy)
    );
  }

  /* Memory and load are the same shape — a label, a proportion, a number — so they share a
   * builder. The meter's width is set through CSSOM rather than a `style=` attribute, which the
   * page's content security policy would drop without saying so. */
  function meterItem(label, shown, drop) {
    if (!shown) return null;
    const fill = el("span", { class: `sb-meter-fill${shown.tone ? ` is-${shown.tone}` : ""}` });
    fill.style.setProperty("width", `${shown.percent}%`);
    return el(
      "span",
      { class: `sb-item ${drop}`, title: shown.title },
      el("span", { class: "sb-label" }, label),
      el("span", { class: "sb-meter" }, fill),
      el("span", { class: `sb-mono${shown.tone ? ` is-${shown.tone}` : ""}` }, shown.text)
    );
  }

  function logsItem(env) {
    if (!canShowLogs(env)) return null;
    const button = el(
      "button",
      {
        type: "button",
        class: `sb-button${panel ? " is-on" : ""}`,
        title: "Show what this environment has been doing",
        "aria-expanded": panel ? "true" : "false",
        onClick: () => openLogs(),
      },
      icon(LIST, { size: 12, width: 1.8 }),
      el("span", {}, "Recent activity")
    );
    // Both this and the version carry `sb-right`; flexbox gives the free space to the first of
    // them, so the version slides into place on its own when this one is dropped or absent.
    return el("span", { class: "sb-item sb-right sb-drop-2" }, button);
  }

  function agentItem(system) {
    const agent = describeAgent(system);
    if (!agent) return null;
    return el(
      "span",
      { class: "sb-item sb-right", title: `This page is served by Thetis ${agent}.` },
      el("span", { class: "sb-label" }, "Thetis"),
      el("span", { class: "sb-mono" }, agent)
    );
  }

  store.watch("env", drawBar);
  store.watch("system", drawBar);
  store.watch("busyIds", drawBar);
  store.watch("logs", drawLogs);

  /* A hidden tab is told nothing and asks for nothing: the poll is the only recurring cost this
   * page has, and a background tab should not pay it. Coming back asks immediately rather than
   * waiting out the interval, so the bar is right by the time the window has finished painting. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
      return;
    }
    refresh();
    start();
  });
  if (!document.hidden) start();

  setHidden(bar, false);
  drawBar();
  return { refresh };
}

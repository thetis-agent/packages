/* The control panel: one screen for everything about this place that is not a conversation.
 *
 * Left nav, content pane, and one rule that decides what is in the nav at all — the panel draws what
 * this deployment says it can answer and nothing else (admin.ts's `sections`). A section with nothing
 * behind it is left out, not shown empty and not shown greyed: an operator surface that offers a
 * control which always refuses teaches people to distrust the ones that work. Which sections are real
 * is therefore a property of the deployment rather than of this build, and the same page is honest in
 * a small one and a large one.
 *
 * The panel takes over the middle of the window rather than floating over it, because it is somewhere
 * you go and read rather than a dialog you dismiss — the conversations are still there behind it and
 * closing puts them straight back. It builds its own markup and injects its own way in, so that
 * adding it costs the shared page almost nothing.
 *
 * While a change is being applied the content pane shows that change instead of whatever section was
 * open. There is one thing happening to this environment and it is the thing worth watching; leaving a
 * settings list on screen beside it would be inviting someone to start a second one.
 */

import { $, clear, el, icon, setHidden } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { NOT_STARTED, activityLines, advance, inFlight, visibleSections } from "../lib/operator.js";
import { renderPackages } from "./packages.js";
import { confirmChange, renderChange } from "./installing.js";

const X = ["M5 5l10 10", "M15 5l-10 10"];
const GEAR = [
  "M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z",
  "M16.2 10a6.2 6.2 0 0 0-.1-1.1l1.4-1.1-1.5-2.6-1.7.6a6.2 6.2 0 0 0-1.9-1.1L11.9 3H8.1l-.5 1.7a6.2 6.2 0 0 0-1.9 1.1l-1.7-.6L2.5 7.8l1.4 1.1a6.2 6.2 0 0 0 0 2.2l-1.4 1.1 1.5 2.6 1.7-.6a6.2 6.2 0 0 0 1.9 1.1l.5 1.7h3.8l.5-1.7a6.2 6.2 0 0 0 1.9-1.1l1.7.6 1.5-2.6-1.4-1.1c.07-.36.1-.73.1-1.1Z",
];

/** How often to ask how a change is getting on. Short enough that each step is seen, long enough that
 *  a change nobody is watching costs nothing: the panel only asks while one is actually in flight. */
const WATCH_MS = 900;

export function mountAdmin({ sendFrame }) {
  const state = {
    open: false, role: "user", sections: [], current: null,
    setup: { packages: [] }, env: null, activity: [], filter: "", selected: null,
    progress: NOT_STARTED, watching: null,
  };

  let panel = null;
  let nav = null;
  let main = null;
  let subtitle = null;

  function build() {
    if (panel) return;
    nav = el("nav", { class: "admin-nav", "aria-label": "Control panel" });
    main = el("div", { class: "admin-main" });
    subtitle = el("p", { class: "admin-head-sub" });
    panel = el(
      "section",
      { class: "admin-panel", hidden: true },
      el(
        "header",
        { class: "admin-head" },
        el("div", {}, el("h1", { class: "admin-head-title" }, "Control panel"), subtitle),
        el("span", { class: "admin-head-gap" }),
        el(
          "button",
          { type: "button", class: "icon-btn sm", title: "Close (Esc)", "aria-label": "Close the control panel", onClick: () => close() },
          icon(X, { size: 14, width: 1.8 })
        )
      ),
      el("div", { class: "admin-shell" }, nav, main)
    );
    $("app").append(panel);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) close();
    });
  }

  /* The way in sits with the other things about you rather than in the conversation chrome: signing
   * out and looking at how this place is set up belong to the same corner of the page. Injected here
   * instead of written into index.html so that the whole panel is one import and one call. */
  function launcher() {
    const actions = document.querySelector(".foot-actions");
    if (!actions) return;
    actions.prepend(
      el(
        "button",
        { type: "button", class: "quiet-link foot-action", title: "How this place is set up", onClick: () => open() },
        icon(GEAR, { size: 14, width: 1.5 }),
        el("span", {}, "Control panel")
      )
    );
  }

  function open() {
    build();
    state.open = true;
    setHidden(panel, false);
    $("app").classList.add("is-admin");
    sendFrame({ type: "admin.open" });
    draw();
  }

  function close() {
    state.open = false;
    stopWatching();
    setHidden(panel, true);
    $("app").classList.remove("is-admin");
  }

  /** Asks for whatever the section on screen reads from. Every section is one request, so switching
   *  is cheap and a section nobody opened is never fetched. */
  function load(id) {
    if (["packages", "models", "modes", "limits", "spaces"].includes(id)) sendFrame({ type: "admin.setup" });
    if (id === "environments" || id === "undo") sendFrame({ type: "admin.environment" });
    if (id === "activity") sendFrame({ type: "admin.activity", from: 0 });
  }

  function show(id) {
    state.current = id;
    load(id);
    draw();
  }

  /* Asking repeatedly only while something is happening. The connection itself goes down during the
   * last step of a shared change — the thing serving this page is part of what switches over — so the
   * timer is restarted from each answer rather than run on its own: a reconnect resumes the watch
   * where it left off, and a page nobody is looking at stops asking. */
  function watch() {
    stopWatching();
    if (!state.open || !inFlight(state.progress)) return;
    state.watching = setTimeout(() => {
      state.watching = null;
      sendFrame({ type: "admin.environment" });
    }, WATCH_MS);
  }

  function stopWatching() {
    if (state.watching) clearTimeout(state.watching);
    state.watching = null;
  }

  function draw() {
    if (!state.open || !panel) return;
    const open = visibleSections(state.sections);
    if (!open.some((entry) => entry.id === state.current)) state.current = open[0] ? open[0].id : null;
    const entry = open.find((value) => value.id === state.current) || null;

    clear(nav).append(
      ...open.map((value) =>
        el(
          "button",
          {
            type: "button",
            class: `admin-nav-btn${value.id === state.current ? " is-active" : ""}`,
            onClick: () => show(value.id),
          },
          value.label
        )
      )
    );

    subtitle.textContent = entry ? entry.note : "Nothing here can be changed from this account.";
    clear(main);
    if (inFlight(state.progress) || state.progress.settled) {
      main.append(
        el("h2", { class: "admin-title" }, "A change is being applied"),
        renderChange(state.progress, { onDone: () => { state.progress = NOT_STARTED; load(state.current); draw(); } })
      );
      return;
    }
    if (!entry) {
      main.append(el("div", { class: "panel-note" }, "There is nothing here to show you."));
      return;
    }
    main.append(el("h2", { class: "admin-title" }, entry.label), el("p", { class: "lede" }, entry.note), body(entry.id));
  }

  function body(id) {
    if (id === "packages") {
      return renderPackages(
        { packages: state.setup.packages, filter: state.filter, selected: state.selected },
        {
          offered: state.sections,
          onSelect: (name) => { state.selected = name; draw(); },
          onFilter: (value) => { state.filter = value; redrawPackages(); },
          onAdd: (anchor, row, choice) => add(anchor, row, choice),
        }
      );
    }
    if (id === "models") return fields([["Model", state.setup.model?.model], ["Runs on", state.setup.model?.provider]]);
    if (id === "modes") {
      return fields([
        ["Can change files", state.setup.mode?.readOnly ? "No" : "Yes"],
        ["Turned off", state.setup.mode?.deny?.length ? state.setup.mode.deny.join(", ") : "Nothing"],
      ]);
    }
    if (id === "limits") {
      return fields([
        ["Steps per reply", count(state.setup.limits?.maxIterations)],
        ["Words per reply", count(state.setup.limits?.maxTokens)],
        ["Variation", count(state.setup.limits?.temperature)],
      ]);
    }
    if (id === "spaces") return spaces();
    if (id === "environments") return environment();
    if (id === "activity") return activity();
    if (id === "undo") return undo();
    return el("div", { class: "panel-note" }, "There is nothing here to show you.");
  }

  /** Repaints only the table, so typing in the filter does not take focus out of the box. */
  function redrawPackages() {
    const replaced = main.querySelector(".cols");
    if (!replaced) { draw(); return; }
    const next = body("packages");
    replaced.replaceWith(next);
    const box = next.querySelector(".srch input");
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  }

  function count(value) {
    return typeof value === "number" ? String(value) : "Not set";
  }

  function fields(rows) {
    return el(
      "div",
      { class: "admin-fields" },
      rows.map(([label, value]) =>
        el(
          "div",
          { class: "admin-field" },
          el("div", { class: "admin-field-copy" }, el("div", { class: "admin-field-key" }, label)),
          el("div", { class: "admin-field-control" }, el("span", { class: "admin-field-value" }, value || "Not set"))
        )
      )
    );
  }

  function spaces() {
    const rows = state.setup.spaces || [];
    if (!rows.length) return el("div", { class: "panel-note" }, "No folders are shared with your agent.");
    return el(
      "div",
      { class: "tbl-wrap" },
      el(
        "table",
        { class: "tbl" },
        el("thead", {}, el("tr", {}, el("th", {}, "Folder"), el("th", {}, "Whose"), el("th", {}, "May write"))),
        el(
          "tbody",
          {},
          rows.map((row) =>
            el(
              "tr",
              {},
              el("td", { class: "pk-name" }, row.path),
              el("td", { class: "quiet" }, row.space),
              el("td", {}, row.mode === "rw" ? el("span", { class: "pill pill-warn" }, "Yes") : el("span", { class: "quiet" }, "No"))
            )
          )
        )
      )
    );
  }

  function environment() {
    const env = state.env;
    if (!env) return el("div", { class: "panel-note" }, "Waiting for an answer…");
    return el(
      "div",
      {},
      !env.ready && env.reason ? el("div", { class: "panel-warning" }, env.reason) : null,
      fields([
        ["Ready", env.ready ? "Yes" : "No"],
        ["Times rebuilt", count(env.generation)],
      ])
    );
  }

  function activity() {
    const lines = activityLines(state.activity);
    if (!lines.length) return el("div", { class: "panel-note" }, "Nothing has happened to your environment yet.");
    return el(
      "div",
      { class: "list" },
      lines.map((line) =>
        el(
          "div",
          { class: "list-row" },
          el("span", { class: `dot is-${line.tone}` }),
          el("span", { class: "list-name" }, line.text),
          el("span", { class: "step-time" }, when(line.at))
        )
      )
    );
  }

  function when(at) {
    if (!at) return "";
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
  }

  /* Rebuilding your own environment is a whole change like any other, so it asks the same way an
   * update does — the facts first, then a separate press — and it is watched on the same screen. */
  function undo() {
    return el(
      "div",
      {},
      el(
        "button",
        {
          type: "button",
          class: "btn btn-warn",
          onClick: (event) =>
            confirmChange(event.currentTarget, {
              message: "Put your environment back?",
              facts: [
                ["change", "back to how it was"],
                ["affects", "you only"],
                ["rebuilt", count(state.env?.generation)],
              ],
              detail: "Your conversations pause while this happens and then carry on. Anything running inside your environment right now is lost.",
              confirmLabel: "Put it back",
              danger: true,
              onConfirm: () => {
                state.progress = NOT_STARTED;
                if (!sendFrame({ type: "admin.undo" })) toast("Not connected — try again once the connection is back.", { tone: "error" });
                draw();
              },
            }),
        },
        "Put my environment back"
      )
    );
  }

  /* Neither way of putting a version in place is offered by any deployment yet, so this is reached
   * only where one is. It still asks the same question first: what changes, for whom, and what the
   * checks said. */
  function add(anchor, row, choice) {
    confirmChange(anchor, {
      message: choice.scope === "deployment" ? "Make this the version everyone gets?" : "Put this version in place for you?",
      facts: [["package", row.name], ["version", row.version || "—"], ["affects", choice.scope === "deployment" ? "everyone" : "you only"]],
      detail: "Conversations pause while this is applied and then carry on. If it does not start, what you have now comes back on its own.",
      confirmLabel: choice.scope === "deployment" ? "Make it the default" : "Put it in place",
      danger: choice.scope === "deployment",
      onConfirm: () => {
        state.progress = NOT_STARTED;
        sendFrame({ type: "admin.add", scope: choice.scope, name: row.name, version: row.version });
        draw();
      },
    });
  }

  launcher();

  return {
    /** One inbound frame from the host. Everything the panel knows arrives through here. */
    apply(frame) {
      if (frame.view === "open") {
        state.role = frame.role || "user";
        state.sections = Array.isArray(frame.sections) ? frame.sections : [];
        if (state.sections.length && !state.current) state.current = visibleSections(state.sections)[0]?.id ?? null;
        if (state.current) load(state.current);
      }
      if (frame.view === "setup") state.setup = { packages: frame.packages || [], model: frame.model, mode: frame.mode, limits: frame.limits, spaces: frame.spaces };
      if (frame.view === "activity") state.activity = Array.isArray(frame.rows) ? frame.rows : [];
      if (frame.view === "environment") {
        state.env = frame;
        state.progress = advance(state.progress, frame.state);
        store.set({ env: frame });
        watch();
      }
      draw();
    },
    /** The connection came back. A change that was in flight when it dropped is still the thing worth
     *  watching, so the watch resumes rather than being written off. */
    reconnected() {
      if (state.open) sendFrame({ type: "admin.open" });
      if (state.open && inFlight(state.progress)) sendFrame({ type: "admin.environment" });
    },
  };
}

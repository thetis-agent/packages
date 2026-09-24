/* The editor: a top bar (the name, the versions, the cost cap, Validate, Publish), the step palette, the
 * canvas and the inspector. The draft in this page is the truth while it is open: every edit writes into
 * it, redraws the canvas, and schedules a `save` (debounced; one in flight at a time, the latest draft
 * always sent last). A save answers the validation too, which feeds the markers on the nodes and the
 * issue count; Validate asks `validate` and opens the list, where an issue selects its step. Publish saves
 * first, then asks `publish`, and says the service's reason when it refuses.
 *
 * Keys, while the editor is open: Delete (or Backspace) removes the selected step when focus is not in a
 * field, and Escape deselects before it is allowed to close the place. Both are caught on the window in
 * the capture phase, because the shell closes the place on a document-level Escape. */

import { createCanvas, DRAG_MIME } from "./canvas.js";
import { ROW_GAP } from "./graph.js";
import { sortIssues, positive } from "./format.js";
import { svgIcon } from "./icons.js";
import { renderInspector } from "./inspector.js";
import { button, chooser, crumbs, iconButton } from "./parts.js";
import { FLOW_FIELDS, GROUPS, TYPES, budgetLine, freshId, newStep, nodeSummary, removeStep, renameStep } from "./steps.js";

/** The version hint: shortened by the bar when room runs out, so the whole sentence is its tooltip too. */
const hint = (text) => { const span = document.createElement("span"); span.className = "wf-bar-hint"; span.title = text; span.textContent = text; return span; };

const SAVE_DELAY = 700;

export function openEditor(host, ctx, { id }) {
  const { ext, call, go, feed } = ctx;
  const { el, clear } = ext.dom;
  let alive = true;
  let draft = null;
  let versions = [];
  let published = null; // the latest published version number
  let catalog = null;
  let selected = null;
  let issues = sortIssues([]);
  let issuesOpen = false;
  let inspectorOpen = true;
  const samples = new Map();

  // saving
  let timer = null;
  let runner = null;
  let saveState = "saved"; // saved | pending | saving | error
  let saveError = "";

  host.append(el("div", { class: "wf-page" }, el("p", { class: "wf-empty" }, "Loading the workflow…")));

  /* --- load ---------------------------------------------------------------------------------- */

  async function load() {
    try {
      const [got, cat] = await Promise.all([call("get", { id }), ctx.catalog().catch((err) => {
        ext.toast(`The model and tool lists could not be read: ${err?.message || err}`, { tone: "error" });
        return { models: [], defaultModel: "", projects: [], tools: [] };
      })]);
      if (!alive) return;
      if (!got?.draft) throw new Error("The service answered without a draft.");
      draft = got.draft;
      draft.steps ??= {};
      draft.layout ??= {};
      versions = Array.isArray(got.versions) ? got.versions : [];
      published = got.published?.version ?? (versions.length ? Math.max(...versions) : null);
      catalog = cat;
      build();
      void validate(false);
    } catch (err) {
      if (!alive) return;
      clear(host);
      host.append(
        el(
          "div",
          { class: "wf-page" },
          el("div", { class: "wf-lib" }, crumbs(ext, [{ label: "Workflows", onClick: go.library }, { label: id }]), el("p", { class: "wf-error" }, err?.message || "The workflow could not be read."), button(ext, "Back to workflows", { onClick: go.library }))
        )
      );
    }
  }

  /* --- saving -------------------------------------------------------------------------------- */

  function changed() {
    saveState = "pending";
    drawSaveState();
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY);
  }

  /**
   * Sends the draft now, and again for as long as edits keep arriving while a save is on its way, so the
   * last thing the service holds is this page's latest draft. Resolves when there is nothing left to send
   * or a save failed with no newer edit behind it.
   */
  function flush() {
    clearTimeout(timer);
    if (runner) return runner;
    if (saveState !== "pending") return Promise.resolve();
    runner = (async () => {
      while (saveState === "pending") {
        const body = JSON.parse(JSON.stringify(draft));
        saveState = "saving";
        drawSaveState();
        try {
          const out = await call("save", { id, definition: body });
          if (out?.validation) setIssues(out.validation.issues);
          if (saveState === "saving") saveState = "saved";
        } catch (err) {
          saveError = err?.message || "The draft could not be saved.";
          if (saveState === "saving") saveState = "error";
        }
      }
    })().finally(() => {
      runner = null;
      if (alive) drawSaveState();
    });
    return runner;
  }

  /* --- validation and publishing ------------------------------------------------------------- */

  function setIssues(list) {
    issues = sortIssues(list);
    if (!alive || !bar) return;
    drawValidateBadge();
    if (issuesOpen) drawIssues();
    renderCanvas();
  }

  async function validate(open) {
    try {
      const out = await call("validate", { definition: draft });
      if (!alive) return;
      setIssues(out?.issues ?? []);
      if (open) {
        issuesOpen = true;
        drawIssues();
      }
    } catch (err) {
      if (open) ext.toast(err?.message || "The draft could not be validated.", { tone: "error" });
    }
  }

  async function publish(btn) {
    btn.disabled = true;
    try {
      if (saveState === "error") saveState = "pending";
      await flush();
      if (saveState !== "saved") throw new Error(saveError || "the draft could not be saved first.");
      const out = await call("publish", { id });
      if (!alive) return;
      published = out?.version ?? published;
      if (out?.validation) setIssues(out.validation.issues);
      try {
        const got = await call("get", { id });
        if (got?.draft?.version != null) draft.version = got.draft.version;
        versions = got?.versions ?? versions;
      } catch {
        /* the version line is a moment behind; the next open fixes it */
      }
      drawVersion();
      ext.toast(`Published as v${published}. New runs use it; runs already queued keep their version.`, { tone: "ok" });
    } catch (err) {
      ext.toast(`Not published: ${err?.message || "the service refused."}`, { tone: "error" });
      void validate(true);
    } finally {
      if (alive) btn.disabled = false;
    }
  }

  /* --- editing ------------------------------------------------------------------------------- */

  function edit({ structural = false, inspector = false } = {}) {
    renderCanvas();
    if (structural || inspector) renderInspectorPane();
    syncBar();
    changed();
  }

  function select(next) {
    if (next && !draft.steps[next]) next = null;
    if (next === selected) return;
    selected = next;
    renderCanvas();
    renderInspectorPane();
    if (next && !inspectorOpen) setInspector(true);
  }

  function addStep(type, at) {
    const sid = freshId(draft, type);
    const step = newStep(type, { defaultModel: catalog?.defaultModel });
    draft.steps[sid] = step;
    const lay = { ...canvas.layout() };
    let pos = at;
    const from = !at && selected && draft.steps[selected] ? selected : null;
    if (!pos && from) pos = { x: lay[from].x, y: lay[from].y + ROW_GAP };
    if (!pos) {
      const c = canvas.viewCenter();
      pos = { x: Math.round(c.x - 110), y: Math.round(c.y - 30) };
    }
    // Clicking a palette entry with a step selected adds the new one after it, when it has no next yet.
    if (from) {
      const primary = FLOW_FIELDS[draft.steps[from].type]?.[0]?.field;
      if (primary && primary !== "default" && primary !== "target" && !draft.steps[from][primary]) draft.steps[from][primary] = sid;
    }
    if (!draft.start) draft.start = sid;
    lay[sid] = pos;
    draft.layout = lay;
    selected = sid;
    edit({ inspector: true });
    canvas.reveal(sid);
    canvas.focusNode(sid);
  }

  function deleteStep(sid) {
    if (!draft.steps[sid]) return;
    const before = JSON.stringify(draft);
    removeStep(draft, sid);
    if (selected === sid) selected = null;
    edit({ inspector: true });
    ext.toast(`Step "${sid}" deleted.`, {
      action: {
        label: "Undo",
        run: () => {
          if (!alive) return;
          draft = JSON.parse(before);
          selected = sid;
          edit({ inspector: true });
        },
      },
    });
  }

  function connect(from, to, point) {
    const step = draft.steps[from];
    if (!step) return;
    const set = (field) => {
      step[field] = to;
      edit({ inspector: selected === from });
    };
    const name = (id) => draft.steps[id]?.label || id;
    const fields = FLOW_FIELDS[step.type] ?? [];
    if (step.type === "branch") {
      const input = el("input", { class: "input wf-mono", type: "text", placeholder: "Case value", "aria-label": "New case value", spellcheck: "false" });
      const add = el("form", { class: "wf-chooser-extra" }, input, button(ext, "Add case", { tone: "primary" }));
      add.querySelector("button").type = "submit";
      let close = null;
      add.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = input.value;
        if (!v) return;
        step.cases = { ...(step.cases ?? {}), [v]: to };
        close?.();
        edit({ inspector: selected === from });
      });
      close = chooser(ext, { x: point.clientX + 8, y: point.clientY + 8 }, {
        title: `${name(from)} → ${name(to)}`,
        items: [
          ...Object.keys(step.cases ?? {}).map((v) => ({ label: `Case ${v}`, note: step.cases[v] ? `now ${name(step.cases[v])}` : "not set", run: () => { step.cases[v] = to; edit({ inspector: selected === from }); } })),
          { label: "Default", note: step.default ? `now ${name(step.default)}` : "not set", run: () => set("default") },
        ],
        extra: add,
      });
      input.focus();
      return;
    }
    if (!fields.length) return;
    const primary = fields[0].field;
    if (!step[primary]) return set(primary);
    chooser(ext, { x: point.clientX + 8, y: point.clientY + 8 }, {
      title: `${name(from)} → ${name(to)}: which way?`,
      items: fields.map((f) => ({ label: f.field, note: step[f.field] ? `now ${name(step[f.field])}` : `not set (${f.fallback})`, run: () => set(f.field) })),
    });
  }

  /* --- the parts ----------------------------------------------------------------------------- */

  let bar, nameInput, capInput, versionText, saveText, validateBtn, issuesHost, inspectorHost, paletteHost, canvas, inspToggle, shell;

  function drawSaveState() {
    if (!saveText) return;
    saveText.classList.toggle("is-err", saveState === "error");
    clear(saveText);
    if (saveState === "error") {
      saveText.append(el("span", {}, `Not saved: ${saveError}`), el("button", { type: "button", class: "wf-link", onClick: () => { saveState = "pending"; flush(); } }, "Retry"));
    } else saveText.textContent = saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Unsaved changes";
  }

  function drawVersion() {
    if (!versionText) return;
    const d = draft.version != null ? `v${draft.version} draft` : "draft";
    versionText.textContent = published != null ? `${d} · v${published} published` : `${d} · never published`;
  }

  function drawValidateBadge() {
    if (!validateBtn) return;
    validateBtn.querySelector(".wf-count")?.remove();
    const n = issues.errors + issues.warns;
    if (n) validateBtn.append(el("span", { class: `wf-count ${issues.errors ? "is-err" : "is-warn"}`, "aria-label": `${issues.errors} errors, ${issues.warns} warnings` }, String(n)));
  }

  function drawIssues() {
    clear(issuesHost);
    issuesHost.hidden = !issuesOpen;
    if (!issuesOpen) return;
    issuesHost.append(
      el(
        "div",
        { class: "wf-issues-head" },
        el("span", { class: "wf-insp-h" }, issues.list.length ? `${issues.errors} error${issues.errors === 1 ? "" : "s"} · ${issues.warns} warning${issues.warns === 1 ? "" : "s"}` : "No issues"),
        issues.errors ? el("span", { class: "wf-section-note" }, "Publishing refuses a draft with errors.") : el("span", { class: "wf-section-note" }, "This draft can be published."),
        iconButton(ext, "x", "Close the issue list", () => { issuesOpen = false; drawIssues(); })
      ),
      issues.list.length
        ? el(
            "ul",
            { class: "wf-issues-list" },
            ...issues.list.map((i) =>
              el(
                "li",
                {},
                el(
                  "button",
                  {
                    type: "button",
                    class: `wf-issue is-${i.level === "error" ? "err" : "warn"}`,
                    disabled: i.step && !draft.steps[i.step] ? true : null,
                    onClick: () => {
                      if (i.step && draft.steps[i.step]) {
                        select(i.step);
                        canvas.center(i.step);
                      } else select(null);
                    },
                  },
                  svgIcon(i.level === "error" ? "error" : "warn", { size: 13 }),
                  i.step ? el("span", { class: "wf-chip is-mono" }, i.step) : null,
                  el("span", {}, i.message)
                )
              )
            )
          )
        : el("p", { class: "wf-empty" }, "Nothing to fix.")
    );
  }

  function syncBar() {
    if (nameInput && document.activeElement !== nameInput) nameInput.value = draft.name ?? "";
    if (capInput && document.activeElement !== capInput) capInput.value = draft.costCapUsd ?? "";
  }

  function setInspector(open) {
    inspectorOpen = open;
    shell.classList.toggle("is-inspector-closed", !open);
    inspToggle.setAttribute("aria-pressed", open ? "true" : "false");
  }

  function palette() {
    const find = el("input", { type: "search", class: "wf-find", placeholder: "Find a step", "aria-label": "Find a step type" });
    const groups = el("div", { class: "wf-palette-groups" });
    const draw = () => {
      const q = find.value.trim().toLowerCase();
      groups.replaceChildren(
        ...GROUPS.map((g) => {
          const items = Object.entries(TYPES).filter(([t, m]) => m.group === g && (!q || `${t} ${m.label} ${m.hint}`.toLowerCase().includes(q)));
          if (!items.length) return null;
          return el(
            "div",
            { class: "wf-palette-group", role: "group", "aria-label": g },
            el("span", { class: "wf-palette-h" }, g),
            ...items.map(([type, m]) => {
              const b = el(
                "button",
                { type: "button", class: `wf-palette-item tone-${m.tone}`, draggable: "true", title: `${m.label}: ${m.hint}. Click to add, or drag onto the canvas.`, "aria-label": `Add ${m.label}` },
                el("span", { class: "wf-node-icon" }, svgIcon(type, { size: 14 })),
                el("span", { class: "wf-palette-text" }, el("span", { class: "wf-palette-label" }, m.label), el("span", { class: "wf-palette-hint" }, m.hint))
              );
              b.addEventListener("click", () => addStep(type));
              b.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData(DRAG_MIME, type);
                e.dataTransfer.setData("text/plain", type);
                e.dataTransfer.effectAllowed = "copy";
              });
              return b;
            })
          );
        }).filter(Boolean)
      );
    };
    find.addEventListener("input", draw);
    draw();
    return el("aside", { class: "wf-palette", "aria-label": "Step palette" }, el("label", { class: "wf-find-wrap" }, svgIcon("search", { size: 13 }), find), groups);
  }

  function decorate(sid, step) {
    const classes = [];
    const lvl = issues.byStep[sid];
    if (lvl) classes.push(lvl === "error" ? "has-error" : "has-warn");
    const out = { classes, sub: nodeSummary(step, draft) };
    if (step.type === "prompt") {
      out.chip = step.model || "no model";
      const b = budgetLine(step.budget);
      out.meta = b || "no budget";
      if (!b) classes.push("no-budget");
    }
    if (lvl) out.status = lvl === "error" ? "has errors" : "has warnings";
    return out;
  }

  function renderCanvas() {
    if (!canvas) return;
    canvas.render({ def: draft, selected });
  }

  function renderInspectorPane() {
    if (!inspectorHost) return;
    const scroll = inspectorHost.querySelector(".wf-insp-scroll")?.scrollTop ?? 0;
    clear(inspectorHost);
    inspectorHost.append(
      renderInspector(ext, {
        def: draft,
        selected,
        catalog,
        issues,
        samples,
        onChange: (structural) => edit({ structural }),
        rename: (from, to) => {
          const err = renameStep(draft, from, to);
          if (err) return err;
          if (samples.has(from)) samples.set(to, samples.get(from));
          selected = to;
          edit({ inspector: true });
          return null;
        },
        remove: deleteStep,
        setStart: (sid) => {
          draft.start = sid;
          edit({ inspector: true });
        },
        select,
      })
    );
    const next = inspectorHost.querySelector(".wf-insp-scroll");
    if (next) next.scrollTop = scroll;
  }

  function build() {
    clear(host);
    nameInput = el("input", { class: "wf-name-input", type: "text", maxlength: "80", "aria-label": "Workflow name", spellcheck: "false" });
    nameInput.value = draft.name ?? "";
    nameInput.addEventListener("input", () => {
      draft.name = nameInput.value;
      edit({ inspector: selected === null });
    });
    capInput = el("input", { class: "input wf-mono wf-cap-input", type: "text", inputmode: "decimal", placeholder: "default", id: "wf-cap", autocomplete: "off", "aria-label": "Cost cap per run, US dollars" });
    capInput.value = draft.costCapUsd ?? "";
    capInput.addEventListener("input", () => {
      const v = positive(capInput.value);
      if (v === undefined) delete draft.costCapUsd;
      else draft.costCapUsd = v;
      capInput.classList.toggle("is-bad", Boolean(capInput.value.trim()) && v === undefined);
      edit({ inspector: selected === null });
    });
    versionText = el("span", { class: "wf-version" });
    saveText = el("span", { class: "wf-save", role: "status", "aria-live": "polite" });
    validateBtn = button(ext, "Validate", { icon: "shield", onClick: () => (issuesOpen && !issuesHost.hidden ? ((issuesOpen = false), drawIssues()) : validate(true)) });
    validateBtn.setAttribute("aria-controls", "wf-issues");
    const publishBtn = button(ext, "Publish", { tone: "primary", icon: "play" });
    publishBtn.addEventListener("click", () => publish(publishBtn));
    inspToggle = iconButton(ext, "panel", "Show or hide the inspector", () => setInspector(!inspectorOpen), { className: "wf-insp-toggle" });

    const running = feed.runs().filter((r) => r.workflow === id && (r.state === "running" || r.state === "waiting")).length;
    bar = el(
      "header",
      { class: "wf-bar" },
      crumbs(ext, [{ label: "Workflows", onClick: () => { void flush(); go.library(); } }, { node: nameInput }]),
      el("div", { class: "wf-bar-version" }, versionText, hint(running ? `${running} run${running === 1 ? "" : "s"} in progress keep${running === 1 ? "s" : ""} the version queued with` : "A run keeps the version it was queued with")),
      el("div", { class: "wf-bar-tools" }, saveText, el("label", { class: "wf-cap", for: "wf-cap", title: "Cost cap per run, in US dollars" }, "Cap $", capInput), validateBtn, publishBtn, inspToggle)
    );
    issuesHost = el("div", { class: "wf-issues", id: "wf-issues", hidden: true, role: "region", "aria-label": "Validation issues" });
    paletteHost = palette();
    canvas = createCanvas(ext, {
      label: "Workflow graph",
      decorate,
      onSelect: select,
      onMove: (sid, p) => {
        draft.layout = { ...canvas.layout(), [sid]: { x: p.x, y: p.y } };
        changed();
      },
      onConnect: connect,
      onDrop: (type, p) => (TYPES[type] ? addStep(type, p) : null),
      onDelete: deleteStep,
      tools: [
        el("span", { class: "wf-zoom-rule" }),
        iconButton(ext, "tidy", "Arrange the graph automatically", () => {
          const before = draft.layout;
          draft.layout = {};
          edit();
          draft.layout = { ...canvas.layout() };
          canvas.fit();
          ext.toast("The graph is arranged from the start step.", { action: { label: "Undo", run: () => { draft.layout = before; edit(); canvas.fit(); } } });
        }),
      ],
    });
    inspectorHost = el("aside", { class: "wf-inspector", "aria-label": "Inspector" });
    shell = el("div", { class: "wf-editor" }, bar, issuesHost, el("div", { class: "wf-body" }, paletteHost, el("div", { class: "wf-stage" }, canvas.node), inspectorHost));
    host.append(shell);
    // In a narrow pane the inspector covers the canvas; start with it closed until a step is selected.
    if (host.clientWidth && host.clientWidth < 760) inspectorOpen = false;
    drawVersion();
    drawSaveState();
    drawValidateBadge();
    setInspector(inspectorOpen);
    renderCanvas();
    renderInspectorPane();
  }

  /* --- keys ---------------------------------------------------------------------------------- */

  const editable = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  function onKey(e) {
    if (!draft || !shell?.isConnected) return;
    if (document.querySelector(".popover")) return; // a chooser or confirm handles its own Escape
    if (e.key === "Escape") {
      if (selected) {
        e.stopPropagation();
        e.preventDefault();
        select(null);
      } else if (issuesOpen) {
        e.stopPropagation();
        issuesOpen = false;
        drawIssues();
      }
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !editable(e.target)) {
      e.preventDefault();
      deleteStep(selected);
    }
  }
  window.addEventListener("keydown", onKey, true);

  function beforeUnload(e) {
    if (saveState === "saved") return;
    e.preventDefault();
    e.returnValue = "";
  }
  window.addEventListener("beforeunload", beforeUnload);

  load();
  return () => {
    alive = false;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("beforeunload", beforeUnload);
    canvas?.destroy();
    if (draft && saveState !== "saved") {
      // Closing the place is not a reason to lose an edit: send what is pending, and say it if that fails.
      if (saveState === "error") saveState = "pending";
      flush().then(() => {
        if (saveState === "error") ext.toast(`The workflow draft was not saved: ${saveError}`, { tone: "error" });
      });
    }
  };
}

/* The library: every workflow with its versions and run counts, the box that queues runs of a published
 * one, and the latest runs from the watch feed. The workflow list comes from `list`; each published
 * workflow's input label and placeholder come from its published definition (`get`), asked once per open.
 * What is typed into an input box is kept across redraws, and the box keeps focus when the list is rebuilt
 * under it, because run events arrive while someone is typing. */

import { ago, inputCount, inputRuns, money } from "./format.js";
import { svgIcon } from "./icons.js";
import { button, chip, crumbs, feedNote, stateChip } from "./parts.js";

const texts = new Map(); // workflow id -> what was typed in its input box, for this page load

export function openLibrary(host, ctx) {
  const { ext, call, feed, go } = ctx;
  const { el, clear } = ext.dom;
  let alive = true;
  let workflows = null; // from `list`
  let listError = null;
  const inputs = new Map(); // workflow id -> published definition's `input`, or null
  let refreshTimer = null;
  let drawQueued = false;
  let creating = false;

  const listHost = el("div", { class: "wf-lib-list" });
  const runsHost = el("section", { class: "wf-lib-runs", "aria-labelledby": "wf-lib-runs-h" });
  const queueHost = el("div", { class: "wf-queue" });
  const newForm = el("form", { class: "wf-new", hidden: true });

  async function loadList() {
    try {
      const list = await call("list");
      if (!alive) return;
      workflows = Array.isArray(list) ? list : [];
      listError = null;
      for (const wf of workflows) if (wf.published != null && !inputs.has(wf.id)) void loadInput(wf.id);
    } catch (err) {
      if (!alive) return;
      listError = err?.message || "The workflows could not be listed.";
    }
    drawList();
  }

  async function loadInput(id) {
    inputs.set(id, null);
    try {
      const got = await call("get", { id });
      if (!alive) return;
      inputs.set(id, got?.published?.input ?? got?.draft?.input ?? null);
      drawList();
    } catch {
      inputs.delete(id);
    }
  }

  async function loadQueue() {
    try {
      const q = await call("queue");
      if (!alive) return;
      feed.queue = q;
      drawQueue();
    } catch {
      /* the feed will say it when it next changes */
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadList, 1200);
  }

  /* --- the head: queue and "New workflow" ------------------------------------------------------ */

  function drawQueue() {
    clear(queueHost);
    const q = feed.queue;
    if (!q) return;
    const running = Array.isArray(q.running) ? q.running.length : 0;
    queueHost.append(
      chip(ext, q.paused ? "Queue paused" : "Queue running", q.paused ? "warn" : "ok", { pulse: !q.paused && running > 0 }),
      el("span", { class: "wf-queue-counts" }, `${running} running · ${q.queued ?? 0} queued`),
      button(ext, q.paused ? "Resume" : "Pause", {
        icon: q.paused ? "play" : "pause",
        onClick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            feed.queue = await call("queue", { paused: !q.paused });
            ext.toast(feed.queue.paused ? "The queue is paused. Running runs finish; no new one starts." : "The queue is running again.", { tone: "ok" });
          } catch (err) {
            ext.toast(err?.message || "The queue could not be changed.", { tone: "error" });
          }
          if (alive) drawQueue();
        },
      })
    );
  }

  function drawNewForm() {
    clear(newForm);
    const name = el("input", { class: "input", type: "text", name: "name", maxlength: "80", placeholder: "What this workflow does", "aria-label": "New workflow name", required: true });
    newForm.append(
      el("label", { class: "wf-new-label" }, "Name", name),
      button(ext, "Create", { tone: "primary", className: "wf-new-create" }),
      button(ext, "Cancel", { onClick: () => { newForm.hidden = true; } })
    );
    newForm.querySelector(".wf-new-create").type = "submit";
    newForm.onsubmit = async (e) => {
      e.preventDefault();
      const value = name.value.trim();
      if (!value || creating) return;
      creating = true;
      try {
        const draft = await call("create", { name: value });
        if (!alive) return;
        if (draft?.id) go.editor(draft.id);
        else loadList();
      } catch (err) {
        ext.toast(err?.message || "The workflow could not be created.", { tone: "error" });
      } finally {
        creating = false;
      }
    };
    newForm.hidden = false;
    name.focus();
  }

  /* --- the workflows ------------------------------------------------------------------------- */

  function versionChips(wf) {
    const out = [];
    if (wf.published != null) out.push(chip(ext, `v${wf.published} published`, "ok", { mono: true }));
    else out.push(chip(ext, "never published", "dim"));
    if (wf.draftVersion != null) out.push(chip(ext, `v${wf.draftVersion} draft`, "warn", { mono: true, title: "The draft publishes as this version" }));
    return el("span", { class: "wf-chips" }, ...out);
  }

  function counts(wf) {
    const r = wf.runs ?? {};
    const parts = [];
    if (r.active) parts.push(chip(ext, `${r.active} active`, "accent", { pulse: true }));
    if (r.needs) parts.push(chip(ext, `${r.needs} need${r.needs === 1 ? "s" : ""} you`, "warn"));
    parts.push(el("span", { class: "wf-card-fact" }, `${r.total ?? 0} run${r.total === 1 ? "" : "s"}`));
    parts.push(el("span", { class: "wf-card-fact" }, r.lastAt ? `last ${ago(r.lastAt)}` : "never run"));
    return el("div", { class: "wf-card-counts" }, ...parts);
  }

  function queueBox(wf) {
    if (wf.published == null) return el("p", { class: "wf-card-note" }, "Publish a version to queue runs of it.");
    const input = inputs.get(wf.id) ?? {};
    const kind = input.kind === "text" ? "text" : "lines";
    const id = `wf-in-${wf.id}`;
    const area = el("textarea", { id, class: "input wf-queue-input", rows: kind === "lines" ? "3" : "4", placeholder: input.placeholder || (kind === "lines" ? "One input per line" : "The input for one run"), spellcheck: "false", "data-wf": wf.id });
    area.value = texts.get(wf.id) ?? "";
    const count = el("span", { class: "wf-queue-count", "aria-live": "polite" }, inputCount(kind, area.value));
    const go_ = button(ext, "Queue", { tone: "primary", icon: "play", disabled: !inputRuns(kind, area.value) });
    area.addEventListener("input", () => {
      texts.set(wf.id, area.value);
      count.textContent = inputCount(kind, area.value);
      go_.disabled = !inputRuns(kind, area.value);
    });
    go_.addEventListener("click", async () => {
      const text = area.value;
      if (!inputRuns(kind, text)) return;
      go_.disabled = true;
      try {
        const out = await call("enqueue", { id: wf.id, text });
        const n = out?.runs?.length ?? 0;
        texts.delete(wf.id);
        if (alive) {
          area.value = "";
          count.textContent = inputCount(kind, "");
        }
        ext.toast(`${n} run${n === 1 ? "" : "s"} of "${wf.name}" queued on v${wf.published}.`, {
          tone: "ok",
          action: n === 1 && out.runs[0]?.id ? { label: "Open", run: () => go.run(out.runs[0].id) } : undefined,
        });
      } catch (err) {
        ext.toast(err?.message || "The runs could not be queued.", { tone: "error" });
        go_.disabled = false;
      }
    });
    return el(
      "div",
      { class: "wf-queue-box" },
      el("label", { class: "wf-queue-label", for: id }, input.label || (kind === "lines" ? "Inputs, one run per line" : "Input")),
      area,
      el("div", { class: "wf-queue-foot" }, count, go_)
    );
  }

  async function remove(wf, anchor) {
    const ok = await ext.ui.confirm(anchor, {
      title: "Delete this workflow?",
      lines: [["Workflow", wf.name], ["Runs", String(wf.runs?.total ?? 0)]],
      note: "Its draft and published versions are deleted. Its runs are kept, and so are the conversations they opened.",
      confirmLabel: "Delete",
      tone: "warn",
    });
    if (!ok || !alive) return;
    try {
      await call("remove", { id: wf.id });
      ext.toast(`"${wf.name}" deleted.`, { tone: "ok" });
      loadList();
    } catch (err) {
      ext.toast(err?.message || "The workflow could not be deleted.", { tone: "error" });
    }
  }

  async function duplicate(wf) {
    try {
      const draft = await call("create", { name: `${wf.name} (copy)`, from: wf.id });
      if (alive && draft?.id) go.editor(draft.id);
    } catch (err) {
      ext.toast(err?.message || "The workflow could not be copied.", { tone: "error" });
    }
  }

  function card(wf) {
    const del = el("button", { type: "button", class: "wf-icon-btn", "aria-label": `Delete ${wf.name}`, title: "Delete" }, svgIcon("trash", { size: 14 }));
    del.addEventListener("click", () => remove(wf, del));
    return el(
      "article",
      { class: "wf-card", "aria-label": wf.name },
      el(
        "div",
        { class: "wf-card-head" },
        el("span", { class: "wf-mark", "aria-hidden": "true" }, svgIcon("workflow", { size: 15 })),
        el(
          "div",
          { class: "wf-card-title" },
          el("button", { type: "button", class: "wf-card-name", onClick: () => go.editor(wf.id) }, wf.name || wf.id),
          wf.description ? el("p", { class: "wf-card-desc" }, wf.description) : null
        ),
        el(
          "div",
          { class: "wf-card-actions" },
          button(ext, "Edit", { onClick: () => go.editor(wf.id) }),
          el("button", { type: "button", class: "wf-icon-btn", "aria-label": `Duplicate ${wf.name}`, title: "Duplicate", onClick: () => duplicate(wf) }, svgIcon("copy", { size: 14 })),
          del
        )
      ),
      el("div", { class: "wf-card-meta" }, versionChips(wf), counts(wf)),
      queueBox(wf)
    );
  }

  function drawList() {
    if (!alive) return;
    const focused = document.activeElement?.dataset?.wf ? { id: document.activeElement.dataset.wf, s: document.activeElement.selectionStart, e: document.activeElement.selectionEnd } : null;
    clear(listHost);
    if (listError && !workflows) listHost.append(el("p", { class: "wf-error" }, listError));
    else if (!workflows) listHost.append(el("p", { class: "wf-empty" }, "Loading…"));
    else if (!workflows.length) listHost.append(el("div", { class: "wf-empty-card" }, el("p", {}, "No workflows yet."), el("p", { class: "wf-card-note" }, "A workflow is a graph of prompts, tool calls, parsing and branches that runs unattended in your own conversations.")));
    else for (const wf of workflows) listHost.append(card(wf));
    if (focused) {
      const area = listHost.querySelector(`textarea[data-wf="${CSS.escape(focused.id)}"]`);
      if (area) {
        area.focus();
        area.setSelectionRange(focused.s, focused.e);
      }
    }
  }

  /* --- the runs ------------------------------------------------------------------------------ */

  function drawRuns() {
    drawQueued = false;
    if (!alive) return;
    clear(runsHost);
    const runs = feed.runs().slice(0, 30);
    runsHost.append(el("div", { class: "wf-section-head" }, el("h2", { id: "wf-lib-runs-h", class: "wf-h2" }, "Recent runs"), el("span", { class: "wf-section-note" }, feed.status === "live" ? `${runs.length} shown · live` : feed.status === "lost" ? "not live" : "connecting…")));
    const note = feedNote(ext, feed);
    if (note) runsHost.append(note);
    runsHost.append(
      ext.ui.table(
        [
          { key: "state", label: "State", render: (r) => stateChip(ext, r.state) },
          { key: "run", label: "Run", render: (r) => el("span", { class: "wf-run-name" }, el("span", {}, r.name || r.workflow), el("span", { class: "wf-faint" }, ` #${r.number ?? "?"} · v${r.version ?? "?"}`)) },
          { key: "input", label: "Input", render: (r) => el("span", { class: "wf-run-in", title: r.input ?? "" }, r.input ?? "") },
          { key: "step", label: "Step", render: (r) => el("span", { class: "wf-mono" }, r.step ?? "") },
          { key: "cost", label: "Cost", render: (r) => el("span", { class: "wf-mono" }, money(r.cost)) },
          { key: "when", label: "Updated", render: (r) => el("span", { class: "wf-faint" }, ago(r.updatedAt ?? r.createdAt)) },
        ],
        runs,
        { onRow: (r) => go.run(r.id), rowKey: (r) => r.id, empty: feed.status === "live" ? "No runs yet. Queue one from a published workflow above." : "Waiting for the run list…" }
      )
    );
  }

  function queueRunsDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(drawRuns);
  }

  const unlisten = feed.listen((change) => {
    if (change.kind === "snapshot" || change.kind === "run" || change.kind === "status") queueRunsDraw();
    if (change.kind === "run" || change.kind === "workflow") {
      if (change.kind === "workflow") inputs.delete(change.id);
      scheduleRefresh(); // the counts and "last run" come from `list`
    }
    if (change.kind === "queue") drawQueue();
  });

  host.append(
    el(
      "div",
      { class: "wf-page" },
      el(
        "div",
        { class: "wf-lib" },
        el(
          "header",
          { class: "wf-lib-head" },
          el("div", { class: "wf-lib-title" }, crumbs(ext, [{ label: "Workflows" }]), el("p", { class: "wf-section-note" }, "Graphs of prompts, tool calls and checks that run unattended in your own conversations.")),
          queueHost,
          button(ext, "New workflow", { tone: "primary", icon: "plus", onClick: drawNewForm })
        ),
        newForm,
        listHost,
        runsHost
      )
    )
  );
  drawList();
  drawRuns();
  loadList();
  if (feed.queue) drawQueue();
  else loadQueue();

  return () => {
    alive = false;
    clearTimeout(refreshTimer);
    unlisten();
  };
}

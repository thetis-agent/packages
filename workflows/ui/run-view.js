/* The run view: one run, watched live. The full run (with `vars`) comes from `run`; the feed's `run`
 * events carry no vars, so an event for this run asks `run` again (coalesced). The graph is the
 * workflow's definition drawn read-only with each step's status and the path the run took. The service has
 * no op for an older published version, so the graph is the published version when it is the run's, else
 * the draft when that is, else the nearest one with a line saying the run used another version.
 *
 * The note typed for an approval survives the redraws a live run causes: it lives in this view, not in the
 * field. */

import { createCanvas } from "./canvas.js";
import { compact, nodeSummary, TYPES } from "./steps.js";
import { duration, money } from "./format.js";
import { svgIcon } from "./icons.js";
import { button, chip, crumbs, feedNote, stateChip } from "./parts.js";
import { ACTIVE, ENDED, costShare, entryMs, nodeStatuses, pathTaken, retryChoices, runLabel, visitCounts } from "./runstate.js";

/** The meter's fill. Set through the CSSOM: the page's CSP refuses a `style` attribute. */
function fill(node, share) {
  node.style.width = `${(share * 100).toFixed(1)}%`;
  return node;
}

const STATUS_WORDS = { done: "done", running: "running", waiting: "waiting", failed: "failed", skipped: "skipped", needs: "needs you", cancelled: "stopped", queued: "queued", idle: "not reached" };
const STATUS_TONE = { done: "ok", running: "accent", waiting: "warn", failed: "err", skipped: "dim", needs: "warn", cancelled: "dim", queued: "dim", idle: "dim" };

export function openRun(host, ctx, { id }) {
  const { ext, call, feed, go } = ctx;
  const { el, clear } = ext.dom;
  let alive = true;
  let run = null;
  let def = null;
  let defNote = "";
  let selected = null;
  let note = "";
  let fetchTimer = null;
  let tick = null;
  let busy = false;

  const headHost = el("div", { class: "wf-run-head" });
  const actHost = el("div", { class: "wf-run-actions" });
  const bannerHost = el("div", {});
  const sideHost = el("aside", { class: "wf-run-side", "aria-label": "Run details" });
  let canvas = null;

  host.append(el("div", { class: "wf-page" }, el("p", { class: "wf-empty" }, "Loading the run…")));

  async function load() {
    try {
      run = await call("run", { id });
      if (!alive) return;
      await loadDef();
      if (!alive) return;
      build();
    } catch (err) {
      if (!alive) return;
      clear(host);
      host.append(el("div", { class: "wf-page" }, el("div", { class: "wf-lib" }, crumbs(ext, [{ label: "Workflows", onClick: go.library }, { label: id }]), el("p", { class: "wf-error" }, err?.message || "The run could not be read."), button(ext, "Back to workflows", { onClick: go.library }))));
    }
  }

  async function loadDef() {
    try {
      const got = await call("get", { id: run.workflow });
      const pub = got?.published;
      const dr = got?.draft;
      if (pub && pub.version === run.version) (def = pub), (defNote = "");
      else if (dr && dr.version === run.version) (def = dr), (defNote = "");
      else {
        def = pub ?? dr ?? null;
        defNote = def ? `This run used v${run.version}; the graph shows v${def.version ?? "?"}, which may differ.` : "";
      }
    } catch {
      def = null;
    }
    if (!def) {
      // The workflow is gone (its runs are kept): draw the steps the run went through, unconnected.
      def = { steps: Object.fromEntries((run.history ?? []).map((h) => [h.step, { type: h.type }])), start: run.history?.[0]?.step };
      defNote = "The workflow's definition could not be read; the graph shows only the steps this run went through.";
    }
  }

  async function refetch() {
    try {
      const next = await call("run", { id });
      if (!alive || !next) return;
      run = next;
      draw();
    } catch {
      /* the next event tries again */
    }
  }

  const unlisten = feed.listen((change) => {
    if (change.kind === "run" && change.run?.id === id) {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(refetch, 400);
    } else if (change.kind === "snapshot" && run) {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(refetch, 400);
    } else if (change.kind === "status") drawBanner();
  });

  /* --- actions ------------------------------------------------------------------------------- */

  async function act(label, op, args, done) {
    if (busy) return;
    busy = true;
    drawActions();
    try {
      run = await call(op, { id, ...args });
      if (done) ext.toast(done, { tone: "ok" });
    } catch (err) {
      ext.toast(err?.message || `${label} failed.`, { tone: "error" });
    } finally {
      busy = false;
      if (alive) {
        await refetch();
        draw();
      }
    }
  }

  function drawActions() {
    clear(actHost);
    if (!run) return;
    if (ACTIVE.has(run.state)) {
      const cancel = button(ext, "Cancel run", { tone: "warn", icon: "x", disabled: busy });
      cancel.addEventListener("click", async () => {
        const ok = await ext.ui.confirm(cancel, { title: "Cancel this run?", lines: [["Run", `${run.name} #${run.number}`], ["Step", run.step ?? "—"]], note: "A running turn is cancelled. The conversations stay; Retry can start it again from any step.", confirmLabel: "Cancel run", tone: "warn" });
        if (ok) act("Cancel", "cancel", {}, "The run is cancelled.");
      });
      actHost.append(cancel);
    }
    if (ENDED.has(run.state)) {
      const choices = retryChoices(run, def);
      const from = el("select", { class: "input", "aria-label": "Retry from step" }, ...choices.map((sid) => el("option", { value: sid }, `from ${def.steps[sid]?.label || sid}`)));
      actHost.append(from, button(ext, "Retry", { icon: "retry", disabled: busy || !choices.length, onClick: () => act("Retry", "retry", from.value ? { from: from.value } : {}, `Queued again from ${from.value}.`) }));
      const forget = button(ext, "Remove from list", { icon: "x", disabled: busy });
      forget.addEventListener("click", async () => {
        const ok = await ext.ui.confirm(forget, { title: "Remove this run from the list?", lines: [["Run", `${run.name} #${run.number}`], ["State", run.state]], note: "Its record is deleted. The conversations it opened stay, and so does anything it committed.", confirmLabel: "Remove", tone: "warn" });
        if (!ok) return;
        try {
          await call("forget", { id });
          ext.toast("The run is removed from the list.", { tone: "ok" });
          go.library();
        } catch (err) {
          ext.toast(err?.message || "The run could not be removed.", { tone: "error" });
        }
      });
      actHost.append(forget);
    }
  }

  function approvalBox() {
    if (run.state !== "waiting") return null;
    const step = def.steps[run.step];
    const entry = [...(run.history ?? [])].reverse().find((h) => h.step === run.step);
    const area = el("textarea", { class: "input", rows: "2", placeholder: "A note for the record (optional)", "aria-label": "Approval note", id: "wf-approve-note" });
    area.value = note;
    area.addEventListener("input", () => (note = area.value));
    const decide = (decision) => act(decision === "approved" ? "Approve" : "Reject", "approve", { decision, ...(note.trim() ? { note: note.trim() } : {}) }, decision === "approved" ? "Approved; the run goes on." : "Rejected.").then(() => (note = ""));
    return el(
      "section",
      { class: "wf-approval", "aria-label": "Waiting for your approval" },
      el("div", { class: "wf-approval-head" }, svgIcon("approval", { size: 16 }), el("strong", {}, `${step?.label || run.step} is waiting for you`)),
      entry?.note ? el("p", { class: "wf-approval-msg" }, entry.note) : step?.message ? el("p", { class: "wf-approval-msg" }, step.message) : null,
      area,
      el("div", { class: "wf-approval-actions" }, button(ext, "Approve", { tone: "primary", icon: "check", disabled: busy, onClick: () => decide("approved") }), button(ext, "Reject", { tone: "warn", icon: "x", disabled: busy, onClick: () => decide("rejected") }))
    );
  }

  /* --- drawing ------------------------------------------------------------------------------- */

  function drawHead() {
    clear(headHost);
    const share = costShare(run);
    const meter = el(
      "div",
      { class: "wf-meter", title: share == null ? "No cap" : `${Math.round(share * 100)}% of the cap` },
      el("span", { class: "wf-meter-text" }, el("strong", {}, money(run.cost)), run.costCapUsd ? ` of ${money(run.costCapUsd)}` : ""),
      share == null ? null : el("span", { class: `wf-meter-bar${share >= 0.8 ? " is-hot" : ""}`, role: "meter", "aria-valuemin": "0", "aria-valuemax": String(run.costCapUsd), "aria-valuenow": String(run.cost ?? 0), "aria-label": "Cost against the cap" }, fill(el("span"), share))
    );
    headHost.append(
      el(
        "header",
        { class: "wf-bar" },
        crumbs(ext, [{ label: "Workflows", onClick: go.library }, { label: run.name || run.workflow, onClick: def?.id ? () => go.editor(run.workflow) : null }, { label: `Run #${run.number ?? "?"}` }]),
        el("div", { class: "wf-bar-version" }, chip(ext, `v${run.version ?? "?"}`, "dim", { mono: true }), stateChip(ext, run.state)),
        el("div", { class: "wf-bar-tools" }, meter, actHost)
      ),
      el("div", { class: "wf-run-input" }, el("span", { class: "wf-field-label" }, "Input"), el("span", { class: "wf-mono wf-run-input-text", title: run.input ?? "" }, run.input || "(empty)"))
    );
    drawActions();
  }

  let bannerKey = "";
  function drawBanner() {
    // Rebuilt only when what it says changes, so the approval note keeps its caret through live updates.
    const key = JSON.stringify([run.state, run.step, run.reason, defNote, feed.status, busy]);
    if (key === bannerKey) return;
    bannerKey = key;
    clear(bannerHost);
    const parts = [];
    const fn = feedNote(ext, feed);
    if (fn) parts.push(fn);
    if (run.reason && run.state !== "running") {
      const tone = run.state === "done" ? "ok" : run.state === "failed" ? "err" : "warn";
      parts.push(el("p", { class: `wf-banner is-${tone}` }, el("strong", {}, `${runLabel(run.state)[0].toUpperCase()}${runLabel(run.state).slice(1)}: `), run.reason));
    }
    if (defNote) parts.push(el("p", { class: "wf-banner is-dim" }, defNote));
    const ap = approvalBox();
    if (ap) parts.push(ap);
    bannerHost.append(...parts);
  }

  /** The latest history entry of a step; a "running" entry of a run that is no longer running is not timed as live. */
  function lastEntry(sid) {
    const h = [...(run.history ?? [])].reverse().find((x) => x.step === sid) ?? null;
    return h && h.status === "running" && run.state !== "running" ? { ...h, status: "cancelled" } : h;
  }

  function entryFacts(h) {
    const parts = [];
    if (h.model) parts.push(h.model);
    const ms = entryMs(h);
    if (ms != null) parts.push(`${duration(ms)}${h.status === "running" ? " so far" : ""}`);
    if (h.cost) parts.push(money(h.cost));
    if (h.toolCalls) parts.push(`${h.toolCalls} tool call${h.toolCalls === 1 ? "" : "s"}`);
    if (h.tokens) parts.push(`${compact(h.tokens)} tok`);
    return parts.join(" · ");
  }

  function decorate(sid, step) {
    const status = statuses[sid] ?? "idle";
    const h = lastEntry(sid);
    const v = run.vars?.[sid];
    const visits = counts[sid] ?? 0;
    let sub = nodeSummary(step, def);
    if (v && step.type === "parse") sub = Object.keys(step.fields ?? {}).map((f) => v[f]).filter((x) => x != null && x !== "").join(" · ") || sub;
    else if (v && step.type === "branch" && v.value != null) sub = `took ${v.value}`;
    else if (v && step.type === "loop" && v.count != null) sub = `${v.count} of max ${step.max ?? "?"}`;
    else if (v && step.type === "approval" && v.decision) sub = v.decision;
    const badge = el("span", { class: `wf-status is-${STATUS_TONE[status]}` }, status === "running" ? el("span", { class: "wf-pulse", "aria-hidden": "true" }) : null, status === "idle" ? "" : STATUS_WORDS[status] + (visits > 1 ? ` ×${visits}` : "")); // "not reached" is the dimming and the legend
    return {
      classes: [`st-${status}`],
      sub,
      badge,
      status: STATUS_WORDS[status],
      chip: step.type === "prompt" ? h?.model || step.model : null,
      meta: h && step.type === "prompt" ? [entryMs(h) != null ? duration(entryMs(h)) : null, h.cost ? money(h.cost) : null, h.toolCalls ? `${h.toolCalls} calls` : null, h.breaches ? `${h.breaches} breach${h.breaches === 1 ? "" : "es"}` : null].filter(Boolean).join(" · ") : null,
    };
  }

  function drawSide() {
    const scroll = sideHost.scrollTop;
    clear(sideHost);
    const history = run.history ?? [];
    sideHost.append(el("div", { class: "wf-section-head" }, el("h2", { class: "wf-h2" }, "Steps"), el("span", { class: "wf-section-note" }, `${history.length} taken`)));
    if (!history.length) sideHost.append(el("p", { class: "wf-empty" }, run.state === "queued" ? "Queued; nothing has run yet." : "No step has run."));
    const lastIndex = new Map(history.map((h, i) => [h.step, i]));
    history.forEach((h, i) => {
      const step = def.steps[h.step] ?? { type: h.type };
      const meta = TYPES[step.type ?? h.type] ?? { label: h.type, tone: "dim" };
      const isLast = lastIndex.get(h.step) === i;
      const st = h.status === "running" && run.state !== "running" ? "cancelled" : h.status ?? "done";
      const v = isLast ? run.vars?.[h.step] : null;
      const card = el(
        "article",
        { class: `wf-entry tone-${meta.tone}${selected === h.step && isLast ? " is-selected" : ""}`, "data-step": h.step, "data-last": isLast ? "1" : null },
        el(
          "div",
          { class: "wf-entry-head" },
          el("span", { class: "wf-node-icon" }, svgIcon(step.type ?? h.type, { size: 13 })),
          el("button", { type: "button", class: "wf-entry-name", onClick: () => selectStep(h.step, false) }, step.label || h.step),
          el("span", { class: `wf-status is-${STATUS_TONE[st] ?? "dim"}` }, st === "running" ? el("span", { class: "wf-pulse", "aria-hidden": "true" }) : null, STATUS_WORDS[st] ?? st)
        ),
        entryFacts({ ...h, status: st }) ? el("p", { class: "wf-entry-facts wf-mono" }, entryFacts({ ...h, status: st })) : null,
        h.breaches ? el("p", { class: "wf-entry-note is-warn" }, `Budget breached ${h.breaches} time${h.breaches === 1 ? "" : "s"}${h.breaches === 1 ? "; nudged" : ""}.`) : null,
        h.note ? el("p", { class: "wf-entry-note" }, h.note) : null,
        v ? varsBlock(step, v) : null,
        activityBlock(h, st === "running"),
        h.conversation ? el("div", { class: "wf-entry-links" }, button(ext, "Open conversation", { icon: "external", onClick: () => ext.conversation.open(h.conversation) })) : null
      );
      sideHost.append(card);
    });
    sideHost.scrollTop = scroll;
  }

  function varsBlock(step, v) {
    const keys = Object.keys(v).filter((k) => v[k] != null && v[k] !== "");
    if (!keys.length) return null;
    const short = keys.filter((k) => k !== "text" && k !== "conversation" && !(step.type === "prompt" && ["cost", "toolCalls", "tokens", "ms"].includes(k)));
    const out = el("div", { class: "wf-vars" });
    if (short.length) out.append(el("dl", { class: "wf-kv" }, ...short.flatMap((k) => [el("dt", { class: "wf-mono" }, k), el("dd", { class: "wf-mono" }, String(v[k]))])));
    if (typeof v.text === "string" && v.text) out.append(el("details", { class: "wf-text" }, el("summary", {}, step.type === "parse" ? "Parsed text" : step.type === "tool" ? "Output" : "Last reply"), el("pre", { class: "wf-pre" }, v.text)));
    return out.childNodes.length ? out : null;
  }

  function activityBlock(h, live) {
    const lines = Array.isArray(h.activity) ? h.activity : [];
    if (!lines.length) return null;
    const list = el("ol", { class: "wf-activity" }, ...lines.slice(live ? -8 : 0).map((line) => el("li", { class: "wf-mono" }, svgIcon("terminal", { size: 11 }), el("span", {}, line))));
    if (live) return el("div", { class: "wf-live" }, el("span", { class: "wf-live-h" }, el("span", { class: "wf-pulse", "aria-hidden": "true" }), "Live · latest tool calls"), list);
    // The run keeps only the last few calls of a step; say so when the step made more.
    const total = Number(h.toolCalls) || lines.length;
    const label = total > lines.length ? `Last ${lines.length} of ${total} tool calls` : `Tool calls (${lines.length})`;
    return el("details", { class: "wf-text" }, el("summary", {}, label), list);
  }

  function selectStep(sid, fromCanvas) {
    selected = sid;
    drawCanvas();
    drawSide();
    const card = sideHost.querySelector(`.wf-entry[data-step="${CSS.escape(sid ?? "")}"][data-last]`);
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (!fromCanvas && sid) canvas.center(sid);
  }

  let statuses = {};
  let counts = {};
  let taken = new Set();

  function drawCanvas() {
    statuses = nodeStatuses(run, def);
    counts = visitCounts(run);
    taken = pathTaken(run);
    canvas.render({ def, selected });
  }

  function draw() {
    if (!alive || !canvas) return;
    drawHead();
    drawBanner();
    drawCanvas();
    drawSide();
    clearInterval(tick);
    if (run.state === "running") tick = setInterval(() => alive && (drawSide(), drawCanvas()), 5000);
  }

  function build() {
    clear(host);
    canvas = createCanvas(ext, {
      readOnly: true,
      label: "Run graph, read-only",
      decorate,
      edgeClass: (e) => (taken.has(`${e.from}>${e.to}`) ? "is-taken" : ""),
      onSelect: (sid) => selectStep(sid, true),
    });
    const legend = el(
      "div",
      { class: "wf-legend", "aria-hidden": "true" },
      el("span", {}, el("i", { class: "is-taken" }), "path taken"),
      el("span", {}, el("i", { class: "is-running" }), "running"),
      el("span", {}, el("i", { class: "is-waiting" }), "waiting"),
      el("span", {}, el("i", { class: "is-failed" }), "failed"),
      el("span", {}, el("i", { class: "is-idle" }), "not reached")
    );
    canvas.node.append(legend);
    host.append(el("div", { class: "wf-editor wf-runview" }, headHost, bannerHost, el("div", { class: "wf-body" }, el("div", { class: "wf-stage" }, canvas.node), sideHost)));
    draw();
  }

  function onKey(e) {
    if (e.key === "Escape" && selected && !document.querySelector(".popover")) {
      e.stopPropagation();
      selectStep(null, true);
    }
  }
  window.addEventListener("keydown", onKey, true);

  load();
  return () => {
    alive = false;
    clearTimeout(fetchTimer);
    clearInterval(tick);
    window.removeEventListener("keydown", onKey, true);
    unlisten();
    canvas?.destroy();
  };
}

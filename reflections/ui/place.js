/* The Reflections place: four tabs over the one `call` command. Conversations lists every archived
 * conversation and every record, with the state and the one button that state wants; a row opens its
 * detail (the reflection, its proposal and findings, Reflect again, Open evidence). Proposals lists every
 * proposed change by where it stands; a row opens its detail (the change as a diff, the trial and its
 * runs, Cancel trial, Adopt, Reject, Retire). Findings lists the problems noticed in packages, by package. Settings has
 * the model, the daily cap, the trial settings and the project switches. Everything is asked again every
 * few seconds while a reflection is queued or running or a trial runs, and every fifteen seconds otherwise,
 * for as long as the place is open; never while the person types in a field of it. Built with ext.dom.el
 * and text only. */

import { folded, lineDiff } from "./diff.js";
import {
  ARMS, GROUPS, adoptButton, canTrial, changeLabel, describe, explain, findingChip, groupFindings, money, plural, proposalChip, runState, seenLine, trialLabel,
} from "./state.js";

const FAST_MS = 3000;
const SLOW_MS = 15000;
const TABS = [["conversations", "Conversations"], ["proposals", "Proposals"], ["findings", "Findings"], ["settings", "Settings"]];

export function openPlace(ext, root, params, { changed = () => {} } = {}) {
  const { el, clear } = ext.dom;
  const call = async (op, args = {}) => (await ext.request("call", { args: { op, ...args } }))?.data;

  let alive = true;
  let tab = TABS.some(([id]) => id === params.tab) ? params.tab : typeof params.proposal === "string" && params.proposal ? "proposals" : "conversations";
  let selected = typeof params.session === "string" && params.session ? params.session : null;
  let picked = typeof params.proposal === "string" && params.proposal ? params.proposal : null;
  let list = null;
  let listError = null;
  let detail = null;
  let detailError = null;
  let proposals = null;
  let proposalsError = null;
  let proposal = null;
  let proposalError = null;
  let findings = null;
  let findingsError = null;
  let settings = null;
  let settingsError = null;
  let showClosed = false;
  let acting = false;
  let typing = false;
  let timer = null;
  const drafts = new Map(); // proposal id -> the request as the person edited it
  const refusals = new Map(); // proposal id -> the sentence the last Adopt was refused with

  const host = el("div", { class: "rfl-root" });
  const tabsHost = el("div", { class: "rfl-tabs", role: "tablist" });
  const body = el("div", { class: "rfl-body" });
  // The shell's place header already says "Reflections"; the head here is the tabs alone.
  host.append(el("div", { class: "rfl-head" }, tabsHost), body);
  root.append(host);

  // ---- loading ----

  /** Asks one op and keeps its answer or its sentence; `still()` says whether the answer is still wanted. */
  async function load(op, args, keep, still = () => true) {
    try {
      const got = await call(op, args);
      if (still()) keep(got, null);
    } catch (err) {
      if (still()) keep(null, err?.message || "This could not be read.");
    }
  }

  const loadList = () => load("list", {}, (got, err) => (err ? (listError = err) : ((list = got), (listError = null))));
  const loadDetail = (s = selected) =>
    load("get", { session: s }, (got, err) => (err ? (detailError = err) : ((detail = got), (detailError = null))), () => s === selected);
  const loadProposals = () => load("proposals", {}, (got, err) => (err ? (proposalsError = err) : ((proposals = got), (proposalsError = null))));
  const loadProposal = (id = picked) =>
    load("proposal", { id }, (got, err) => (err ? (proposalError = err) : ((proposal = got), (proposalError = null))), () => id === picked);
  const loadFindings = () => load("findings", {}, (got, err) => (err ? (findingsError = err) : ((findings = got), (findingsError = null))));
  const loadSettings = () => load("settings", {}, (got, err) => (err ? (settingsError = err) : ((settings = got), (settingsError = null))));

  async function refresh() {
    clearTimeout(timer);
    if (!alive) return;
    if (tab === "settings") await loadSettings();
    else {
      const more = tab === "conversations" ? (selected ? loadDetail() : null) : tab === "proposals" ? (picked ? loadProposal() : loadProposals()) : loadFindings();
      await Promise.all([loadList(), more]);
    }
    if (!alive) return;
    // A redraw would take the field out from under the person typing in it; the next one draws instead.
    if (!typing) draw();
    const active = (list?.items ?? []).some((i) => i.state === "queued" || i.state === "running") || (list?.trialling ?? 0) > 0;
    timer = setTimeout(refresh, active ? FAST_MS : SLOW_MS);
    timer.unref?.();
  }

  /** Runs one change, then reads everything again; the sentence of a refusal becomes a toast unless `onError` keeps it. */
  async function act(work, session, onError) {
    if (acting) return;
    acting = true;
    draw();
    try {
      await work();
    } catch (err) {
      const sentence = err?.message || "That did not work.";
      if (onError) onError(sentence);
      else ext.toast?.(sentence, { tone: "error" });
    } finally {
      acting = false;
      changed(session);
      await refresh();
    }
  }

  const reflect = (s) => act(() => call("reflect", { session: s }), s);
  const cancel = (s) => act(() => call("cancel", { session: s }), s);

  // ---- drawing ----

  function draw() {
    if (!alive) return;
    clear(tabsHost);
    for (const [id, label] of TABS) {
      tabsHost.append(
        el("button", { type: "button", role: "tab", class: `rfl-tab${tab === id ? " is-active" : ""}`, "aria-selected": tab === id ? "true" : "false", onClick: () => go(id) }, label),
      );
    }
    clear(body);
    // A view answers its parts with nulls for what does not apply; `append` would write those as text.
    const parts =
      tab === "proposals" ? (picked ? proposalView() : proposalsView()) : tab === "findings" ? findingsView() : tab === "settings" ? settingsView() : selected ? detailView() : listView();
    body.append(...parts.filter(Boolean));
  }

  /** Opens a tab, and in it a conversation (`session`) or a proposal (`id`). */
  function go(next, { session = null, id = null } = {}) {
    tab = next;
    selected = session;
    picked = id;
    detail = null;
    detailError = null;
    proposal = null;
    proposalError = null;
    typing = false;
    draw();
    void refresh();
  }

  const note = (text, tone = "") => el("p", { class: `rfl-note${tone ? ` is-${tone}` : ""}` }, text);
  const chip = (d) => el("span", { class: `rfl-state is-${d.tone}${d.busy ? " is-busy" : ""}` }, d.label);
  const btn = (label, onClick, tone = "quiet", title, disabled = false) => ext.ui.button(label, { tone, onClick, title, disabled: acting || disabled });
  const section = (title, ...children) => el("section", { class: "rfl-section" }, el("h3", { class: "rfl-h3" }, title), ...children.filter(Boolean));
  // A trajectory is a log, not a document: opened as source, so a "# comment" in a tool's output stays one.
  const openFile = (path, view) => ext.open.place("workspace", view ? { path, view } : { path });
  const openConversation = (s) => ext.conversation?.open?.(s);
  /** Text with `x` spans as code. Built as nodes, so nothing in the text is ever read as markup. */
  const inline = (text, cls = "") => {
    const parts = String(text ?? "").split("`");
    // An odd count of backticks leaves the last one unpaired; it stays as written.
    const out = parts.length % 2 === 0 ? [...parts.slice(0, -2), `${parts.at(-2)}\`${parts.at(-1)}`] : parts;
    return el("span", cls ? { class: cls } : {}, ...out.map((p, i) => (i % 2 ? el("code", { class: "rfl-code" }, p) : p)).filter((p) => p !== ""));
  };
  /** What a proposal changes: the kind in words, the target as code; a guide note is words alone. */
  const kindOf = (e, cls) => {
    const label = changeLabel(e);
    if (e.kind === "skill" || e.kind === "config") {
      const kind = label.slice(0, label.length - String(e.target ?? "").length).trimEnd();
      return el("span", { class: cls }, `${kind} `, el("code", { class: "rfl-code" }, String(e.target ?? "")));
    }
    return el("span", { class: cls }, label);
  };
  const when = (iso) => (iso ? ext.ui.when?.(iso) ?? new Date(iso).toLocaleString() : null);

  /** Asks before a change that touches the person's harness; true when there is no anchor to ask beside. */
  const confirmed = (anchor, options) => (anchor && ext.ui.confirm ? ext.ui.confirm(anchor, options) : Promise.resolve(true));

  // ---- conversations ----

  /** The button a state wants first, or null. */
  function primary(item) {
    const d = describe(item);
    if (d.action === "cancel") return btn("Cancel", () => cancel(item.session), "quiet", "Stop this reflection; nothing it would write is kept");
    if (d.action === "retry") return btn("Retry", () => reflect(item.session), "primary");
    if (d.action === "again") return btn("Reflect again", () => reflect(item.session), "quiet", "Read the conversation again; what it proposed already stays");
    return btn("Reflect", () => reflect(item.session), "primary");
  }

  function spendLine() {
    if (!list?.spend) return null;
    const unknown = list.spend.unknown ? `; ${list.spend.unknown} reported no cost` : "";
    return note(`Today (UTC): ${money(list.spend.usd) || "$0.00"} of the ${money(list.cap)} cap for automatic reflections${unknown}.`);
  }

  function listView() {
    if (listError) return [note(listError, "err")];
    if (!list) return [note("Reading…")];
    const items = list.items ?? [];
    if (!items.length) return [spendLine(), note("Nothing archived yet. When you archive a conversation it is reflected on here.")];
    return [
      spendLine(),
      el(
        "ul",
        { class: "rfl-list" },
        ...items.map((item) => {
          const when_ = item.finishedAt ?? item.updatedAt ?? item.archivedAt;
          const facts = [when_ && ext.ui.when?.(when_), item.gone && "conversation forgotten"].filter(Boolean).join(" · ");
          return el(
            "li",
            { class: "rfl-row" },
            el("button", { type: "button", class: "rfl-row-main", onClick: () => go("conversations", { session: item.session }) }, el("span", { class: "rfl-row-title" }, item.title || item.session), facts ? el("span", { class: "rfl-row-facts" }, facts) : null),
            chip(describe(item)),
            primary(item),
          );
        }),
      ),
    ];
  }

  function detailView() {
    const back = el("button", { type: "button", class: "rfl-back", onClick: () => go("conversations") }, "← All conversations");
    if (detailError) return [back, note(detailError, "err")];
    if (!detail) return [back, note("Reading…")];
    const r = detail.record;
    const facts = [
      ["Model", r.model ?? (r.state === "done" || r.state === "failed" ? "not recorded" : null)],
      ["Cost", typeof r.costUsd === "number" ? money(r.costUsd) : r.model ? "not reported" : null],
      ["Events read", typeof r.events === "number" ? String(r.events) : null],
      ["Finished", r.finishedAt ? new Date(r.finishedAt).toLocaleString() : null],
    ].filter(([, v]) => v);
    const actions = [
      primary(r),
      !detail.gone && ext.conversation?.open ? btn("Open conversation", () => openConversation(r.session)) : null,
      detail.evidence ? btn("Open evidence", () => openFile(detail.evidence, "source"), "quiet", "The files the model read: the mission, the task, the numbered trajectory, the harness it ran with") : null,
    ];
    const p = detail.proposal;
    const found = detail.findings ?? [];
    return [
      back,
      el("div", { class: "rfl-detail-head" }, el("h2", { class: "rfl-h2" }, r.title || r.session), chip(describe(r))),
      note(explain(r), r.state === "failed" ? "err" : ""),
      r.partial ? note(`Partial: ${r.partial}.`, "warn") : null,
      detail.gone ? note("The conversation itself has been forgotten; its reflection stays until you forget it here.") : null,
      facts.length ? ext.ui.kv(facts) : null,
      el("div", { class: "rfl-actions" }, ...actions),
      p ? section("Its proposal", proposalCard(p)) : null,
      found.length ? section(found.length === 1 ? "Its finding" : "Its findings", ...found.map(findingLine)) : null,
      detail.reflection ? el("section", { class: "rfl-section rfl-reflection" }, ...markdown(detail.reflection)) : null,
    ];
  }

  const markdown = (text) => {
    const out = ext.markdown(text);
    return Array.isArray(out) ? out : [out];
  };

  function proposalCard(p) {
    if (p.missing) return note(`Proposal ${p.id} is no longer kept.`);
    return el(
      "div",
      { class: "rfl-card" },
      el("div", { class: "rfl-card-head" }, kindOf(p, "rfl-card-kind"), chip(proposalChip(p))),
      el("p", { class: "rfl-lesson-text" }, inline(p.lesson || p.id)),
      el("div", { class: "rfl-actions" }, btn("Open proposal", () => go("proposals", { id: p.id }))),
    );
  }

  function findingLine(f) {
    if (f.missing) return note(`Finding ${f.id} is no longer kept.`);
    return el(
      "div",
      { class: "rfl-card" },
      el("div", { class: "rfl-card-head" }, el("span", { class: "rfl-card-kind" }, el("code", { class: "rfl-code" }, f.package), " · ", el("code", { class: "rfl-code" }, f.component)), chip(findingChip(f))),
      el("p", { class: "rfl-card-text" }, inline(f.what)),
      el("div", { class: "rfl-actions" }, btn("Open findings", () => go("findings"))),
    );
  }

  // ---- proposals ----

  function proposalsView() {
    if (proposalsError) return [note(proposalsError, "err")];
    if (!proposals) return [note("Reading…")];
    const entries = proposals.entries ?? [];
    if (!entries.length) return [note("No proposals yet. A reflection proposes at most one change, and only when the conversation showed something worth changing.")];
    const out = [note("A proposal changes nothing until you run a trial and adopt it.")];
    for (const g of GROUPS) {
      const items = entries.filter((e) => g.states.includes(e.state)).sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
      if (!items.length) continue;
      if (g.collapsed) {
        const toggle = el("button", { type: "button", class: "rfl-back", "aria-expanded": showClosed ? "true" : "false", onClick: () => ((showClosed = !showClosed), draw()) }, `${showClosed ? "▾" : "▸"} ${g.label} (${items.length})`);
        out.push(el("section", { class: "rfl-section" }, toggle, showClosed ? proposalList(items) : null));
      } else out.push(section(g.label, proposalList(items)));
    }
    return out;
  }

  function proposalList(items) {
    return el(
      "ul",
      { class: "rfl-list" },
      ...items.map((e) => {
        const from = e.from?.length ?? 0;
        const proposed = e.createdAt && ext.ui.when?.(e.createdAt);
        const facts = [`From ${plural(from, "conversation")}`, proposed && `proposed ${proposed}`].filter(Boolean).join(" · ");
        return el(
          "li",
          { class: "rfl-row" },
          el(
            "button",
            { type: "button", class: "rfl-row-main", onClick: () => go("proposals", { id: e.id }) },
            kindOf(e, "rfl-row-kind"),
            inline(e.lesson || e.id, "rfl-row-title"),
            el("span", { class: "rfl-row-facts" }, facts),
          ),
          e.state === "adopted" && e.recheck ? el("span", { class: "rfl-state is-warn" }, "Re-check") : null,
          chip(proposalChip(e)),
        );
      }),
    );
  }

  function proposalView() {
    const back = el("button", { type: "button", class: "rfl-back", onClick: () => go("proposals") }, "← All proposals");
    if (proposalError) return [back, note(proposalError, "err")];
    if (!proposal) return [back, note("Reading…")];
    const e = proposal.entry;
    const facts = [
      ["When", e.cue ? inline(e.cue) : null],
      ["Confidence", e.confidence],
      ["Evidence", e.evidence],
      ["Proposed", e.createdAt ? new Date(e.createdAt).toLocaleString() : null],
    ].filter(([, v]) => v);
    return [
      back,
      el("div", { class: "rfl-detail-head" }, el("h2", { class: "rfl-h2" }, kindOf(e)), chip(proposalChip(e))),
      el("p", { class: "rfl-lesson-text" }, inline(e.lesson || e.id)),
      facts.length ? ext.ui.kv(facts) : null,
      sourcesView(e),
      changeView(e),
      trialView(e),
      decisionView(e),
    ];
  }

  function sourcesView(e) {
    const from = e.from ?? [];
    if (!from.length) return null;
    return section(
      from.length === 1 ? "From one conversation" : `From ${from.length} conversations`,
      el(
        "ul",
        { class: "rfl-list" },
        ...from.map((f) =>
          el(
            "li",
            { class: "rfl-row" },
            el(
              "button",
              { type: "button", class: "rfl-row-main", title: "Its reflection", onClick: () => go("conversations", { session: f.session }) },
              el("span", { class: "rfl-row-title" }, f.title || f.session),
              el("span", { class: "rfl-row-facts" }, [f.rows?.length ? `rows ${f.rows.join(", ")}` : null, f.at && when(f.at), f.gone && "conversation forgotten"].filter(Boolean).join(" · ")),
            ),
            !f.gone && ext.conversation?.open ? btn("Open conversation", () => openConversation(f.session)) : null,
          ),
        ),
      ),
    );
  }

  function changeView(e) {
    const where = e.kind === "skill" && e.path ? note(`Written to ~/${e.path}${e.owner ? `, over the copy from ${e.owner}` : ""}.`) : null;
    let shown;
    if ((e.kind === "skill" || e.kind === "project-instructions") && typeof e.before === "string") {
      shown = diffView(e.before, e.change ?? "");
    } else if (e.kind === "skill" || e.kind === "project-instructions") {
      shown = [note(e.kind === "skill" ? "A new skill:" : "New project instructions:"), el("pre", { class: "rfl-pre" }, e.change ?? "")];
    } else if (e.kind === "guide-note") {
      shown = [note("A line added after the guide, in every conversation:"), el("pre", { class: "rfl-pre" }, e.change ?? "")];
    } else {
      const now = e.before === null || e.before === undefined ? "not set" : e.before;
      shown = [ext.ui.kv([["Setting", e.target ?? ""], ["Now", String(now)], ["Proposed", String(e.change ?? "")]])];
    }
    return section("The change", where, ...[].concat(shown));
  }

  function diffView(before, after) {
    const lines = folded(lineDiff(before, after));
    if (!lines.some((l) => l.op === "+" || l.op === "-")) return [note("The same as what is there now.")];
    return [
      el(
        "pre",
        { class: "rfl-pre rfl-diff" },
        ...lines.map((l) =>
          l.op === "…"
            ? el("span", { class: "rfl-diff-line is-fold" }, `… ${plural(l.count, "unchanged line")}\n`)
            : el("span", { class: `rfl-diff-line${l.op === "+" ? " is-add" : l.op === "-" ? " is-del" : ""}` }, `${l.op} ${l.text}\n`),
        ),
      ),
    ];
  }

  function trialView(e) {
    const t = proposal.trial;
    const parts = [];
    if (e.state === "adopted" && e.recheck) parts.push(note(`Re-check: ${e.recheck.reason}. Run the trial again to see if it still helps.`, "warn"));
    if (e.state === "trialling" && !t?.state) parts.push(note("Starting the trial."));
    else if (t && (e.state === "trialling" || t.state === "queued" || t.state === "running")) parts.push(...runningView(t));
    else if (e.verdict) parts.push(...verdictView(e, t));
    if (canTrial(e).ok && (e.state !== "adopted" || e.recheck)) parts.push(...requestView(e));
    if (!parts.length) return null;
    return section("Trial", note("A trial runs the request with the change and without it, in a copy of your space that is thrown away after. The runs cannot reach the network, Docker or SSH."), ...parts);
  }

  function runningView(t) {
    const queued = t.state === "queued";
    return [
      note(queued ? "Waiting for another trial to finish." : `Running.${typeof t.costUsd === "number" ? ` Spent so far: ${money(t.costUsd)}.` : ""}`),
      runsList(t, { files: false }),
    ];
  }

  function runsList(t, { files }) {
    const runs = t?.runs ?? [];
    if (!runs.length) return null;
    return el(
      "ul",
      { class: "rfl-list" },
      ...runs.map((r) =>
        el(
          "li",
          { class: "rfl-row" },
          el(
            "span",
            { class: "rfl-row-main is-static" },
            el("span", { class: "rfl-row-title" }, `${ARMS[r.arm] ?? r.arm}, run ${r.n}`),
            el("span", { class: "rfl-row-facts" }, [runState(r.state), typeof r.costUsd === "number" ? money(r.costUsd) : null, r.error].filter(Boolean).join(" · ")),
          ),
          files && r.file ? btn("Open run", () => openFile(r.file, "source"), "quiet", "What happened in this run, event by event") : null,
        ),
      ),
    );
  }

  function verdictView(e, t) {
    const v = e.verdict;
    if (!v.result) return [note(`The last trial did not finish: ${v.error ?? "no reason was recorded"}.`, "err")];
    const seen = seenLine(v.seen);
    const cost = typeof v.costUsd === "number" ? `It cost ${money(v.costUsd)}.` : null;
    return [
      el("div", { class: "rfl-detail-head" }, chip(proposalChip(e)), v.at ? el("span", { class: "rfl-row-facts" }, when(v.at)) : null),
      v.why ? note(v.why) : null,
      seen || cost ? note([seen, cost].filter(Boolean).join(" ")) : null,
      e.lastTrial?.why ? note(`A later trial did not finish (${e.lastTrial.why}), so this verdict stands.`, "err") : null,
      runsList(t, { files: true }),
      t?.judge ? el("div", { class: "rfl-actions" }, btn("Open judgement", () => openFile(t.judge), "quiet", "How the runs were graded, without knowing which had the change")) : null,
    ];
  }

  function requestView(e) {
    const req = proposal.request ?? {};
    const original = req.text ?? "";
    const draft = drafts.get(e.id) ?? original;
    const box = el("textarea", { class: "input rfl-request", rows: "4", "aria-label": "The request the trial sends", disabled: acting });
    box.value = draft;
    box.addEventListener("focus", () => (typing = true));
    box.addEventListener("blur", () => {
      typing = false;
    });
    box.addEventListener("input", () => {
      if (box.value === original) drafts.delete(e.id);
      else drafts.set(e.id, box.value);
    });
    const s = proposal.settings ?? {};
    const empty = !draft.trim();
    const hint =
      req.source === "opening request"
        ? original
          ? "The first message of the conversation it came from. Edit it to fit."
          : "The conversation it came from is gone, so write the request."
        : "Written by the reflection to recreate the situation. Edit it to fit.";
    const run = () => {
      const text = drafts.get(e.id);
      return act(async () => {
        await call("trial", { id: e.id, ...(text !== undefined && text.trim() ? { request: text } : {}) });
        drafts.delete(e.id);
      });
    };
    return [
      ext.ui.field("Request", box, hint),
      note("The trial runs on your files as they are now, not as they were in the conversation. Edit the request if it depends on how things were."),
      el("div", { class: "rfl-actions" }, btn(trialLabel(e, s), run, e.verdict ? "quiet" : "primary", "Costs up to the trial cap in Settings", empty)),
      empty ? note("Write a request first.") : null,
    ];
  }

  function decisionView(e) {
    const adopt = adoptButton(e);
    const refusal = refusals.get(e.id);
    const buttons = [];
    if (e.state === "trialling") buttons.push(btn("Stop trial", (event) => doCancelTrial(e, event?.currentTarget), "quiet", "Stop the runs; what they spent so far is spent"));
    if (adopt) buttons.push(btn(adopt.label, (event) => doAdopt(e, event?.currentTarget), adopt.label === "Adopt" ? "primary" : "quiet", adopt.reason ?? undefined, adopt.disabled));
    if (e.state === "proposed" || e.state === "trialled") buttons.push(btn("Reject", (event) => doReject(e, event?.currentTarget)));
    if (e.state === "adopted") buttons.push(btn("Retire", (event) => doRetire(e, event?.currentTarget), "quiet", "Undo the change: what was there before comes back"));
    const said =
      e.state === "adopted"
        ? note(`Adopted${e.applied?.at ? ` ${when(e.applied.at)}` : ""}. It is in every conversation it applies to.`)
        : e.state === "rejected"
          ? note("Rejected. It stays here so it is not proposed again.")
          : e.state === "retired"
            ? note("Retired. What was there before it came back.")
            : null;
    if (!buttons.length && !said) return null;
    return el(
      "div",
      { class: "rfl-section" },
      said,
      buttons.length ? el("div", { class: "rfl-actions" }, ...buttons) : null,
      adopt?.disabled ? note(adopt.reason) : null,
      refusal ? note(refusal, "err") : null,
    );
  }

  async function doAdopt(e, anchor) {
    const ok = await confirmed(anchor, {
      title: "Adopt this change?",
      lines: [["Change", changeLabel(e)], ...(e.verdict?.result ? [["Trial", e.verdict.result]] : [])],
      note: "It is written to your space now and used from the next message on. Retire undoes it.",
      confirmLabel: e.verdict?.result?.startsWith("helped") ? "Adopt" : "Adopt anyway",
    });
    if (!ok) return;
    refusals.delete(e.id);
    await act(() => call("adopt", { id: e.id }), null, (sentence) => refusals.set(e.id, sentence));
  }

  async function doCancelTrial(e, anchor) {
    const ok = await confirmed(anchor, { title: "Stop this trial?", lines: [["Change", changeLabel(e)]], note: "The runs stop. What they spent so far is spent. The proposal goes back to where it was.", confirmLabel: "Stop the trial", tone: "warn" });
    if (!ok) return;
    refusals.delete(e.id);
    await act(() => call("trial-cancel", { id: e.id }), null, (sentence) => refusals.set(e.id, sentence));
  }

  async function doReject(e, anchor) {
    const ok = await confirmed(anchor, { title: "Reject this proposal?", lines: [["Change", changeLabel(e)]], note: "Nothing changes. It stays listed under Rejected, so it is not proposed again.", confirmLabel: "Reject", tone: "warn" });
    if (ok) await act(() => call("reject", { id: e.id }));
  }

  async function doRetire(e, anchor) {
    const ok = await confirmed(anchor, { title: "Retire this change?", lines: [["Change", changeLabel(e)]], note: "What was there before it comes back.", confirmLabel: "Retire", tone: "warn" });
    if (ok) await act(() => call("retire", { id: e.id }));
  }

  // ---- findings ----

  function findingsView() {
    const intro = note("Problems with packages that reflections noticed. They are never shown to the assistant.");
    if (findingsError) return [intro, note(findingsError, "err")];
    if (!findings) return [intro, note("Reading…")];
    const all = findings.findings ?? [];
    if (!all.length) return [intro, note("None yet.")];
    return [intro, ...groupFindings(all).map(([name, items]) => section(name, ...items.map(findingCard)))];
  }

  function findingCard(f) {
    const seen = f.seen ?? [];
    return el(
      "div",
      { class: "rfl-card" },
      el("div", { class: "rfl-card-head" }, chip(findingChip(f)), el("code", { class: "rfl-code rfl-card-kind" }, f.component)),
      el("p", { class: "rfl-card-text" }, inline(f.what)),
      seen.length
        ? el(
            "ul",
            { class: "rfl-list" },
            ...seen.map((x) =>
              el(
                "li",
                { class: "rfl-row" },
                el(
                  "button",
                  { type: "button", class: "rfl-row-main", title: "Its reflection", onClick: () => go("conversations", { session: x.session }) },
                  el("span", { class: "rfl-row-title" }, x.title || x.session),
                  el("span", { class: "rfl-row-facts" }, [x.version && `version ${x.version}`, x.at && when(x.at), x.gone && "conversation forgotten"].filter(Boolean).join(" · ")),
                ),
                !x.gone && ext.conversation?.open ? btn("Open conversation", () => openConversation(x.session)) : null,
              ),
            ),
          )
        : null,
      f.state !== "closed" ? el("div", { class: "rfl-actions" }, btn("Close", () => act(() => call("finding-close", { id: f.id })), "quiet", "Fixed, or not worth fixing. It opens again if it is seen in a newer version.")) : null,
    );
  }

  // ---- settings ----

  function settingsView() {
    if (settingsError) return [note(settingsError, "err")];
    if (!settings) return [note("Reading…")];
    const s = settings;
    const set = (key, value) => act(async () => {
      settings = await call("set-setting", { key, value });
    });

    const modelPicker = (value, defaultLabel, key) => {
      const select = el("select", { class: "input", disabled: acting });
      select.append(el("option", { value: "" }, defaultLabel));
      const ids = new Set();
      for (const m of s.models ?? []) {
        ids.add(m.id);
        select.append(el("option", { value: m.id }, m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id));
      }
      if (value && !ids.has(value)) select.append(el("option", { value }, `${value} (not offered now)`));
      select.value = value || "";
      select.addEventListener("change", () => set(key, select.value || null));
      return select;
    };
    const numberInput = (key, value, { min = "0", step = "1", whole = false, valid = (v) => v >= 0 } = {}) => {
      const input = el("input", { class: "input rfl-num", type: "number", min, step, disabled: acting });
      input.value = String(value);
      input.addEventListener("focus", () => (typing = true));
      input.addEventListener("blur", () => {
        typing = false;
      });
      input.addEventListener("change", () => {
        const v = whole ? Math.floor(Number(input.value)) : Number(input.value);
        if (Number.isFinite(v) && valid(v)) set(key, v);
      });
      return input;
    };

    const model = modelPicker(s.model, `Server default${s.serverDefault ? ` (${s.serverDefault})` : ""}`, "model");
    const cap = numberInput("dailyCostUsd", s.dailyCostUsd, { step: "0.5" });
    const turns = numberInput("minTurns", s.minTurns, { whole: true });
    const enabled = el("input", { type: "checkbox", disabled: acting });
    enabled.checked = s.enabled;
    enabled.addEventListener("change", () => set("enabled", enabled.checked));

    const trialModel = modelPicker(s.trialModel, "The model the conversation used", "trialModel");
    const runs = numberInput("trialRuns", s.trialRuns, { min: "1", whole: true, valid: (v) => v >= 1 && v <= 5 });
    runs.setAttribute("max", "5");
    const trialCost = numberInput("trialCostUsd", s.trialCostUsd, { step: "0.5", valid: (v) => v > 0 });
    const minutes = numberInput("trialMinutes", s.trialMinutes, { min: "1", valid: (v) => v > 0 });
    const scratch = numberInput("trialScratchMb", s.trialScratchMb, { min: "256", step: "256", whole: true, valid: (v) => v > 0 });

    const unknown = s.spend?.unknown ? ` ${s.spend.unknown} reported no cost, so the cap cannot see them.` : "";
    const projects = (s.projects ?? []).map((p) => {
      const box = el("input", { type: "checkbox", disabled: acting || !s.enabled });
      box.checked = p.enabled;
      box.addEventListener("change", () => act(async () => {
        settings = await call("project-switch", { project: p.id, enabled: box.checked });
      }));
      return el("label", { class: "rfl-check" }, box, ` ${p.name}`);
    });

    return [
      ext.ui.card(
        "Reflection",
        ext.ui.field("Reflection model", model, "The model that reflects. It reads the whole conversation once, so a stronger model proposes better changes."),
        s.modelsError ? note(`The model list could not be read: ${s.modelsError}`, "err") : null,
        el("label", { class: "rfl-check" }, enabled, " Reflect when I archive a conversation"),
        ext.ui.field("Shortest conversation reflected", turns, "Fewer of your messages than this, and an archive is marked Skipped: too short. Reflect still runs it."),
      ),
      ext.ui.card(
        "Daily cap",
        ext.ui.field("US dollars a day", cap, "Automatic reflections stop for the day (UTC) once this much is spent. Reflect, pressed by you, runs past it."),
        note(`Spent today: ${money(s.spend?.usd ?? 0) || "$0.00"} of ${money(s.dailyCostUsd)}.${unknown}`),
      ),
      ext.ui.card(
        "Trials",
        ext.ui.field("Runs each way", runs, "A trial runs the request this many times with the change and as many without it. From 1 to 5."),
        ext.ui.field("Most a trial may spend, US dollars", trialCost, "The runs stop once a trial has spent this much. Trials run only when you press Run trial."),
        ext.ui.field("Minutes per run", minutes, "A run still going after this long is stopped."),
        ext.ui.field("Memory for a run's changes, MB", scratch, "A run's writes are kept in memory and thrown away after. A run that writes more than this fails."),
        ext.ui.field("Trial model", trialModel, "The model the runs use."),
      ),
      ext.ui.card(
        "Projects",
        projects.length ? note(s.enabled ? "Reflect automatically when a conversation in this project is archived:" : "Automatic reflection is off, so these switches wait until it is on again.") : note("No projects. Conversations in no project are reflected on when the switch above is on."),
        ...projects,
      ),
    ];
  }

  draw();
  void refresh();

  return () => {
    alive = false;
    clearTimeout(timer);
  };
}

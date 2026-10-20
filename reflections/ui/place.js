/* The Reflections place: three tabs over the one `call` command. Conversations lists every archived
 * conversation and every record, with the state and the one button that state wants; a row opens its
 * detail (the reflection, its lessons, Reflect again, Open evidence, Forget lesson). Lessons lists every
 * lesson by scope with its source. Settings has the model picker, the daily cap with today's spend, and
 * the switches. Everything is asked again every few seconds while something is queued or running, and
 * every fifteen seconds otherwise, for as long as the place is open. Built with ext.dom.el and text only. */

import { describe, explain, money } from "./state.js";

const FAST_MS = 3000;
const SLOW_MS = 15000;

export function openPlace(ext, root, params, { changed = () => {} } = {}) {
  const { el, clear } = ext.dom;
  const call = async (op, args = {}) => (await ext.request("call", { args: { op, ...args } }))?.data;

  let alive = true;
  let tab = "conversations";
  let selected = typeof params.session === "string" && params.session ? params.session : null;
  let list = null;
  let listError = null;
  let detail = null;
  let detailError = null;
  let settings = null;
  let settingsError = null;
  let acting = false;
  let timer = null;

  const host = el("div", { class: "rfl-root" });
  const tabsHost = el("div", { class: "rfl-tabs", role: "tablist" });
  const body = el("div", { class: "rfl-body" });
  host.append(el("div", { class: "rfl-head" }, el("h1", { class: "rfl-h1" }, "Reflections"), tabsHost), body);
  root.append(host);

  // ---- loading ----

  async function loadList() {
    try {
      list = await call("list");
      listError = null;
    } catch (err) {
      listError = err?.message || "The reflections could not be listed.";
    }
  }

  async function loadDetail() {
    if (!selected) return;
    const s = selected;
    try {
      const got = await call("get", { session: s });
      if (s === selected) {
        detail = got;
        detailError = null;
      }
    } catch (err) {
      if (s === selected) detailError = err?.message || "This reflection could not be read.";
    }
  }

  async function loadSettings() {
    try {
      settings = await call("settings");
      settingsError = null;
    } catch (err) {
      settingsError = err?.message || "The settings could not be read.";
    }
  }

  async function refresh() {
    clearTimeout(timer);
    if (!alive) return;
    if (tab === "settings") await loadSettings();
    else await Promise.all([loadList(), tab === "conversations" && selected ? loadDetail() : null]);
    if (!alive) return;
    draw();
    const active = (list?.items ?? []).some((i) => i.state === "queued" || i.state === "running");
    timer = setTimeout(refresh, active ? FAST_MS : SLOW_MS);
    timer.unref?.();
  }

  /** Runs one change, then reads everything again; the sentence of a refusal becomes a toast. */
  async function act(work, session) {
    if (acting) return;
    acting = true;
    draw();
    try {
      await work();
    } catch (err) {
      ext.toast?.(err?.message || "That did not work.", { tone: "error" });
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
    for (const [id, label] of [["conversations", "Conversations"], ["lessons", "Lessons"], ["settings", "Settings"]]) {
      tabsHost.append(
        el("button", { type: "button", role: "tab", class: `rfl-tab${tab === id ? " is-active" : ""}`, "aria-selected": tab === id ? "true" : "false", onClick: () => go(id) }, label),
      );
    }
    clear(body);
    // A view answers its parts with nulls for what does not apply; `append` would write those as text.
    const parts = tab === "lessons" ? lessonsView() : tab === "settings" ? settingsView() : selected ? detailView() : listView();
    body.append(...parts.filter(Boolean));
  }

  function go(next, session = null) {
    tab = next;
    selected = session;
    detail = null;
    detailError = null;
    draw();
    void refresh();
  }

  const note = (text, tone = "") => el("p", { class: `rfl-note${tone ? ` is-${tone}` : ""}` }, text);
  const chip = (d) => el("span", { class: `rfl-state is-${d.tone}${d.busy ? " is-busy" : ""}` }, d.label);
  const btn = (label, onClick, tone = "quiet", title) => ext.ui.button(label, { tone, onClick, title, disabled: acting });

  /** The button a state wants first, or null. */
  function primary(item) {
    const d = describe(item, { lessons: item.lessons ?? 0 });
    if (d.action === "cancel") return btn("Cancel", () => cancel(item.session), "quiet", "Stop this reflection; nothing it would write is kept");
    if (d.action === "retry") return btn("Retry", () => reflect(item.session), "primary");
    if (d.action === "again") return btn("Reflect again", () => reflect(item.session), "quiet", "Read the conversation again; the lessons it already gave stay");
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
    if (!items.length) return [spendLine(), note("Nothing archived yet. When you archive a conversation it is reflected on here, and what it taught is kept as a lesson.")];
    return [
      spendLine(),
      el(
        "ul",
        { class: "rfl-list" },
        ...items.map((item) => {
          const d = describe(item, { lessons: item.lessons ?? 0 });
          const when = item.finishedAt ?? item.updatedAt ?? item.archivedAt;
          const facts = [when && ext.ui.when?.(when), item.gone && "conversation forgotten"].filter(Boolean).join(" · ");
          return el(
            "li",
            { class: "rfl-row" },
            el("button", { type: "button", class: "rfl-row-main", onClick: () => go("conversations", item.session) }, el("span", { class: "rfl-row-title" }, item.title || item.session), facts ? el("span", { class: "rfl-row-facts" }, facts) : null),
            chip(d),
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
    const lessons = detail.lessons ?? [];
    const d = describe(r, { lessons: lessons.filter((l) => l.present).length });
    const facts = [
      ["Model", r.model ?? (r.state === "done" || r.state === "failed" ? "not recorded" : null)],
      ["Cost", typeof r.costUsd === "number" ? money(r.costUsd) : r.model ? "not reported" : null],
      ["Events read", typeof r.events === "number" ? String(r.events) : null],
      ["Finished", r.finishedAt ? new Date(r.finishedAt).toLocaleString() : null],
    ].filter(([, v]) => v);
    const actions = [
      primary({ ...r, lessons: lessons.length }),
      !detail.gone && ext.conversation?.open ? btn("Open conversation", () => ext.conversation.open(r.session)) : null,
      detail.evidence ? btn("Open evidence", () => ext.open.place("workspace", { path: detail.evidence }), "quiet", "The files the model read: the mission, the task, the numbered trajectory") : null,
    ];
    return [
      back,
      el("div", { class: "rfl-detail-head" }, el("h2", { class: "rfl-h2" }, r.title || r.session), chip(d)),
      note(explain(r), r.state === "failed" ? "err" : ""),
      r.partial ? note(`Partial: ${r.partial}.`, "warn") : null,
      detail.gone ? note("The conversation itself has been forgotten; its reflection stays until you forget it here.") : null,
      facts.length ? ext.ui.kv(facts) : null,
      el("div", { class: "rfl-actions" }, ...actions),
      lessons.length ? el("section", { class: "rfl-section" }, el("h3", { class: "rfl-h3" }, lessons.length === 1 ? "Its lesson" : "Its lessons"), ...lessons.map(lessonCard)) : null,
      detail.reflection ? el("section", { class: "rfl-section rfl-reflection" }, ...markdown(detail.reflection)) : null,
    ];
  }

  const markdown = (text) => {
    const out = ext.markdown(text);
    return Array.isArray(out) ? out : [out];
  };

  function lessonCard(l, { source = false } = {}) {
    const from = !source ? null : l.from && l.fromTitle ? el("button", { type: "button", class: "rfl-link", onClick: () => go("conversations", l.from) }, l.fromTitle) : el("span", { class: "rfl-faint" }, "forgotten");
    return el(
      "div",
      { class: "rfl-lesson" },
      el("p", { class: "rfl-lesson-text" }, l.lesson || l.id),
      el("p", { class: "rfl-lesson-facts" }, el("span", { class: "rfl-mono" }, l.id), source ? " · from " : null, from, l.present ? null : " · removed from your skills"),
      el(
        "div",
        { class: "rfl-actions" },
        l.present ? btn("Open skill", () => ext.open.place("workspace", { path: `~/${l.path}` })) : null,
        btn("Forget lesson", (event) => forgetLesson(l, event?.currentTarget)),
      ),
    );
  }

  async function forgetLesson(l, anchor) {
    const ok = anchor && ext.ui.confirm ? await ext.ui.confirm(anchor, { title: "Forget this lesson?", lines: [["Lesson", l.lesson || l.id]], note: "The skill is deleted from your home. The reflection it came from stays.", confirmLabel: "Forget lesson", tone: "warn" }) : true;
    if (ok) await act(() => call("forget-lesson", { id: l.id }), l.from);
  }

  function lessonsView() {
    if (listError) return [note(listError, "err")];
    if (!list) return [note("Reading…")];
    const lessons = list.lessons ?? [];
    if (!lessons.length) return [note("No lessons yet. A reflection keeps at most one, and only when the conversation showed something that transfers.")];
    const groups = new Map();
    for (const l of lessons) groups.set(l.scopeName, [...(groups.get(l.scopeName) ?? []), l]);
    return [
      note("Lessons are skills under skills/lessons in your home. A project's lessons are seen only in that project's conversations."),
      ...[...groups].map(([name, items]) => el("section", { class: "rfl-section" }, el("h3", { class: "rfl-h3" }, name), ...items.map((l) => lessonCard(l, { source: true })))),
    ];
  }

  function settingsView() {
    if (settingsError) return [note(settingsError, "err")];
    if (!settings) return [note("Reading…")];
    const s = settings;
    const set = (key, value) => act(async () => {
      settings = await call("set-setting", { key, value });
    });

    const model = el("select", { class: "input", disabled: acting });
    const def = el("option", { value: "" }, `Server default${s.serverDefault ? ` (${s.serverDefault})` : ""}`);
    model.append(def);
    const ids = new Set();
    for (const m of s.models ?? []) {
      ids.add(m.id);
      model.append(el("option", { value: m.id }, m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id));
    }
    if (s.model && !ids.has(s.model)) model.append(el("option", { value: s.model }, `${s.model} (not offered now)`));
    model.value = s.model || "";
    model.addEventListener("change", () => set("model", model.value || null));

    const cap = el("input", { class: "input rfl-num", type: "number", min: "0", step: "0.5", disabled: acting });
    cap.value = String(s.dailyCostUsd);
    cap.addEventListener("change", () => {
      const v = Number(cap.value);
      if (Number.isFinite(v) && v >= 0) set("dailyCostUsd", v);
    });
    const turns = el("input", { class: "input rfl-num", type: "number", min: "0", step: "1", disabled: acting });
    turns.value = String(s.minTurns);
    turns.addEventListener("change", () => {
      const v = Math.floor(Number(turns.value));
      if (Number.isFinite(v) && v >= 0) set("minTurns", v);
    });
    const enabled = el("input", { type: "checkbox", disabled: acting });
    enabled.checked = s.enabled;
    enabled.addEventListener("change", () => set("enabled", enabled.checked));

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
        ext.ui.field("Model", model, "The model that reflects. Reflection reads the whole conversation once, so a stronger model writes better lessons."),
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

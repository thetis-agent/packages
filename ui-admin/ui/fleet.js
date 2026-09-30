/* Every extension in every workspace, in three views of one `fleet` answer, each saying what the Extensions
 * place says to the admin reading it (`rows.js`'s `placeOf`, the place's own function):
 *
 * - `simple` is Extensions → All extensions: what is installed for the reader, one row per card the place draws
 *   ("16 installed · 20 part of Thetis", the place's numbers), with "everywhere" and "needs attention" one chip
 *   away; the columns every extension list uses: Extension (its label and publisher line), its chips (the place's,
 *   Needs setup from the reader's own settings), Version, and What it does (the place's one plain line).
 * - `parts` is Extensions → Part of Thetis: the parts that make Thetis run, the ones nobody has included.
 * - `full` is Extensions → Who has what ("Every extension and which people have it."): the same rows with a
 *   column per person, each cell the version that person runs; a workspace that has not reloaded onto the disk's
 *   version says "Waiting for a reload" with a button that reloads that person's workspace, drained; `_system` is
 *   "Thetis itself", and the table scrolls inside its box. The counters (up to date, update available, waiting for
 *   a reload, customized copies, needs setup) filter the table when clicked; the filters are the place's kinds
 *   (Tools · Skills · Pages · Models · Background).
 *
 * Two actions. "Update N extensions" installs each extension whose registry holds a newer commit than its
 * pin, behind one confirm that lists them. "Reload N people's workspaces" restarts the workspaces that have not
 * reloaded onto the code on disk, one at a time, the admin's own last, each drained: running replies stop at a
 * safe point and continue by themselves. Nobody is skipped silently: the page keeps one line per person saying
 * what became of theirs. A row opens that extension's page through `onOpen`. */

import { reloadWorkspace, outcomeSentence, updatingSentence } from "./workspaces.js";
import { failedCard, toastError } from "./failed.js";
import { agentName, FILTERS, kindsOf, labelOf } from "./state.js";
import { chipBadges } from "./words.js";
import { described, placeOf, rowFromFleet, rowsFromFleet } from "./rows.js";

/** The label a person reads for a fleet row. */
const labelOfRow = (p) => labelOf(rowFromFleet(p));

const SHOW = [["mine", "installed for you"], ["everything", "everywhere"], ["drift", "needs attention"]];
/** The system workspace's column: the one that is nobody's, where the model providers and the sign-in page live. */
export const systemColumn = () => `${agentName()} itself`;
const GROUP = [["scope", "who gets it"], ["kind", "kind"], ["none", "none"]];
// `everyone` is an extension everyone gets by default; `system` one only the system workspace holds (a
// provider, the sign-in page); `some` is everything else.
const scopeLabel = (key) => ({ everyone: "For everyone", system: `${agentName()} itself only`, some: "Some people" })[key];

/**
 * The counters over Who has what, each a filter of the table: `[id, label, tone, test(p)]`. "update available"
 * is a real newer version (a registry's newer commit), never a workspace that has not reloaded, which is "waiting
 * for a reload"; "customized copies" counts copies, one per person who has one.
 */
export const TILES = Object.freeze([
  ["current", "up to date", "ok", (p) => p.state === "current"],
  ["updates", "update available", "warn", (p) => p.registry?.update?.apply === "install"],
  ["waiting", "waiting for a reload", "warn", (p) => (p.waiting ?? []).length > 0],
  ["forks", "customized copies", null, (p) => Object.values(p.byUser ?? {}).some((c) => c.fork || c.forkOf)],
  ["broken", "needs setup", "err", (p) => Boolean(p.config?.broken) || Object.values(p.byUser ?? {}).some((c) => c.broken && !c.fork)],
]);

/** What a person's cell says about an extension there: none, broken, waiting (for a reload), fork, or current. */
export function cellState(entry) {
  if (!entry) return "none";
  if (entry.broken) return "broken";
  if (entry.state === "update") return "waiting";
  if (entry.fork || entry.forkOf) return "fork";
  return "current";
}

/** Whose, said to the reader: "your", "sam's", "Thetis's". */
export const whose = (who, me) => (who === me ? "your" : who === "_system" ? `${agentName()}'s` : `${who}'s`);

/** "Reload sam's workspace", "Reload your workspace", "Reload Thetis itself". */
export const reloadLabel = (who, me) => (who === "_system" ? `Reload ${agentName()} itself` : `Reload ${whose(who, me)} workspace`);

/**
 * A cell's words: `{ text, title }`. A workspace that has not reloaded onto the disk's version is waiting for a
 * reload -- "sam's Web Gateway (0.16.2 is ready once the workspace restarts)" -- never "update ready", and never
 * "runs X, X is on disk"; a customized copy is "your customized copy" to its owner.
 */
export function cellWords(entry, { who, me, label }) {
  const state = cellState(entry);
  if (state === "none") return { text: "—", title: "Doesn't have it" };
  const version = entry.version ?? "?";
  if (state === "waiting") return { text: "Waiting for a reload", title: `${whose(who, me) === "your" ? "Your" : whose(who, me)} ${label} (${version} is ready once the workspace restarts)` };
  if (state === "broken") return { text: version, title: `${who === me ? "You" : who === "_system" ? systemColumn() : who}: needs setup — a setting is missing` };
  if (state === "fork") return { text: version, note: "customized copy", title: `${who === me ? "Your" : whose(who, me)} customized copy${entry.forkOf ? ` (${entry.forkOf})` : ""}` };
  return { text: version, title: "Up to date" };
}

/** A row worth a look: an update ready (to install or to reload) or a setting missing somewhere. A copy of one's own is not a problem. */
export function drifts(pkg) {
  if (pkg.state === "update" || pkg.registry?.update || pkg.config?.broken) return true;
  return Object.values(pkg.byUser ?? {}).some((e) => e.state === "update" || e.broken);
}

/**
 * The workspaces that have not reloaded onto the code on disk, with what each one has not applied. The admin's
 * own comes last, because restarting it closes the workspace that serves this page. A copy's cell in its
 * original's row is skipped: it is the same copy, already listed under its own name.
 */
export function workspacesBehind(packages, me) {
  const byUser = new Map();
  for (const p of packages) {
    for (const [who, c] of Object.entries(p.byUser ?? {})) {
      if (c?.state !== "update" || c.fork) continue;
      if (!byUser.has(who)) byUser.set(who, []);
      byUser.get(who).push({ name: p.name, loaded: c.loaded ?? c.version, onDisk: c.version });
    }
  }
  return [...byUser.entries()]
    .map(([user, changed]) => ({ user, changed: changed.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => (a.user === me ? 1 : b.user === me ? -1 : a.user.localeCompare(b.user)));
}

/** The extensions installed for the person reading, as the server counts them. */
export const installedForMe = (packages) => packages.filter((p) => p.mine);

/**
 * The rows that pass the filters, in the order they came. `show`: `mine` keeps what is installed for the reader,
 * `drift` what needs attention, `everything` all; a counter's id (`current`, `updates`, `waiting`, `forks`,
 * `broken`) keeps what it counts. `kind` is one of the place's kinds ("Tools", "Page", …). What nobody has is only
 * on the Part of Thetis page and in the tree.
 */
export function filterRows(packages, { query = "", kind = "", show = "everything" }) {
  const q = query.trim().toLowerCase();
  const tile = TILES.find(([id]) => id === show);
  return packages.filter((p) => {
    if (p.nobody) return false;
    if (kind && !kindsOf(rowFromFleet(p)).includes(kind)) return false;
    if (show === "mine" && !p.mine) return false;
    if (show === "drift" && !drifts(p)) return false;
    if (tile && !tile[3](p)) return false;
    if (q && !`${p.name} ${labelOfRow(p)} ${p.type} ${p.summary ?? ""} ${p.description ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** The rows in their groups, each group `[label, rows]`, in a stable order for the chosen grouping. */
export function groupRows(rows, group) {
  if (group === "none") return [[null, rows]];
  const keyOf = (p) => (group === "kind" ? kindsOf(rowFromFleet(p))[0] || "Other" : p.scope || "some");
  const labelOf = (key) => (group === "scope" ? scopeLabel(key) ?? key : FILTERS.find((f) => f.id === key)?.label ?? key);
  const order = group === "scope" ? ["everyone", "system", "some"] : [...FILTERS.map((f) => f.id).filter(Boolean), "Other"];
  const groups = new Map();
  for (const p of rows) {
    const key = keyOf(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return order.filter((k) => groups.has(k)).map((k) => [labelOf(k), groups.get(k)]);
}

export function mountFleet(ext, root, { refresh, onOpen, user, mode = "full" } = {}) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, confirm, heading, put } = ext.ui;
  const full = mode === "full";
  const parts = mode === "parts";
  const title = () => (full ? "Who has what" : parts ? `Part of ${agentName()}` : "All extensions");
  let alive = true;
  let people = [];
  let packages = [];
  let stats = null;
  let failed = null;
  let report = null; // [{ user, text, bad }]: what a reload did, one line per person
  let updating = false; // an update of Thetis is installing: reloading waits for it
  let marked = null; // the row a click marked when nothing opens a page
  const filters = { query: "", kind: "", show: full ? "everything" : "mine", group: full ? "scope" : "none" };
  const wrap = el("div", { class: "panel-col ua-fleet" });
  root.append(el("div", { class: "panel-cols ua-fleet-cols" }, wrap));

  async function load() {
    const stop = busy(wrap, full ? "Reading every workspace…" : "Reading the extensions…");
    try {
      const [out, check] = await Promise.all([ext.request("fleet"), ext.request("update-check", { args: { fetch: false } }).catch(() => null)]);
      updating = Boolean(check?.data?.updating);
      people = Array.isArray(out?.data?.people) ? out.data.people : [];
      packages = Array.isArray(out?.data?.packages) ? out.data.packages : [];
      stats = out?.data?.stats && typeof out.data.stats === "object" ? out.data.stats : null;
      failed = null;
    } catch (err) {
      failed = err;
    } finally {
      stop();
    }
    if (alive) draw();
  }

  /** The people with a column: everyone listed, and `_system` only when a row has it. */
  function columns() {
    const named = people.map((p) => p.user);
    const seen = new Set(packages.flatMap((p) => Object.keys(p.byUser ?? {})));
    const cols = named.filter((u) => u !== "_system");
    if (seen.has("_system") || named.includes("_system")) cols.push("_system");
    return cols;
  }

  /** The install kind of update: the registry holds a newer commit than the pin, and an install moves to it. */
  const toInstall = () => packages.filter((p) => p.registry?.update?.apply === "install");

  async function installAll(anchor) {
    const list = toInstall();
    if (!list.length) return;
    const ok = await confirm(anchor, {
      title: `Update ${list.length} ${list.length === 1 ? "extension" : "extensions"}?`,
      lines: list.map((p) => [labelOfRow(p), `${p.version} → ${p.registry.version}`]),
      note: "Each one is installed from the commit its registry holds now. The people who have it get it the next time their workspace reloads.",
      confirmLabel: "Update",
    });
    if (!ok || !alive) return;
    anchor.disabled = true;
    let done = 0;
    try {
      for (const p of list) {
        await ext.request("package-update", { args: { name: p.name } });
        done += 1;
      }
      ext.toast(`${done} ${done === 1 ? "extension" : "extensions"} updated.`, { tone: "good" });
    } catch (err) {
      toastError(ext, err, `${list[done] ? labelOfRow(list[done]) : "update"}${done ? ` (${done} updated before it)` : ""}`);
    } finally {
      if (alive) anchor.disabled = false;
    }
    refresh?.();
    await load();
  }

  /**
   * Restarts the workspaces in `list` (all that have not reloaded onto the code on disk, or one person's), drained,
   * one at a time, the admin's own last. Every person gets a line in the report, whatever became of theirs: a
   * refusal names the workspace and the rest still go.
   */
  async function reloadAll(anchor, list = workspacesBehind(packages, user)) {
    if (!list.length) return;
    const one = list.length === 1;
    const ok = await confirm(anchor, {
      title: one ? `${reloadLabel(list[0].user, user)}?` : `Reload ${list.length} people's workspaces?`,
      lines: list.map((w) => [w.user === user ? `${w.user} (you)` : w.user === "_system" ? systemColumn() : w.user, w.changed.map((c) => `${labelOfRow(packages.find((p) => p.name === c.name) ?? { name: c.name })} ${c.onDisk}`).join(", ")]),
      note: `${one ? "The workspace restarts" : "Each workspace restarts"} on the code on disk. Running replies stop at a safe point and continue by themselves; open terminal sessions end. Conversations and files are kept.${list.some((w) => w.user === user) ? " Yours goes last, and this page waits for it." : ""}`,
      confirmLabel: one ? "Reload" : "Reload them",
    });
    if (!ok || !alive) return;
    anchor.disabled = true;
    report = list.map((w) => ({ user: w.user, text: "waiting…", bad: false }));
    drawReport();
    for (const [i, w] of list.entries()) {
      report[i] = { user: w.user, text: "reloading…", bad: false };
      if (alive) drawReport();
      const out = await reloadWorkspace(ext, w.user, { mode: "drain" });
      report[i] = { user: w.user, text: outcomeSentence(w.user, out), bad: out.state === "refused" || out.state === "silent" || out.state === "busy" };
      if (alive) drawReport();
    }
    const bad = report.filter((r) => r.bad).length;
    ext.toast(bad ? `Reloaded ${list.length - bad} of ${list.length}; the list says what happened to the rest.` : one ? `${reloadLabel(list[0].user, user).replace(/^Reload/, "Reloaded")}.` : `Reloaded ${list.length} workspaces.`, { tone: bad ? "warn" : "good" });
    if (alive) anchor.disabled = false;
    refresh?.();
    await load();
  }

  const reportEl = el("div", {});
  function drawReport() {
    clear(reportEl);
    if (!report?.length) return;
    put(reportEl, el("div", { class: "card ua-apply-report" }, el("div", { class: "card-head" }, "Reloads"), el("div", { class: "card-body" }, el("ul", { class: "ua-steps" }, ...report.map((r) => el("li", { class: r.bad ? "ua-refused" : null }, el("b", {}, r.user === "_system" ? systemColumn() : r.user), " ", r.text))))));
  }

  function chip(label, on, onClick) {
    return el("button", { type: "button", class: `ua-fl-chip${on ? " is-on" : ""}`, "aria-pressed": on ? "true" : "false", onClick }, label);
  }

  /** A counter: its number, and a click that narrows the table to what it counts (a second click shows everything). */
  function tile([id, label, tone], value) {
    const on = filters.show === id;
    return el(
      "button",
      { type: "button", class: `ua-fl-tile${tone && value ? ` is-${tone}` : ""}${on ? " is-on" : ""}`, "aria-pressed": on ? "true" : "false", title: on ? "Show every extension again" : `Show only these: ${label}`, onClick: () => { filters.show = on ? "everything" : id; drawTiles(); drawFilters(); drawMatrix(); } },
      el("span", { class: "ua-fl-tile-label" }, label),
      el("b", {}, String(value ?? "—"))
    );
  }

  const tilesEl = el("div", {});
  function drawTiles() {
    clear(tilesEl);
    if (!full) return;
    const s = stats ?? {};
    put(tilesEl, el("div", { class: "ua-fl-tiles" }, ...TILES.map((t) => tile(t, s[t[0]]))));
  }

  function filterRow() {
    const input = el("input", { class: "input ua-fl-search", type: "search", placeholder: "Filter by name…", "aria-label": "Filter extensions", value: filters.query, onInput: (e) => { filters.query = e.target.value; drawMatrix(); } });
    const again = () => { drawTiles(); drawFilters(); drawMatrix(); };
    const kinds = FILTERS.map((f) => chip(f.label, filters.kind === f.id, () => { filters.kind = f.id; again(); }));
    if (parts) return el("div", { class: "ua-fl-filters" }, input);
    if (!full) return el("div", { class: "ua-fl-filters" }, input, el("span", { class: "ua-fl-chips" }, ...SHOW.map(([key, label]) => chip(label, filters.show === key, () => { filters.show = key; again(); }))));
    const shows = [["everything", "every extension"], ["drift", "needs attention"]].map(([key, label]) => chip(label, filters.show === key, () => { filters.show = key; again(); }));
    const groups = GROUP.map(([key, label]) => chip(label, filters.group === key, () => { filters.group = key; again(); }));
    return el("div", { class: "ua-fl-filters" }, input, el("span", { class: "ua-fl-chips" }, ...kinds), el("span", { class: "ua-fl-label" }, "Show"), el("span", { class: "ua-fl-chips" }, ...shows), el("span", { class: "ua-fl-gap" }), el("span", { class: "ua-fl-label" }, "Group by"), el("span", { class: "ua-fl-chips" }, ...groups));
  }

  /** A person's cell: the version they run, or Waiting for a reload with the button that reloads their workspace. */
  function cell(p, who, said) {
    const entry = p.byUser?.[who];
    const state = cellState(entry);
    const words = cellWords(entry, { who, me: user, label: said.label });
    const node = el("span", { class: `ua-fl-cell is-${state === "waiting" ? "reload" : state}`, title: words.title }, words.text);
    if (words.note) return el("span", { class: "ua-fl-waiting", title: words.title }, node, el("span", { class: "ua-fl-cell-note text-faint" }, words.note));
    if (state !== "waiting" || entry?.fork) return node;
    const b = button(reloadLabel(who, user), { title: words.title });
    b.classList.add("is-sm", "ua-fl-reload");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      void reloadAll(b, workspacesBehind(packages, user).filter((w) => w.user === who));
    });
    return el("span", { class: "ua-fl-waiting" }, node, b);
  }

  /** The Extension cell: the label a person reads, the raw id as its tooltip, and the publisher line under it. */
  function nameCell(p, said) {
    return el("td", { class: "ua-fl-ext" }, el("div", { class: "ua-fl-name", title: `${said.label} (${p.name})` }, said.label), el("div", { class: "text-faint ua-fl-pub" }, said.publisher));
  }

  /** The chips, at most two with their tooltips, and the to-do's sentence under them, as the place's strip says it. */
  function chipsCell(said, todo) {
    const { state } = said;
    const note = todo ? todo.reason : state.waiting ? state.reason : null;
    return el("td", { class: "ua-fl-status" }, el("span", { class: "ua-fl-chips-cell" }, ...chipBadges(ext, state)), note ? el("div", { class: "text-faint ua-fl-note" }, note) : null);
  }

  function row(p, cols, rows, todos) {
    const open = () => {
      if (onOpen) return onOpen(p.name);
      marked = p.name;
      drawMatrix();
    };
    const said = described(rowFromFleet(p, { user }), { rows, user });
    return el(
      "tr",
      { class: `ua-fl-row${marked === p.name ? " is-marked" : ""}`, tabindex: 0, "data-package": p.name, title: `Open ${said.label}`, onClick: open, onKeydown: (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } } },
      nameCell(p, said),
      chipsCell(said, todos.get(p.name)),
      el("td", {}, el("code", {}, p.version ?? "")),
      ...(full ? cols.map((u) => el("td", { class: "ua-fl-user" }, cell(p, u, said))) : [el("td", { class: "ua-fl-what" }, said.summary ? el("div", { class: "text-faint ua-fl-desc" }, said.summary) : el("span", { class: "text-faint" }, "—"))])
    );
  }

  /**
   * The rows this view lists. All extensions: the place's Installed cards (its headline rows), everywhere every
   * extension that is not one of Thetis's parts, or the place's to-dos. Part of Thetis: the place's parts.
   * Who has what: every extension someone has.
   */
  function listed(place) {
    const byName = new Map(packages.map((p) => [p.name, p]));
    const of = (entries) => entries.map((e) => byName.get(e.row.name)).filter(Boolean);
    const q = filters.query.trim().toLowerCase();
    const hit = (p) => !q || `${p.name} ${labelOfRow(p)} ${p.summary ?? ""} ${p.description ?? ""}`.toLowerCase().includes(q);
    if (parts) return of(place.thetis).filter(hit);
    if (!full && filters.show === "mine") return of(place.installed).filter(hit);
    if (!full && filters.show === "drift") return of(place.attention).filter(hit);
    if (!full) return packages.filter((p) => !p.component && !p.nobody && hit(p));
    return filterRows(packages, filters);
  }

  const matrix = el("div", { class: "ua-fl-matrix" });
  function drawMatrix() {
    clear(matrix);
    const cols = full ? columns() : [];
    const rows = rowsFromFleet(packages, user);
    const place = placeOf(packages, user);
    const todos = new Map(place.attention.map((e) => [e.row.name, e.todo]));
    // By the label a person reads, the order every extension list uses.
    const list = listed(place).sort((a, b) => labelOfRow(a).localeCompare(labelOfRow(b)));
    if (!list.length) return void put(matrix, el("p", { class: "panel-hint" }, packages.length ? "Nothing matches these filters." : "No extension is installed anywhere."));
    const groups = full ? groupRows(list, filters.group) : [[null, list]];
    const head = el("tr", {}, el("th", { class: "ua-fl-th-name" }, "Extension"), el("th", {}, "Status"), el("th", {}, "Version"), ...(full ? cols.map((u) => el("th", { class: "ua-fl-user", title: u === "_system" ? "The system workspace: the model providers and the sign-in page run here" : null }, u === "_system" ? systemColumn() : u === user ? `${u} (you)` : u)) : [el("th", {}, "What it does")]));
    const body = el("tbody", {});
    for (const [label, group] of groups) {
      if (label) body.append(el("tr", { class: "ua-fl-group" }, el("td", { colspan: String(3 + (full ? cols.length : 1)) }, `${label} · ${group.length}`)));
      for (const p of group) body.append(row(p, cols, rows, todos));
    }
    put(matrix, el("div", { class: `table-wrap ua-fl-scroll${full ? " is-full" : ""}` }, el("table", { class: "table ua-fl-table" }, el("thead", {}, head), body)));
  }

  const filtersEl = el("div", {});
  function drawFilters() {
    clear(filtersEl);
    filtersEl.append(filterRow());
  }

  function draw() {
    clear(wrap);
    if (failed) return void put(wrap, heading(title()), failedCard(ext, "The extensions", failed, { admin: true, retry: () => void load() }));
    const installs = toInstall().length;
    const behind = workspacesBehind(packages, user);
    const place = placeOf(packages, user);
    // The Extensions place's numbers, from the place's own function: what the reader has, and Thetis's parts.
    const held = packages.filter((p) => !p.nobody).length;
    const cols = columns().filter((u) => u !== "_system").length;
    const count = full ? `${held} ${held === 1 ? "extension" : "extensions"} · ${cols} ${cols === 1 ? "person" : "people"}` : parts ? `${place.counts.thetis} ${place.counts.thetis === 1 ? "part" : "parts"}` : `${place.counts.installed} installed${place.counts.thetis ? ` · ${place.counts.thetis} part of ${agentName()}` : ""}`;
    const installBtn = installs && !parts ? button(`Update ${installs} ${installs === 1 ? "extension" : "extensions"}`, { tone: "primary", onClick: () => void installAll(installBtn) }) : null;
    // Only on Who has what, and only when somebody's workspace has not reloaded: there would be nothing to do.
    const reloadBtn = full && behind.length ? button(behind.length === 1 ? reloadLabel(behind[0].user, user) : `Reload ${behind.length} people's workspaces`, { disabled: updating ? true : null, title: updating ? updatingSentence() : "Restart the workspaces that have not reloaded onto the code on disk; running replies pause at a safe point", onClick: () => void reloadAll(reloadBtn) }) : null;
    drawTiles();
    drawFilters();
    drawMatrix();
    drawReport();
    const sub = full ? "Every extension and which people have it." : parts ? `The parts that make ${agentName()} run. Nobody installs or removes them; open one to see what it does and who has it.` : "What is installed for you, as the Extensions place lists it. Everywhere adds what only other people have.";
    put(
      wrap,
      el("div", { class: "toolbar" }, heading(title(), count), el("div", { class: "toolbar-gap" }), reloadBtn, installBtn),
      el("p", { class: "text-dim ua-fl-sub" }, sub),
      full && !installs && !behind.length && packages.length ? el("p", { class: "text-dim" }, badge("Up to date", "ok"), " Every workspace runs the code on disk.") : null,
      updating && behind.length && full ? el("p", { class: "text-dim" }, `${updatingSentence()} Reloading waits until then.`) : null,
      reportEl,
      tilesEl,
      filtersEl,
      matrix,
      el("p", { class: "text-faint" }, "A row opens that extension's page.")
    );
  }

  void load();
  return () => {
    alive = false;
  };
}

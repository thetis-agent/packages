/* Every extension in every workspace, in two views of one `fleet` answer. `simple` is Extensions → All
 * extensions: the extensions installed for the admin reading it (the same count the Extensions place and the
 * shell's own Extensions section give), with "everywhere" one chip away, each row in the columns every
 * extension list uses: Extension (its label and publisher line), its chips, Version, and What it does. `full`
 * is Advanced → Extensions by person: the same rows with a column per person, each cell the version that
 * person runs and whether their workspace applied it; `_system` is "Thetis itself", and the table scrolls
 * inside its box. The chips are `state.js`'s one state; the per-person words are the server's.
 *
 * Two actions. "Update N extensions" installs each extension whose registry holds a newer commit than its
 * pin, behind one confirm that lists them. "Apply updates for N people" restarts the workspaces that have
 * not applied the code on disk, one at a time, the admin's own last, each drained: running replies stop at a
 * safe point and continue by themselves. Nobody is skipped silently: the page keeps one line per person
 * saying what became of theirs. A row opens that extension's page through `onOpen`. */

import { reloadWorkspace, outcomeSentence, UPDATING } from "./workspaces.js";
import { failedCard, toastError } from "./failed.js";
import { chipBadges, labelOf, WORDS } from "./state.js";
import { described, rowFromFleet } from "./rows.js";

/** The label a person reads for a fleet row. */
const labelOfRow = (p) => labelOf(rowFromFleet(p));

const TYPES = ["tool", "loader", "ui", "service", "provider", "skill"];
const SHOW = [["mine", "installed for you"], ["everything", "everywhere"], ["drift", "needs attention"], ["configured", "with settings"]];
/** The system workspace's column: the one that is nobody's, where the model providers and the sign-in page live. */
export const SYSTEM_COLUMN = "Thetis itself";
const GROUP = [["scope", "scope"], ["type", "type"], ["registry", "registry"]];
// `everyone` is an extension everyone gets by default; `system` one only the system workspace holds (a
// provider, the sign-in page); `some` is everything else.
const SCOPE_LABEL = { everyone: "For everyone", system: "Thetis itself only", some: "Some people" };

/** What a person's cell says about an extension there: none, broken, update, fork, or current. */
export function cellState(entry) {
  if (!entry) return "none";
  if (entry.broken) return "broken";
  if (entry.state === "update") return "update";
  if (entry.fork || entry.forkOf) return "fork";
  return "current";
}

/** A row worth a look: an update ready (to install or to apply) or a setting missing somewhere. A copy of one's own is not a problem. */
export function drifts(pkg) {
  if (pkg.state === "update" || pkg.registry?.update || pkg.config?.broken) return true;
  return Object.values(pkg.byUser ?? {}).some((e) => e.state === "update" || e.broken);
}

/**
 * The workspaces that have not applied the code on disk, with what each one has not applied. The admin's
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

/** The extensions installed for the person reading: the count every extension list agrees on. */
export const installedForMe = (packages) => packages.filter((p) => p.mine);

/** The rows that pass the filters, in the order they came. `mine` keeps what is installed for the reader. */
export function filterRows(packages, { query = "", type = "all", show = "everything" }) {
  const q = query.trim().toLowerCase();
  return packages.filter((p) => {
    if (type !== "all" && p.type !== type) return false;
    if (show === "mine" && !p.mine) return false;
    if (show === "drift" && !drifts(p)) return false;
    if (show === "configured" && !(p.config?.keys > 0)) return false;
    if (q && !`${p.name} ${labelOfRow(p)} ${p.type} ${p.description ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** The rows in their groups, each group `[label, rows]`, in a stable order for the chosen grouping. */
export function groupRows(rows, group) {
  const keyOf = (p) => (group === "type" ? p.type || "other" : group === "registry" ? (p.registry ? "in a registry" : "local only") : p.scope || "some");
  const labelOf = (key) => (group === "scope" ? SCOPE_LABEL[key] ?? key : key);
  const order = group === "scope" ? ["everyone", "system", "some"] : group === "registry" ? ["in a registry", "local only"] : [...new Set(rows.map(keyOf))].sort();
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
  let alive = true;
  let people = [];
  let packages = [];
  let stats = null;
  let failed = null;
  let report = null; // [{ user, text, bad }]: what "Apply updates" did, one line per person
  let updating = false; // an update of Thetis is installing: applying waits for it
  let marked = null; // the row a click marked when nothing opens a page
  const filters = { query: "", type: "all", show: full ? "everything" : "mine", group: full ? "scope" : "none" };
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
      note: "Each one is installed from the commit its registry holds now. The people who have it get it the next time their workspace applies updates.",
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
   * Restarts every workspace that has not applied the code on disk, drained, one at a time, the admin's own
   * last. Every person gets a line in the report, whatever became of theirs: a refusal names the workspace
   * and the rest still go, because one that will not restart is no reason to leave the others behind.
   */
  async function applyAll(anchor) {
    const list = workspacesBehind(packages, user);
    if (!list.length) return;
    const ok = await confirm(anchor, {
      title: `Apply updates for ${list.length} ${list.length === 1 ? "person" : "people"}?`,
      lines: list.map((w) => [w.user === user ? `${w.user} (you)` : w.user, w.changed.map((c) => `${labelOfRow(packages.find((p) => p.name === c.name) ?? { name: c.name })} ${c.loaded} → ${c.onDisk}`).join(", ")]),
      note: "Each workspace restarts on the code on disk. Running replies stop at a safe point and continue by themselves; open terminal sessions end. Conversations and files are kept. Yours goes last, and this page waits for it.",
      confirmLabel: "Apply",
    });
    if (!ok || !alive) return;
    anchor.disabled = true;
    report = list.map((w) => ({ user: w.user, text: "waiting…", bad: false }));
    draw();
    for (const [i, w] of list.entries()) {
      report[i] = { user: w.user, text: "applying…", bad: false };
      if (alive) drawReport();
      const out = await reloadWorkspace(ext, w.user, { mode: "drain" });
      report[i] = { user: w.user, text: outcomeSentence(w.user, out), bad: out.state === "refused" || out.state === "silent" || out.state === "busy" };
      if (alive) drawReport();
    }
    const bad = report.filter((r) => r.bad).length;
    ext.toast(bad ? `Applied for ${list.length - bad} of ${list.length}; the list says what happened to the rest.` : `Applied for ${list.length} ${list.length === 1 ? "person" : "people"}.`, { tone: bad ? "warn" : "good" });
    if (alive) anchor.disabled = false;
    refresh?.();
    await load();
  }

  const reportEl = el("div", {});
  function drawReport() {
    clear(reportEl);
    if (!report?.length) return;
    put(reportEl, el("div", { class: "card ua-apply-report" }, el("div", { class: "card-head" }, "Apply updates"), el("div", { class: "card-body" }, el("ul", { class: "ua-steps" }, ...report.map((r) => el("li", { class: r.bad ? "ua-refused" : null }, el("code", {}, r.user), " ", r.text))))));
  }

  function chip(label, on, onClick) {
    return el("button", { type: "button", class: `ua-fl-chip${on ? " is-on" : ""}`, "aria-pressed": on ? "true" : "false", onClick }, label);
  }

  function tile(label, value, tone) {
    return el("div", { class: `ua-fl-tile${tone ? ` is-${tone}` : ""}` }, el("span", { class: "ua-fl-tile-label" }, label), el("b", {}, String(value ?? "—")));
  }

  function tiles() {
    const s = stats ?? {};
    return el("div", { class: "ua-fl-tiles" }, tile("up to date", s.current, "ok"), tile("update ready", s.updates, s.updates ? "warn" : null), tile("people to apply", s.waiting, s.waiting ? "warn" : null), tile("own copies", s.forks, null), tile("needs setup", s.broken, s.broken ? "err" : null));
  }

  function filterRow() {
    const input = el("input", { class: "input ua-fl-search", type: "search", placeholder: "Filter by name or description…", "aria-label": "Filter extensions", value: filters.query, onInput: (e) => { filters.query = e.target.value; drawMatrix(); } });
    const again = () => { drawFilters(); drawMatrix(); };
    const shows = SHOW.map(([key, label]) => chip(label, filters.show === key, () => { filters.show = key; again(); }));
    if (!full) return el("div", { class: "ua-fl-filters" }, input, el("span", { class: "ua-fl-chips" }, ...shows.slice(0, 3)));
    const types = [chip("all types", filters.type === "all", () => { filters.type = "all"; again(); }), ...TYPES.map((t) => chip(t, filters.type === t, () => { filters.type = t; again(); }))];
    const groups = GROUP.map(([key, label]) => chip(label, filters.group === key, () => { filters.group = key; again(); }));
    return el("div", { class: "ua-fl-filters" }, input, el("span", { class: "ua-fl-chips" }, ...types), el("span", { class: "ua-fl-label" }, "Show"), el("span", { class: "ua-fl-chips" }, ...shows.slice(1)), el("span", { class: "ua-fl-gap" }), el("span", { class: "ua-fl-label" }, "Group by"), el("span", { class: "ua-fl-chips" }, ...groups));
  }

  /** A person's cell: the version in service, with its word. A workspace that has not applied shows what it runs. */
  function cell(entry) {
    const state = cellState(entry);
    if (state === "none") return el("span", { class: "ua-fl-cell is-none", title: "not installed" }, "—");
    const version = (state === "update" ? entry.loaded : entry.version) ?? entry.version ?? "?";
    const title = state === "broken" ? "needs setup: a setting is missing" : state === "update" ? `Update ready: runs ${entry.loaded ?? "an older copy"}, ${entry.version} is on disk` : state === "fork" ? `their own copy${entry.forkOf ? ` (${entry.forkOf})` : ""}` : "Up to date";
    const cls = state === "update" ? "reload" : state;
    return el("span", { class: `ua-fl-cell is-${cls}`, title }, state === "fork" ? `${version} · own copy` : version);
  }

  /** The Extension cell: the label a person reads, the raw id as its tooltip, and the publisher line under it. */
  function nameCell(p, said) {
    return el("td", { class: "ua-fl-ext" }, el("div", { class: "ua-fl-name", title: p.name }, said.label), el("div", { class: "text-faint ua-fl-pub" }, said.publisher));
  }

  /** The chips, at most two with their tooltips, and the one sentence under them when it asks for attention. */
  function chipsCell(said) {
    const { state } = said;
    const note = state.attention ? state.reason : state.waiting ? WORDS.waiting : null;
    return el("td", { class: "ua-fl-status" }, el("span", { class: "ua-fl-chips-cell" }, ...chipBadges(ext, state)), note ? el("div", { class: "text-faint ua-fl-note" }, note) : null);
  }

  function row(p, cols, rows) {
    const open = () => {
      if (onOpen) return onOpen(p.name);
      marked = p.name;
      drawMatrix();
    };
    const said = described(rowFromFleet(p, { user }), { rows, user });
    return el(
      "tr",
      { class: `ua-fl-row${marked === p.name ? " is-marked" : ""}`, tabindex: 0, "data-package": p.name, title: `Open ${said.label}`, onClick: open, onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } },
      nameCell(p, said),
      chipsCell(said),
      el("td", {}, el("code", {}, p.version ?? "")),
      ...(full ? cols.map((u) => el("td", { class: "ua-fl-user" }, cell(p.byUser?.[u]))) : [el("td", { class: "ua-fl-what" }, p.description ? el("div", { class: "text-faint ua-fl-desc" }, p.description) : el("span", { class: "text-faint" }, "—"))])
    );
  }

  const matrix = el("div", { class: "ua-fl-matrix" });
  function drawMatrix() {
    clear(matrix);
    const cols = full ? columns() : [];
    // By the label a person reads, the order every extension list uses.
    const rows = filterRows(packages, filters).sort((a, b) => labelOfRow(a).localeCompare(labelOfRow(b)));
    const every = packages.map((p) => rowFromFleet(p, { user }));
    if (!rows.length) return void put(matrix, el("p", { class: "panel-hint" }, packages.length ? "Nothing matches these filters." : "No extension is installed anywhere."));
    const groups = full ? groupRows(rows, filters.group) : [[null, rows]];
    const head = el("tr", {}, el("th", { class: "ua-fl-th-name" }, "Extension"), el("th", {}, "Status"), el("th", {}, "Version"), ...(full ? cols.map((u) => el("th", { class: "ua-fl-user", title: u === "_system" ? "The system workspace: the model providers and the sign-in page run here" : null }, u === "_system" ? SYSTEM_COLUMN : u)) : [el("th", {}, "What it does")]));
    const body = el("tbody", {});
    for (const [label, list] of groups) {
      if (label) body.append(el("tr", { class: "ua-fl-group" }, el("td", { colspan: String(3 + (full ? cols.length : 1)) }, `${label} · ${list.length}`)));
      for (const p of list) body.append(row(p, cols, every));
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
    if (failed) return void put(wrap, heading(full ? "Extensions by person" : "All extensions"), failedCard(ext, "The extensions", failed, { admin: true, retry: () => void load() }));
    const installs = toInstall().length;
    const behind = workspacesBehind(packages, user);
    const mine = installedForMe(packages).length;
    const count = full ? `${packages.length} ${packages.length === 1 ? "extension" : "extensions"} across ${columns().length} ${columns().length === 1 ? "workspace" : "workspaces"}` : `${mine} installed`;
    const installBtn = installs ? button(`Update ${installs} ${installs === 1 ? "extension" : "extensions"}`, { tone: "primary", onClick: () => void installAll(installBtn) }) : null;
    // No button when everyone has applied what is on disk: there would be nothing for it to do.
    const applyBtn = behind.length ? button(`Apply updates for ${behind.length} ${behind.length === 1 ? "person" : "people"}`, { tone: "primary", disabled: updating ? true : null, title: updating ? UPDATING : "Restart the workspaces that have not applied the code on disk; running replies pause at a safe point", onClick: () => void applyAll(applyBtn) }) : null;
    drawFilters();
    drawMatrix();
    drawReport();
    put(
      wrap,
      el("div", { class: "toolbar" }, heading(full ? "Extensions by person" : "All extensions", count), el("div", { class: "toolbar-gap" }), applyBtn, installBtn),
      full ? null : el("p", { class: "text-dim ua-fl-sub" }, "Every extension installed here. Everywhere adds what only other people or Thetis itself have."),
      !installs && !behind.length && packages.length ? el("p", { class: "text-dim" }, badge("Up to date", "ok"), " Every workspace runs the code on disk.") : null,
      updating && behind.length ? el("p", { class: "text-dim" }, `${UPDATING} Applying waits until then.`) : null,
      reportEl,
      full ? tiles() : null,
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

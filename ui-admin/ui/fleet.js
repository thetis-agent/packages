/* Every extension in every workspace, in two views of one `fleet` answer. `simple` is Extensions → All
 * extensions: one row per extension with its one word (Up to date, Update ready), how many people have not
 * applied it yet, and whether it needs setup. `full` is Advanced → Extensions by person: the same rows with a
 * column per person, each cell the version that person runs and whether their workspace applied it. The
 * words are the server's (`state` on a row and a cell); the page draws them and never guesses.
 *
 * Two actions. "Update N extensions" installs each extension whose registry holds a newer commit than its
 * pin, behind one confirm that lists them. "Apply updates for N people" restarts the workspaces that have
 * not applied the code on disk, one at a time, the admin's own last, each drained: running replies stop at a
 * safe point and continue by themselves. Nobody is skipped silently: the page keeps one line per person
 * saying what became of theirs. A row opens that extension's page through `onOpen`. */

import { reloadWorkspace, outcomeSentence, UPDATING } from "./workspaces.js";
import { failedCard, toastError } from "./failed.js";
import { shortName, stateBadge, waitingSentence } from "./state.js";

const TYPES = ["tool", "loader", "ui", "service", "provider", "skill"];
const SHOW = [["everything", "everything"], ["drift", "needs a look"], ["configured", "with settings"]];
const GROUP = [["scope", "scope"], ["type", "type"], ["registry", "registry"]];
// `everyone` is an extension everyone gets by default; `system` one only the system workspace holds (a
// provider, the sign-in page); `some` is everything else.
const SCOPE_LABEL = { everyone: "Default for everyone", system: "System workspace only", some: "Some people" };

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

/** The rows that pass the filters, in the order they came. */
export function filterRows(packages, { query = "", type = "all", show = "everything" }) {
  const q = query.trim().toLowerCase();
  return packages.filter((p) => {
    if (type !== "all" && p.type !== type) return false;
    if (show === "drift" && !drifts(p)) return false;
    if (show === "configured" && !(p.config?.keys > 0)) return false;
    if (q && !`${p.name} ${p.type} ${p.description ?? ""}`.toLowerCase().includes(q)) return false;
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
  const filters = { query: "", type: "all", show: "everything", group: full ? "scope" : "none" };
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
      lines: list.map((p) => [shortName(p.name), `${p.version} → ${p.registry.version}`]),
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
      toastError(ext, err, `${shortName(list[done]?.name ?? "update")}${done ? ` (${done} updated before it)` : ""}`);
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
      lines: list.map((w) => [w.user === user ? `${w.user} (you)` : w.user, w.changed.map((c) => `${shortName(c.name)} ${c.loaded} → ${c.onDisk}`).join(", ")]),
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
    if (!full) return el("div", { class: "ua-fl-filters" }, input, el("span", { class: "ua-fl-chips" }, ...shows.slice(0, 2)));
    const types = [chip("all types", filters.type === "all", () => { filters.type = "all"; again(); }), ...TYPES.map((t) => chip(t, filters.type === t, () => { filters.type = t; again(); }))];
    const groups = GROUP.map(([key, label]) => chip(label, filters.group === key, () => { filters.group = key; again(); }));
    return el("div", { class: "ua-fl-filters" }, input, el("span", { class: "ua-fl-chips" }, ...types), el("span", { class: "ua-fl-label" }, "Show"), el("span", { class: "ua-fl-chips" }, ...shows), el("span", { class: "ua-fl-gap" }), el("span", { class: "ua-fl-label" }, "Group by"), el("span", { class: "ua-fl-chips" }, ...groups));
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

  /** The row's word: Update ready when anything about it is, and who has not applied it. */
  function stateCell(p) {
    const n = (p.waiting ?? []).length;
    const install = p.registry?.update?.apply === "install";
    return el("span", { class: "ua-line" }, stateBadge(ext, p.state ?? (drifts(p) ? "update" : "current")), install ? el("span", { class: "text-faint" }, `${p.registry.version} in the registry`) : n ? el("span", { class: "text-faint" }, waitingSentence(n)) : null);
  }

  function configCell(p) {
    const c = p.config ?? {};
    if (!(c.keys > 0)) return el("span", { class: "text-faint" }, "—");
    return el("span", { class: "ua-fl-config" }, el("span", { class: `ua-fl-dot is-${c.broken ? "err" : "ok"}` }), c.broken ? "needs setup" : "set up");
  }

  function row(p, cols) {
    const open = () => {
      if (onOpen) return onOpen(p.name);
      marked = p.name;
      drawMatrix();
    };
    return el(
      "tr",
      { class: `ua-fl-row${marked === p.name ? " is-marked" : ""}`, tabindex: 0, "data-package": p.name, title: `Open ${p.name}`, onClick: open, onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } },
      el("td", {}, el("span", { class: "ua-fl-name" }, shortName(p.name)), el("span", { class: "text-faint ua-fl-type" }, ` ${p.type ?? ""}`), p.description ? el("div", { class: "text-faint ua-fl-desc" }, p.description) : null),
      el("td", {}, el("code", {}, p.version ?? "")),
      el("td", {}, stateCell(p)),
      el("td", {}, configCell(p)),
      ...(full ? cols.map((u) => el("td", { class: "ua-fl-user" }, cell(p.byUser?.[u]))) : []),
      el("td", { class: "ua-fl-open" }, el("span", { class: "ua-fl-link" }, "open"))
    );
  }

  const matrix = el("div", { class: "ua-fl-matrix" });
  function drawMatrix() {
    clear(matrix);
    const cols = full ? columns() : [];
    const rows = filterRows(packages, filters);
    if (!rows.length) return void put(matrix, el("p", { class: "panel-hint" }, packages.length ? "Nothing matches these filters." : "No extension is installed anywhere."));
    const groups = full ? groupRows(rows, filters.group) : [[null, rows]];
    const head = el("tr", {}, el("th", { class: "ua-fl-th-name" }, "Extension"), el("th", {}, "Version"), el("th", {}, "State"), el("th", {}, "Setup"), ...cols.map((u) => el("th", { class: "ua-fl-user" }, u)), el("th", {}));
    const body = el("tbody", {});
    for (const [label, list] of groups) {
      if (label) body.append(el("tr", { class: "ua-fl-group" }, el("td", { colspan: String(5 + cols.length) }, `${label} · ${list.length}`)));
      for (const p of list) body.append(row(p, cols));
    }
    put(matrix, el("div", { class: "table-wrap" }, el("table", { class: "table ua-fl-table" }, el("thead", {}, head), body)));
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
    const count = full ? `${packages.length} ${packages.length === 1 ? "extension" : "extensions"} across ${columns().length} ${columns().length === 1 ? "workspace" : "workspaces"}` : `${packages.length} installed`;
    const installBtn = installs ? button(`Update ${installs} ${installs === 1 ? "extension" : "extensions"}`, { tone: "primary", onClick: () => void installAll(installBtn) }) : null;
    // No button when everyone has applied what is on disk: there would be nothing for it to do.
    const applyBtn = behind.length ? button(`Apply updates for ${behind.length} ${behind.length === 1 ? "person" : "people"}`, { tone: "primary", disabled: updating ? true : null, title: updating ? UPDATING : "Restart the workspaces that have not applied the code on disk; running replies pause at a safe point", onClick: () => void applyAll(applyBtn) }) : null;
    drawFilters();
    drawMatrix();
    drawReport();
    put(
      wrap,
      el("div", { class: "toolbar" }, heading(full ? "Extensions by person" : "All extensions", count), el("div", { class: "toolbar-gap" }), applyBtn, installBtn),
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

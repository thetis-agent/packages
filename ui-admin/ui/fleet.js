/* Every package in every workspace, on one screen: the fleet matrix, the first page under Packages in the
 * control panel tree. One row per package, one column per person, and in each cell the version that person
 * runs, coloured for what it says: current, running older code than the disk, a fork in that person's
 * place, configuration missing something, or not installed at all. Six tiles above count the same things
 * across the fleet, so an admin reads "what needs a look" before reading anything else; the filter row
 * narrows to drift only, to the packages with configuration, by type, and by text; the rows group by
 * scope, type or registry. Everything is drawn from one `fleet` answer and filtered here: the answer is
 * the kernel's word, and a filter never asks again.
 *
 * Three actions. Update N packages sends one `package-update` per package behind the index, behind one
 * confirm that lists them. Reload N workspaces is the other kind of behind: a package shipped with the
 * service is installed the moment its files land, so what a workspace is still running is the version its
 * fence read when it opened, and only a reload puts the new one into service. It sends one `fence-reload`
 * per workspace, the admin's own last, through the same function the Workspaces section uses, so a reload
 * that closes the fence answering this page is waited for rather than reported as a failure. A row opens
 * that package's page through `onOpen`, which the coordinator wires to the tree; without it a click only
 * marks the row. The marketplace's refresh and the shell's install from a source stay where they are:
 * this page reads, and points. */

import { reloadWorkspace } from "./workspaces.js";

const TYPES = ["tool", "loader", "ui", "service", "provider", "skill"];
const SHOW = [["everything", "everything"], ["drift", "drift only"], ["configured", "with configuration"]];
const GROUP = [["scope", "scope"], ["type", "type"], ["registry", "registry"]];
// `everyone` is a system package that is everyone's default; `system` here is the other meaning of the word, a
// package only the system workspace holds (a provider, the sign-in page); `some` is everything else.
const SCOPE_LABEL = { everyone: "Default for everyone", system: "System workspace only", some: "Some people" };

/** What a person's cell says about a package there, or "none" when the package is not installed for them. */
export function cellState(entry) {
  if (!entry) return "none";
  if (entry.broken) return "broken";
  // Behind the disk is the precise version of stale: the fence loaded one version and the files hold another.
  if (entry.behindDisk) return "reload";
  if (entry.stale) return "stale";
  if (entry.fork || entry.forkOf) return "fork";
  return "current";
}

/** A row worth a look: an update on offer, a broken configuration anywhere, or a workspace behind the disk or on a fork. */
export function drifts(pkg) {
  if (pkg.registry?.update || pkg.config?.broken) return true;
  return Object.values(pkg.byUser ?? {}).some((e) => e.stale || e.behindDisk || e.fork || e.forkOf || e.broken);
}

/**
 * The workspaces holding a package the disk has moved past, with what each one has not loaded. The
 * admin's own comes last, because reloading it closes the fence that serves this page. A fork's cell in
 * its original's row is skipped: it is the same copy, already listed under the fork's own name.
 */
export function workspacesBehind(packages, me) {
  const byUser = new Map();
  for (const p of packages) {
    for (const [who, c] of Object.entries(p.byUser ?? {})) {
      if (!c?.behindDisk || c.fork) continue;
      if (!byUser.has(who)) byUser.set(who, []);
      byUser.get(who).push({ name: p.name, loaded: c.loaded, onDisk: c.version });
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

export function mountFleet(ext, root, { refresh, onOpen, user } = {}) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, confirm, heading, put } = ext.ui;
  let alive = true;
  let people = [];
  let packages = [];
  let stats = null;
  let error = null;
  let marked = null; // the row a click marked when nothing opens a page
  const filters = { query: "", type: "all", show: "everything", group: "scope" };
  const wrap = el("div", { class: "panel-col ua-fleet" });
  root.append(el("div", { class: "panel-cols ua-fleet-cols" }, wrap));

  async function load() {
    const stop = busy(wrap, "Reading every workspace…");
    error = null;
    try {
      const out = await ext.request("fleet");
      people = Array.isArray(out?.data?.people) ? out.data.people : [];
      packages = Array.isArray(out?.data?.packages) ? out.data.packages : [];
      stats = out?.data?.stats && typeof out.data.stats === "object" ? out.data.stats : null;
    } catch (err) {
      error = err?.message || "The fleet could not be read.";
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

  /** The install kind of behind: the registry holds a newer commit than the pin, and an install moves to it. */
  const toUpdate = () => packages.filter((p) => p.registry?.update?.apply === "install");

  async function updateAll(anchor) {
    const behind = toUpdate();
    if (!behind.length) return;
    const ok = await confirm(anchor, {
      title: `Update ${behind.length} ${behind.length === 1 ? "package" : "packages"}?`,
      lines: behind.map((p) => [p.name, `${p.version} → ${p.registry.version}`]),
      note: "Each one is installed from the commit its registry holds now. A workspace that runs a service of it has that service restarted.",
      confirmLabel: "Update",
    });
    if (!ok || !alive) return;
    anchor.disabled = true;
    let done = 0;
    try {
      for (const p of behind) {
        await ext.request("package-update", { args: { name: p.name } });
        done += 1;
      }
      ext.toast(`${done} ${done === 1 ? "package" : "packages"} updated.`, { tone: "good" });
    } catch (err) {
      ext.toast(`${behind[done]?.name ?? "update"}: ${err.message}${done ? ` (${done} updated before it)` : ""}`, { tone: "error" });
    } finally {
      if (alive) anchor.disabled = false;
    }
    refresh?.();
    await load();
  }

  /**
   * The reload kind of behind: one `fence-reload` per workspace, the admin's own last, each waited for
   * the way the Workspaces section waits. A refusal names the workspace and the rest still go, because
   * one workspace that will not reload is no reason to leave the others on old code.
   */
  async function reloadAll(anchor) {
    const list = workspacesBehind(packages, user);
    if (!list.length) return;
    const ok = await confirm(anchor, {
      title: `Reload ${list.length} ${list.length === 1 ? "workspace" : "workspaces"}?`,
      lines: list.map((w) => [w.user === user ? `${w.user} (you)` : w.user, w.changed.map((c) => `${c.name} ${c.loaded} → ${c.onDisk}`).join(", ")]),
      note: "Each workspace closes and opens again on the code on disk now: its services, its provider and the agent itself. Every open shell session in it stops; conversations and files are untouched, and a workspace with a turn running is left alone and named. Your own workspace goes last, and this page waits for it to answer again.",
      confirmLabel: "Reload",
      tone: "warn",
    });
    if (!ok || !alive) return;
    anchor.disabled = true;
    let done = 0;
    for (const w of list) {
      const out = await reloadWorkspace(ext, w.user, { onLost: () => ext.toast(`${w.user} is reloading. Waiting for the workspace to answer again…`, { tone: "good" }) });
      // A turn running there is left alone: a sweep across the fleet is no place to cancel somebody's work.
      if (out.state === "busy") ext.toast(`${w.user} was left alone: ${out.message}. Reload it from Workspaces when the turn ends, or cancel the turn there.`, { tone: "warn" });
      else if (out.state === "refused") ext.toast(`${w.user}: ${out.message}`, { tone: "error" });
      else if (out.state === "silent") ext.toast(`${w.user} ${out.message.replace(/^It /, "")}`, { tone: "error" });
      else done += 1;
    }
    ext.toast(`${done} of ${list.length} ${list.length === 1 ? "workspace" : "workspaces"} reloaded.`, { tone: done === list.length ? "good" : "error" });
    if (alive) anchor.disabled = false;
    refresh?.();
    await load();
  }

  function chip(label, on, onClick) {
    return el("button", { type: "button", class: `ua-fl-chip${on ? " is-on" : ""}`, "aria-pressed": on ? "true" : "false", onClick }, label);
  }

  function tile(label, value, tone) {
    return el("div", { class: `ua-fl-tile${tone ? ` is-${tone}` : ""}` }, el("span", { class: "ua-fl-tile-label" }, label), el("b", {}, String(value ?? "—")));
  }

  function tiles() {
    const s = stats ?? {};
    return el(
      "div",
      { class: "ua-fl-tiles" },
      tile("current", s.current, "ok"),
      tile("update on offer", s.updates, s.updates ? "warn" : null),
      tile("workspaces to reload", s.reloads, s.reloads ? "warn" : null),
      tile("forks in use", s.forks, s.forks ? "warn" : null),
      tile("config broken", s.broken, s.broken ? "err" : null),
      tile("workspaces on older code", s.stale, s.stale ? "warn" : null),
      tile("not pushed", s.unpushed, s.unpushed ? "warn" : null)
    );
  }

  function filterRow() {
    const input = el("input", { class: "input ua-fl-search", type: "search", placeholder: "Filter by name, type, description…", "aria-label": "Filter packages", value: filters.query, onInput: (e) => { filters.query = e.target.value; drawMatrix(); } });
    const types = [chip("all types", filters.type === "all", () => { filters.type = "all"; drawFilters(); drawMatrix(); }), ...TYPES.map((t) => chip(t, filters.type === t, () => { filters.type = t; drawFilters(); drawMatrix(); }))];
    const shows = SHOW.map(([key, label]) => chip(label, filters.show === key, () => { filters.show = key; drawFilters(); drawMatrix(); }));
    const groups = GROUP.map(([key, label]) => chip(label, filters.group === key, () => { filters.group = key; drawFilters(); drawMatrix(); }));
    return el(
      "div",
      { class: "ua-fl-filters" },
      input,
      el("span", { class: "ua-fl-chips" }, ...types),
      el("span", { class: "ua-fl-label" }, "Show"),
      el("span", { class: "ua-fl-chips" }, ...shows),
      el("span", { class: "ua-fl-gap" }),
      el("span", { class: "ua-fl-label" }, "Group by"),
      el("span", { class: "ua-fl-chips" }, ...groups)
    );
  }

  function cell(entry) {
    const state = cellState(entry);
    if (state === "none") return el("span", { class: "ua-fl-cell is-none", title: "not installed" }, "—");
    // A workspace behind the disk shows what it is running, not what is on disk: the version in service is the fact.
    const bits = [(state === "reload" ? entry.loaded : entry.version) ?? "?"];
    if (state === "reload") bits.push("↻");
    if (entry.fork) bits.push("Y");
    const title =
      state === "broken"
        ? "configuration missing something"
        : state === "reload"
          ? `loaded ${entry.loaded}, ${entry.version} on disk`
          : state === "stale"
            ? "this workspace runs older code than the disk"
            : state === "fork"
              ? `a fork ${entry.forkOf ? `of ${entry.forkOf} ` : ""}replaces it here`
              : "current";
    return el("span", { class: `ua-fl-cell is-${state}`, title }, bits.join(" "));
  }

  function registryCell(p) {
    if (!p.registry) return el("span", { class: "text-faint" }, "not indexed");
    if (p.registry.update?.apply === "reload") return badge(`reload to ${p.registry.update.version}`, "warn");
    if (p.registry.update) return badge(`${p.registry.version} on offer`, "warn");
    return badge("current", "ok");
  }

  function configCell(p) {
    const c = p.config ?? {};
    if (!(c.keys > 0)) return el("span", { class: "text-faint" }, "no keys");
    return el("span", { class: "ua-fl-config" }, el("span", { class: `ua-fl-dot is-${c.broken ? "err" : "ok"}` }), c.broken ? "missing something" : "whole");
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
      el("td", {}, el("code", { class: "ua-fl-name" }, p.name), el("span", { class: "text-faint ua-fl-type" }, ` ${p.type ?? ""}`), p.description ? el("div", { class: "text-faint ua-fl-desc" }, p.description) : null),
      el("td", {}, el("code", {}, p.version ?? "")),
      el("td", {}, registryCell(p)),
      el("td", {}, configCell(p)),
      ...cols.map((u) => el("td", { class: "ua-fl-user" }, cell(p.byUser?.[u]))),
      el("td", { class: "ua-fl-open" }, el("span", { class: "ua-fl-link" }, "open"))
    );
  }

  const matrix = el("div", { class: "ua-fl-matrix" });
  function drawMatrix() {
    clear(matrix);
    if (error) return void put(matrix, el("p", { class: "ua-refused" }, error));
    const cols = columns();
    const rows = filterRows(packages, filters);
    const groups = groupRows(rows, filters.group);
    if (!rows.length) return void put(matrix, el("p", { class: "panel-hint" }, packages.length ? "Nothing matches these filters." : "No package is installed anywhere."));
    const head = el("tr", {}, el("th", { class: "ua-fl-th-name" }, "Package"), el("th", {}, "Version"), el("th", {}, "Registry"), el("th", {}, "Config"), ...cols.map((u) => el("th", { class: "ua-fl-user" }, u)), el("th", {}));
    const body = el("tbody", {});
    for (const [label, list] of groups) {
      body.append(el("tr", { class: "ua-fl-group" }, el("td", { colspan: String(5 + cols.length) }, `${label} · ${list.length}`)));
      for (const p of list) body.append(row(p, cols));
    }
    put(matrix, el("div", { class: "table-wrap" }, el("table", { class: "table ua-fl-table" }, el("thead", {}, head), body)));
  }

  const filtersEl = el("div", {});
  function drawFilters() {
    clear(filtersEl);
    filtersEl.append(filterRow());
  }

  function legend() {
    const item = (state, text, label) => el("span", { class: "ua-fl-legend-item" }, el("span", { class: `ua-fl-cell is-${state}` }, text), label);
    return el(
      "div",
      { class: "ua-fl-legend" },
      item("current", "v", "current"),
      item("reload", "v ↻", "the workspace has not loaded the version on disk"),
      item("stale", "v", "workspace runs older code than the disk"),
      item("fork", "v Y", "a fork replaces it there"),
      item("broken", "v", "configuration missing something"),
      item("none", "—", "not installed"),
      el("span", { class: "ua-fl-gap" }),
      el("span", { class: "text-faint" }, "A row opens that package's page.")
    );
  }

  function draw() {
    clear(wrap);
    const behind = toUpdate().length;
    const toReload = workspacesBehind(packages, user);
    const count = `${packages.length} ${packages.length === 1 ? "package" : "packages"} across ${columns().length} ${columns().length === 1 ? "workspace" : "workspaces"}`;
    const updateBtn = button(behind ? `Update ${behind} ${behind === 1 ? "package" : "packages"}` : "Nothing to update", { tone: behind ? "primary" : "quiet", disabled: !behind || null, onClick: () => void updateAll(updateBtn) });
    // No button when every workspace has loaded what is on disk: there would be nothing for it to do.
    const reloadBtn = toReload.length ? button(`Reload ${toReload.length} ${toReload.length === 1 ? "workspace" : "workspaces"}`, { tone: "warn", title: "Put the code on disk into service where a workspace has not loaded it", onClick: () => void reloadAll(reloadBtn) }) : null;
    drawFilters();
    drawMatrix();
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("All workspaces", count), el("div", { class: "toolbar-gap" }), reloadBtn, updateBtn),
      tiles(),
      filtersEl,
      matrix,
      legend()
    );
  }

  void load();
  return () => {
    alive = false;
  };
}

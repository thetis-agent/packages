/* Every package in every workspace, on one screen: the fleet matrix, the first page under Packages in the
 * control panel tree. One row per package, one column per person, and in each cell the version that person
 * runs, coloured for what it says: current, running older code than the disk, a fork in that person's
 * place, configuration missing something, or not installed at all. Six tiles above count the same things
 * across the fleet, so an admin reads "what needs a look" before reading anything else; the filter row
 * narrows to drift only, to the packages with configuration, by type, and by text; the rows group by
 * scope, type or registry. Everything is drawn from one `fleet` answer and filtered here: the answer is
 * the kernel's word, and a filter never asks again.
 *
 * Two actions. Update N packages sends one `package-update` per package behind the index, behind one
 * confirm that lists them. A row opens that package's page through `onOpen`, which the coordinator wires
 * to the tree; without it a click only marks the row. The marketplace's refresh and the shell's install from
 * a source stay where they are: this page reads, and points. */

const TYPES = ["tool", "loader", "ui", "service", "provider", "skill"];
const SHOW = [["everything", "everything"], ["drift", "drift only"], ["configured", "with configuration"]];
const GROUP = [["scope", "scope"], ["type", "type"], ["registry", "registry"]];
const SCOPE_LABEL = { everyone: "Everyone", system: "System", some: "Only some people" };

/** What a person's cell says about a package there, or "none" when the package is not installed for them. */
export function cellState(entry) {
  if (!entry) return "none";
  if (entry.broken) return "broken";
  if (entry.stale) return "stale";
  if (entry.fork || entry.forkOf) return "fork";
  return "current";
}

/** A row worth a look: an update on offer, a broken configuration anywhere, or a workspace behind the disk or on a fork. */
export function drifts(pkg) {
  if (pkg.registry?.update || pkg.config?.broken) return true;
  return Object.values(pkg.byUser ?? {}).some((e) => e.stale || e.fork || e.forkOf || e.broken);
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

export function mountFleet(ext, root, { refresh, onOpen } = {}) {
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

  async function updateAll(anchor) {
    const behind = packages.filter((p) => p.registry?.update);
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
    const bits = [entry.version ?? "?"];
    if (entry.fork) bits.push("Y");
    const title = state === "broken" ? "configuration missing something" : state === "stale" ? "this workspace runs older code than the disk" : state === "fork" ? `a fork ${entry.forkOf ? `of ${entry.forkOf} ` : ""}replaces it here` : "current";
    return el("span", { class: `ua-fl-cell is-${state}`, title }, bits.join(" "));
  }

  function registryCell(p) {
    if (!p.registry) return el("span", { class: "text-faint" }, "not indexed");
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
    const behind = packages.filter((p) => p.registry?.update).length;
    const count = `${packages.length} ${packages.length === 1 ? "package" : "packages"} across ${columns().length} ${columns().length === 1 ? "workspace" : "workspaces"}`;
    const updateBtn = button(behind ? `Update ${behind} ${behind === 1 ? "package" : "packages"}` : "Nothing to update", { tone: behind ? "primary" : "quiet", disabled: !behind || null, onClick: () => void updateAll(updateBtn) });
    drawFilters();
    drawMatrix();
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("All workspaces", count), el("div", { class: "toolbar-gap" }), updateBtn),
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

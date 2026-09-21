/* The History tab of a package's page: the commits that touched the package, drawn as a lane graph beside
 * their rows, and one commit opened in an inspector. Two lanes are real: the upstream (commits that are
 * pushed) in the accent, and the local commits not pushed yet in the warn tone, which sit above the
 * upstream and curve into it where they were branched. The registry has no lane of its own, because the
 * fence holds no clone of it: the commit its index names is a marker on the row that carries it, as the
 * pinned commit is. The rows and the graph share one row height, so a node sits on its row however the
 * list is filtered. Range and search filter the loaded commits in the page; "all" asks for more.
 *
 * Everything comes from the package's own commands: `package-log` for the list, `package-commit` for the
 * inspector, `package-diff` for the two comparisons (the pin against HEAD, HEAD against the working tree),
 * and `package-push` behind a confirm. A refusal (a package outside a git checkout, say) is shown as its
 * sentence in place of the graph. `mountHistory` returns an unmount that drops any answer arriving late. */

const ROW = 44; // px, one commit
const LANE_X = [20, 44]; // upstream, local
const GRAPH_W = 64;
const LIMIT = { "7": 60, "30": 60, all: 200 };
const SVG = "http://www.w3.org/2000/svg";

const COPY = ["M7 7h8v9H7z", "M5 13V4h8"];
const UP = ["M10 15V5", "M5.5 9.5 10 5l4.5 4.5"];

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  for (const child of children) if (child) node.append(child);
  return node;
}

/** "2h", "3d", "Sep 12": the age of a moment, short, the way the sidebar says it. */
export function ago(iso, now = Date.now()) {
  const ms = now - Date.parse(iso || "");
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The commits the range and the search keep, in the order they came. */
export function filterCommits(commits, { range = "30", query = "" } = {}, now = Date.now()) {
  const q = query.trim().toLowerCase();
  const since = range === "all" ? -Infinity : now - Number(range) * 86_400_000;
  return commits.filter((c) => {
    if (Date.parse(c.at || "") < since) return false;
    if (!q) return true;
    return [c.subject, c.author, c.hash, c.short].some((s) => String(s || "").toLowerCase().includes(q));
  });
}

export function mountHistory(ext, root, { name }) {
  const { el, icon } = ext.dom;
  const { badge, button, busy, confirm, put } = ext.ui;
  let alive = true;
  let token = 0;
  let log = null;       // the answer of package-log
  let loadedLimit = 0;
  let range = "30";
  let query = "";
  let selected = null;  // the hash the inspector shows
  let view = { kind: "none" }; // { kind: "commit", data } | { kind: "diff", data } | { kind: "note", text }

  const head = el("div", { class: "uh-head" });
  const controls = el("div", { class: "uh-controls" });
  const list = el("div", { class: "uh-list", tabindex: "0", role: "listbox", "aria-label": "Commits" });
  const graph = el("div", { class: "uh-graph", "aria-hidden": "true" });
  const rows = el("div", { class: "uh-rows" });
  const legend = el("div", { class: "uh-legend" });
  const inspector = el("div", { class: "uh-inspector card" });
  const left = el("div", { class: "uh-commits card" });
  const wrap = el("div", { class: "uh" }, head, controls, el("div", { class: "uh-body" }, left, inspector));
  root.append(wrap);
  list.append(graph, rows);

  const visible = () => (log ? filterCommits(log.commits, { range, query }) : []);
  const registryOn = (c) => Boolean(log?.registry?.commit && log.registry.commit === c.hash);

  // ---- loading ----

  async function load() {
    const mine = ++token;
    const limit = LIMIT[range];
    const stop = busy(left, "Reading the log…");
    try {
      const out = await ext.request("package-log", { args: { name, limit } });
      if (!alive || mine !== token) return;
      log = out?.data ?? null;
      loadedLimit = limit;
    } catch (err) {
      if (!alive || mine !== token) return;
      log = null;
      view = { kind: "note", text: err?.message || "The log could not be read." };
    } finally {
      stop();
    }
    if (!alive) return;
    if (log && !selected && log.commits.length) void select(log.commits[0].hash);
    draw();
  }

  async function select(hash) {
    selected = hash;
    drawRows();
    const mine = ++token;
    const stopBusy = busy(inspector, "Reading the commit…");
    try {
      const out = await ext.request("package-commit", { args: { name, hash } });
      if (!alive || mine !== token) return;
      view = { kind: "commit", data: out?.data ?? null };
    } catch (err) {
      if (!alive || mine !== token) return;
      view = { kind: "note", text: err?.message || "The commit could not be read." };
    } finally {
      stopBusy();
    }
    if (alive) drawInspector();
  }

  async function compare(from, to, label) {
    const mine = ++token;
    const stopBusy = busy(inspector, "Comparing…");
    try {
      const out = await ext.request("package-diff", { args: { name, from, to } });
      if (!alive || mine !== token) return;
      view = { kind: "diff", data: out?.data ?? null, label };
    } catch (err) {
      if (!alive || mine !== token) return;
      view = { kind: "note", text: err?.message || "The comparison could not be made." };
    } finally {
      stopBusy();
    }
    if (alive) drawInspector();
  }

  async function push(anchor) {
    if (!log) return;
    const n = log.ahead ?? 0;
    const ok = await confirm(anchor, {
      title: `Push ${n} ${n === 1 ? "commit" : "commits"}?`,
      lines: [["branch", log.branch || "?"], ["to", log.upstream || "the remote's branch of the same name"]],
      note: "Runs git push from the checkout the package lives in. Nothing in a workspace changes; the registry offers the new commit once its index is refreshed.",
      confirmLabel: "Push",
    });
    if (!ok || !alive) return;
    anchor.disabled = true;
    try {
      const out = await ext.request("package-push", { args: { name } });
      const data = out?.data ?? {};
      ext.toast(data.output?.trim() || (data.ok ? "Pushed." : "The push did not go through."), { tone: data.ok ? "good" : "error" });
    } catch (err) {
      ext.toast(err?.message || "The push did not go through.", { tone: "error" });
    } finally {
      if (alive) anchor.disabled = false;
    }
    if (alive) await load();
  }

  // ---- the head and the controls ----

  function drawHead() {
    head.replaceChildren();
    const marks = [];
    if (log) {
      if (log.ahead > 0) marks.push(badge(`${log.ahead} not pushed`, "warn"));
      if (log.behind > 0) marks.push(badge(`${log.behind} behind ${log.upstream || "upstream"}`, "warn"));
      if (log.ahead === 0 && log.behind === 0 && log.upstream) marks.push(badge(`in step with ${log.upstream}`, "ok"));
      if (log.registry) marks.push(badge(`registry ${log.registry.version}`, log.registry.commit && log.commits.some((c) => c.hash === log.registry.commit) ? "ok" : "dim"));
      if (log.pin) marks.push(badge(`pinned to ${log.pin.short}`, "accent"));
    }
    const pinBtn = button("Compare pin ↔ HEAD", { onClick: () => compare(log.pin.hash, "HEAD", `${log.pin.short} → HEAD`), disabled: !log?.pin || !log?.head });
    const treeBtn = button("Compare with working tree", { onClick: () => compare("HEAD", "WORKTREE", "HEAD → working tree"), disabled: !log?.head });
    const pushBtn = button(log?.ahead > 0 ? `Push ${log.ahead} ${log.ahead === 1 ? "commit" : "commits"}` : "Push", { tone: "primary", onClick: () => void push(pushBtn), disabled: !(log?.ahead > 0) });
    put(head, el("div", { class: "uh-title" }, el("code", {}, name), el("span", { class: "text-faint" }, log?.branch ? `on ${log.branch}${log.head ? ` at ${log.head.short}` : ""}` : "history"), ...marks), el("div", { class: "uh-actions" }, pinBtn, treeBtn, pushBtn));
  }

  function drawControls() {
    controls.replaceChildren();
    const chip = (label, on, onClick) => el("button", { type: "button", class: `uh-chip${on ? " is-on" : ""}`, onClick }, label);
    const lanes = el("div", { class: "uh-lanes" },
      el("span", { class: "text-faint" }, "Lanes"),
      el("span", { class: "uh-chip is-static" }, el("span", { class: "uh-dot is-upstream" }), log?.upstream || "upstream"),
      el("span", { class: "uh-chip is-static" }, el("span", { class: "uh-dot is-local" }), "local, not pushed"),
      el("span", { class: "uh-chip is-static" }, el("span", { class: "uh-dot is-registry" }), "registry: the commit its index names"),
      el("span", { class: "uh-chip is-static" }, el("span", { class: "uh-dot is-pin" }), "pinned")
    );
    const search = el("input", { class: "input uh-search", type: "search", placeholder: "Search commits, authors, hashes", "aria-label": "Search commits", value: query });
    search.addEventListener("input", () => { query = search.value; drawRows(); });
    put(controls, lanes, el("span", { class: "uh-gap" }), el("span", { class: "text-faint" }, "Range"), ...["7", "30", "all"].map((r) => chip(r === "all" ? "all" : `${r} d`, range === r, () => { range = r; if (LIMIT[r] > loadedLimit) void load(); else drawRows(); })), search);
  }

  // ---- the rows and the graph ----

  function drawRows() {
    rows.replaceChildren();
    graph.replaceChildren();
    if (!log) {
      rows.append(el("p", { class: "panel-hint" }, view.kind === "note" ? view.text : "Reading…"));
      return;
    }
    const shown = visible();
    if (!shown.length) {
      rows.append(el("p", { class: "panel-hint" }, log.commits.length ? "No commit matches the range and the search." : "No commit has touched this package."));
      return;
    }
    for (const c of shown) rows.append(row(c));
    graph.append(drawGraph(shown));
    legend.replaceChildren(el("span", { class: "text-faint" }, `${shown.length} of ${log.commits.length} loaded · commits touching this package only`));
  }

  function row(c) {
    const marks = [];
    if (c.pushed === false) marks.push(badge("not pushed", "warn"));
    if (c.pinned && log.pin) marks.push(badge(`pinned${log.registry ? ` · ${log.registry.version}` : ""}`, "accent"));
    if (registryOn(c)) marks.push(badge(`registry ${log.registry.version}`, "ok"));
    if (log.head && c.hash === log.head.hash) marks.push(badge("HEAD", "dim"));
    const node = el(
      "div",
      { class: `uh-row${c.hash === selected ? " is-selected" : ""}${c.pushed === false ? " is-local" : ""}`, role: "option", "aria-selected": c.hash === selected ? "true" : "false", "data-hash": c.hash, onClick: () => void select(c.hash) },
      el("code", { class: "uh-hash" }, c.short),
      el("span", { class: "uh-subject" }, ...marks, el("span", { class: "uh-subject-text", title: c.subject }, c.subject)),
      el("span", { class: "uh-author" }, c.author || ""),
      el("span", { class: "uh-age", title: c.at ? new Date(c.at).toLocaleString() : null }, ago(c.at))
    );
    return node;
  }

  /** Nodes on rows, a line per lane, and a curve where the local lane leaves the upstream. */
  function drawGraph(shown) {
    const h = shown.length * ROW;
    const g = svg("svg", { width: GRAPH_W, height: h, viewBox: `0 0 ${GRAPH_W} ${h}` });
    const y = (i) => i * ROW + ROW / 2;
    const lane = (c) => (c.pushed === false ? 1 : 0);
    const first = { 0: -1, 1: -1 };
    const last = { 0: -1, 1: -1 };
    shown.forEach((c, i) => {
      const l = lane(c);
      if (first[l] < 0) first[l] = i;
      last[l] = i;
    });
    // The upstream runs the whole height when anything is on it; the local lane from its first node to
    // where it meets the upstream (the first pushed row after its last node), or to the bottom.
    if (first[0] >= 0) g.append(svg("line", { x1: LANE_X[0], y1: y(first[0]) - ROW / 2, x2: LANE_X[0], y2: h, class: "uh-lane is-upstream" }));
    if (first[1] >= 0) {
      const join = shown.findIndex((c, i) => i > last[1] && c.pushed !== false);
      const endY = join >= 0 ? y(join) : h;
      g.append(svg("line", { x1: LANE_X[1], y1: y(first[1]), x2: LANE_X[1], y2: join >= 0 ? y(join) - ROW / 2 : h, class: "uh-lane is-local" }));
      if (join >= 0) g.append(svg("path", { d: `M${LANE_X[1]} ${y(join) - ROW / 2} C${LANE_X[1]} ${endY - 6} ${LANE_X[0]} ${endY - 14} ${LANE_X[0]} ${endY}`, class: "uh-lane is-local" }));
    }
    shown.forEach((c, i) => {
      const l = lane(c);
      const cls = ["uh-node", l ? "is-local" : "is-upstream", c.pinned ? "is-pin" : "", registryOn(c) ? "is-registry" : "", log.head && c.hash === log.head.hash ? "is-head" : "", c.hash === selected ? "is-selected" : ""].filter(Boolean).join(" ");
      g.append(svg("circle", { cx: LANE_X[l], cy: y(i), r: c.pinned || registryOn(c) ? 6 : 5, class: cls }));
    });
    return g;
  }

  // ---- the inspector ----

  function files(list) {
    const most = Math.max(1, ...list.map((f) => (f.added ?? 0) + (f.deleted ?? 0)));
    return el("div", { class: "uh-files" }, ...list.map((f) => {
      const a = f.added ?? 0;
      const d = f.deleted ?? 0;
      const bar = el("span", { class: "uh-bar" }, el("span", { class: "uh-bar-add" }), el("span", { class: "uh-bar-del" }));
      bar.firstChild.style.width = `${Math.round((a / most) * 100)}%`;
      bar.lastChild.style.width = `${Math.round((d / most) * 100)}%`;
      return el("div", { class: "uh-file" }, el("code", { class: "uh-file-path" }, f.path), bar, el("code", { class: "uh-file-count" }, `+${a} −${d}`));
    }));
  }

  function drawInspector() {
    inspector.replaceChildren();
    if (view.kind === "note") return put(inspector, el("div", { class: "card-head" }, "Commit"), el("div", { class: "card-body" }, el("p", { class: "panel-hint" }, view.text)));
    if (view.kind === "diff") {
      const d = view.data;
      return put(
        inspector,
        el("div", { class: "card-head uh-insp-head" }, el("span", {}, "Comparison"), el("span", { class: "text-faint" }, view.label)),
        el("div", { class: "card-body uh-insp-body" }, d?.summary ? el("p", { class: "uh-summary" }, d.summary) : null, d?.files?.length ? files(d.files) : el("p", { class: "panel-hint" }, "Nothing of this package differs between the two."), el("div", { class: "uh-insp-actions" }, button("Back to the commit", { onClick: () => { if (selected) void select(selected); } })))
      );
    }
    if (view.kind !== "commit" || !view.data) return put(inspector, el("div", { class: "card-head" }, "Commit"), el("div", { class: "card-body" }, el("p", { class: "panel-hint" }, "Select a commit.")));
    const c = view.data;
    const inRegistry = registryOn(c);
    const copy = button("Copy hash", { onClick: () => navigator.clipboard?.writeText(c.hash).then(() => ext.toast("Hash copied.", { tone: "good" }), () => ext.toast("The hash could not be copied.", { tone: "error" })) });
    const diff = button("Show diff", { onClick: () => compare(`${c.hash}^`, c.hash, `${c.short}^ → ${c.short}`) });
    put(
      inspector,
      el("div", { class: "card-head uh-insp-head" }, el("code", { class: "uh-insp-hash" }, c.short || c.hash.slice(0, 7)), el("span", { class: "text-faint" }, "selected commit"), c.pushed === null ? badge("upstream unknown", "dim") : c.pushed ? badge("pushed", "ok") : badge("not pushed", "warn")),
      el(
        "div",
        { class: "card-body uh-insp-body" },
        el("div", { class: "uh-insp-subject" }, c.subject),
        c.body ? el("p", { class: "uh-insp-msg" }, c.body) : null,
        el("dl", { class: "kv" },
          el("dt", {}, "author"), el("dd", {}, `${c.author || "?"} · ${ago(c.at)}${c.at ? ` (${new Date(c.at).toLocaleString()})` : ""}`),
          el("dt", {}, "on"), el("dd", {}, el("code", {}, log?.branch || "?"), log?.upstream ? el("span", { class: "text-faint" }, ` · ${c.pushed ? "in" : "ahead of"} ${log.upstream}`) : null),
          el("dt", {}, "in registry"), el("dd", {}, inRegistry ? el("span", { class: "uh-ok" }, `yes · ${log.registry.version}`) : el("span", {}, c.pushed === false ? el("span", { class: "uh-warn" }, "no, not pushed yet") : "not the commit its index names")),
          el("dt", {}, "pinned"), el("dd", {}, log?.pin?.hash === c.hash ? el("span", { class: "uh-ok" }, "this is the pinned commit") : "no")
        ),
        el("div", { class: "text-faint uh-files-head" }, `Files of this package · ${c.files?.length ?? 0} changed`),
        c.files?.length ? files(c.files) : el("p", { class: "panel-hint" }, "No file of this package in this commit."),
        el("div", { class: "uh-insp-actions" }, diff, copy)
      )
    );
  }

  function draw() {
    drawHead();
    drawControls();
    drawRows();
    drawInspector();
    if (!left.contains(list)) put(left, el("div", { class: "card-head uh-list-head" }, el("span", {}, "Commits touching this package"), legend), list);
  }

  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const shown = visible();
    if (!shown.length) return;
    event.preventDefault();
    const at = shown.findIndex((c) => c.hash === selected);
    const next = shown[Math.max(0, Math.min(shown.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next && next.hash !== selected) {
      void select(next.hash);
      rows.querySelector(`[data-hash="${CSS.escape(next.hash)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });

  draw();
  void load();
  return () => {
    alive = false;
    token += 1;
  };
}

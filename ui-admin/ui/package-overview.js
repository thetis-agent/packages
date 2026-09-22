/* The Overview tab: three cards side by side, then Files. Provenance draws the lineage (the registry's
 * copy, this copy, a promoted copy, the forks hanging off it) as one small SVG and lists source, registry,
 * pin, forks, what it depends on and what depends on it. Checkout asks `package-log` for the newest
 * commits touching the package and draws them on two lanes: what origin has on the accent lane, what is
 * only here on the warn lane, the working tree first when files are changed. Where it runs is the
 * person card from package-where.js. Every line is a fact the kernel, the index or git reported. */

import { packageFacts } from "./package-card.js";
import { whereCard } from "./package-where.js";

const short = (h) => (typeof h === "string" ? h.slice(0, 7) : "");
const ago = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

/** An SVG element with its attributes, since `el` makes HTML elements. */
function svg(tag, attrs, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  for (const child of children) node.append(typeof child === "string" ? document.createTextNode(child) : child);
  return node;
}

const text = (x, y, label, { anchor = "middle", cls = "" } = {}) => svg("text", { x, y, "text-anchor": anchor, class: `ua-lineage-text ${cls}` }, label);

/** The lineage drawing: registry → this copy → promoted copy, and the forks under this copy. */
function lineage(info, forks) {
  const reg = info.registry;
  const isSystem = info.source?.kind === "system";
  // The drawing fills the card: the viewBox is the layout, the CSS makes it as wide as the card. The end
  // nodes sit in from the edges so their two-line labels have room on both sides.
  const width = 440;
  const [xa, xb, xc] = [72, 220, 368];
  const height = 110 + Math.max(0, forks.length - 1) * 18;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "ua-lineage", role: "img", "aria-label": "Lineage: the registry, this copy, a promoted copy, and the forks" });
  const line = (x1, x2, cls) => svg("line", { x1, y1: 30, x2, y2: 30, class: `ua-lineage-line ${cls}` });
  root.append(line(xa + 16, xb - 20, reg ? "" : "is-dim"), line(xb + 20, xc - 16, "is-dim"));
  root.append(svg("circle", { cx: xa, cy: 30, r: 10, class: `ua-lineage-node is-registry${reg ? "" : " is-none"}` }));
  root.append(svg("circle", { cx: xb, cy: 30, r: 10, class: "ua-lineage-node is-this" }));
  root.append(svg("circle", { cx: xc, cy: 30, r: 10, class: `ua-lineage-node is-promoted${isSystem ? "" : " is-none"}` }));
  root.append(text(xa, 58, reg ? `registry ${reg.registry}` : "no registry entry"));
  root.append(text(xa, 72, reg ? `${reg.version} · ${short(reg.commit)}` : "not in the index", { cls: "is-mono" }));
  root.append(text(xb, 58, "this copy", { cls: "is-strong" }));
  root.append(text(xb, 72, `${info.version} · ${info.git?.commit ?? (info.source?.kind ?? "")}`, { cls: "is-mono" }));
  root.append(text(xc, 58, isSystem ? "system copy" : "promoted copy"));
  root.append(text(xc, 72, isSystem ? "this is it" : "none yet", { cls: "is-mono" }));
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  forks.forEach((f, i) => {
    const y = 96 + i * 18;
    root.append(svg("path", { d: `M${xb} 42 C${xb} ${y - 10} ${xb + 36} ${y - 10} ${xb + 36} ${y}`, class: "ua-lineage-line is-fork" }));
    root.append(svg("circle", { cx: xb + 44, cy: y, r: 5, class: "ua-lineage-node is-fork" }));
    const label = text(xb + 56, y + 4, clip(`${f.name} ${f.version} · ${f.user}`, 30), { anchor: "start", cls: "is-mono is-fork" });
    label.append(svg("title", {}, `${f.name} ${f.version} · ${f.user}`));
    root.append(label);
  });
  if (!forks.length) root.append(text(xb, 96, "no forks", { cls: "is-dim" }));
  return root;
}

function provenanceCard(ext, ctx) {
  const { el } = ext.dom;
  const { badge, card } = ext.ui;
  const info = ctx.info;
  const forks = ctx.where?.forks ?? [];
  const facts = Object.fromEntries(packageFacts(info).map(([k, v, tone]) => [k, { text: v, tone }]));
  const row = (k, v) => [el("dt", {}, k), el("dd", { class: v?.tone ? `is-${v.tone}` : null }, typeof v === "string" ? v : v?.text ?? "—")];
  const reg = info.registry;
  const rows = [
    ...row("source", facts.source),
    ...row("registry", facts.registry),
    // A reload's "installed" and "available" are versions, not commits: only the install kind has a pin to say.
    ...row("pinned to", reg?.update && reg.update.apply !== "reload" ? `${short(reg.update.installed)} · ${reg.registry} now at ${short(reg.update.available)}` : info.source?.kind === "git" ? short(/@([0-9a-f]{7,40})$/.exec(info.source.ref)?.[1] ?? "") || "no pin" : "not pinned: not a registry install"),
    ...(facts.workspace ? row("loaded", facts.workspace) : []),
    ...(facts.fork ? row("fork", facts.fork) : []),
    ...row("forks", forks.length ? el("span", {}, ...forks.flatMap((f, i) => [i ? ", " : null, el("code", {}, f.name), ` (${f.user})`]).filter(Boolean)) : "none"),
    ...row("depends on", info.dependencies?.length ? el("code", {}, info.dependencies.join(", ")) : "nothing"),
    ...row("used by", info.dependents?.length ? el("code", {}, info.dependents.join(", ")) : "nothing installed here"),
  ];
  const headBadge = info.source?.kind === "system" ? badge("shipped with Thetis", "dim") : info.source?.kind === "git" ? badge(`from ${reg?.registry ?? "a registry"}`, "accent") : badge("a directory", "dim");
  const node = card(el("span", { class: "ua-card-title" }, "Provenance", headBadge), lineage(info, forks), el("dl", { class: "kv ua-pkg-facts" }, ...rows));
  node.classList.add("ua-provenance");
  return node;
}

/** The checkout card: the branch line, the newest commits on two lanes, and a legend. Filled from `package-log`. */
function checkoutCard(ext, ctx, { alive }) {
  const { el, clear } = ext.dom;
  const { badge, button, card, put } = ext.ui;
  const info = ctx.info;
  const git = info.git;
  const body = el("div", { class: "ua-checkout-body" });
  const head = el("span", { class: "ua-card-title" }, "Checkout", ctx.tag("admin"));
  const node = card(head, body);
  node.classList.add("ua-checkout");
  if (!git) {
    put(body, el("p", { class: "text-faint" }, "The files are not in a git checkout, so there is no branch, no upstream and nothing to push."));
    return node;
  }
  if (git.ahead) head.append(badge(`${git.ahead} ahead`, "warn"));
  head.append(badge(`${git.branch ?? "detached"} · ${git.commit ?? ""}`, "dim"));
  const sync = [];
  if (git.upstream) {
    sync.push(el("span", { class: "text-faint" }, git.upstream));
    sync.push(el("span", { class: git.ahead ? "ua-warn" : "ua-ok" }, git.ahead ? `${git.ahead} not pushed` : "nothing to push"));
    sync.push(el("span", { class: git.behind ? "ua-warn" : "ua-ok" }, `${git.behind} behind`));
  } else sync.push(el("span", { class: "text-faint" }, "no upstream branch tracked"));
  sync.push(el("span", { class: git.changed ? "ua-warn" : "text-faint" }, git.changed ? `${git.changed} file${git.changed === 1 ? "" : "s"} changed here, uncommitted` : "nothing uncommitted here"));
  const open = button("Open history", { onClick: () => ctx.show("history") });
  open.classList.add("is-sm");
  put(body, el("div", { class: "ua-sync-line" }, ...sync.flatMap((s, i) => (i ? [el("span", { class: "ua-sep" }, "·"), s] : [s])), el("span", { class: "toolbar-gap" }), open));
  const graph = el("div", { class: "ua-mini-graph" }, el("p", { class: "text-faint" }, "Reading the commits…"));
  put(body, graph, el("div", { class: "ua-legend" }, el("span", {}, el("span", { class: "ua-dot is-accent" }), ` ${git.upstream ?? "pushed"}`), el("span", {}, el("span", { class: "ua-dot is-warn" }), " local, not pushed"), el("span", {}, "commits touching this package only")));

  void (async () => {
    let log = null;
    try {
      log = (await ext.request("package-log", { args: { name: ctx.name, limit: 5 } }))?.data ?? null;
    } catch (err) {
      if (!alive()) return;
      clear(graph);
      return void put(graph, el("p", { class: "text-faint" }, `The commits could not be read: ${err.message}`));
    }
    if (!alive()) return;
    clear(graph);
    const commits = Array.isArray(log?.commits) ? log.commits.slice(0, 5) : [];
    const rows = [];
    if (git.changed) rows.push(el("div", { class: "ua-mini-row is-working" }, el("span", { class: "ua-mini-lane" }, el("span", { class: "ua-dot is-hollow" })), el("code", { class: "text-faint" }, "working"), el("span", { class: "ua-mini-subject text-faint" }, `${git.changed} file${git.changed === 1 ? "" : "s"} changed, not committed`)));
    for (const c of commits) {
      rows.push(
        el(
          "div",
          { class: `ua-mini-row${c.pushed === false ? " is-local" : " is-pushed"}` },
          el("span", { class: "ua-mini-lane" }, el("span", { class: `ua-dot ${c.pushed === false ? "is-warn" : "is-accent"}` })),
          el("code", { class: c.pushed === false ? "ua-warn" : "ua-accent" }, c.short ?? short(c.hash)),
          el("span", { class: "ua-mini-subject", title: c.subject }, c.subject),
          c.pinned ? badge("pinned", "dim") : null,
          el("span", { class: "text-faint" }, ago(c.at))
        )
      );
    }
    if (!rows.length) rows.push(el("p", { class: "text-faint" }, "No commit touches this package."));
    put(graph, ...rows);
  })();
  return node;
}

function filesCard(ext, ctx) {
  const { el } = ext.dom;
  const { card } = ext.ui;
  const info = ctx.info;
  const readme = el("a", { href: "#readme", onClick: (e) => { e.preventDefault(); ctx.show("readme"); } }, "read it here");
  const node = card(
    el("span", { class: "ua-card-title" }, "Files", ctx.tag("admin")),
    el(
      "div",
      { class: "ua-files" },
      el("dl", { class: "kv" }, el("dt", {}, "checkout"), el("dd", {}, el("code", {}, info.root ?? "—")), el("dt", {}, "in a fence"), el("dd", {}, el("code", {}, `store/node_modules/${info.name}`), el("span", { class: "text-faint" }, info.source?.kind === "system" ? " → the checkout, read-only" : ""))),
      el("dl", { class: "kv" }, el("dt", {}, "source"), el("dd", {}, info.source?.kind ?? "—", info.source?.ref ? [" · ", el("code", {}, info.source.ref)] : null), el("dt", {}, "README"), el("dd", {}, readme))
    )
  );
  node.classList.add("ua-files-card");
  return node;
}

export function mountOverview(ext, host, ctx) {
  const { el } = ext.dom;
  let alive = true;
  if (!ctx.info) {
    // No record anywhere: the provenance, checkout and files have nothing to say, but the people do, and the
    // where card is where an admin installs it again.
    host.append(el("p", { class: "panel-hint" }, `${ctx.name} is installed in no workspace, so nothing can be read about its files. Install it for someone below.`));
    if (ctx.where) host.append(el("div", { class: "ua-pkg-grid is-one" }, whereCard(ext, ctx, { alive: () => alive })));
    return () => {
      alive = false;
    };
  }
  host.append(
    el("div", { class: "ua-pkg-grid" }, provenanceCard(ext, ctx), checkoutCard(ext, ctx, { alive: () => alive }), whereCard(ext, ctx, { alive: () => alive })),
    filesCard(ext, ctx)
  );
  return () => {
    alive = false;
  };
}

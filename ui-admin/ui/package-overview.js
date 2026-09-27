/* The Overview tab: three cards side by side, then Files. Provenance draws the lineage (the registry's
 * copy, this copy, the copy everyone gets, the customised copies hanging off it) as one small SVG and lists
 * source, registry, pin, everyone's copy ("Tool Exec 0.4.1 (Thetis's)" for a copy), the customised copies (the
 * reader's folder copies included), what it depends on and what depends on it. A shared copy is a "Shared
 * copy" and says whose extension it was shared from and when ("Shared with everyone from @bitmuse/notion by
 * bitmuse on 2026-09-24"), never "shipped with Thetis". Checkout asks `package-log` for the newest
 * commits touching the package and draws them on two lanes: what origin has on the accent lane, what is
 * only here on the warn lane, the working tree first when files are changed. Where it runs is the
 * person card from package-where.js. Every line is a fact the kernel, the index or git reported. */

import { packageFacts } from "./package-card.js";
import { failureSentence } from "./failed.js";
import { whereCard } from "./package-where.js";
import { titleCase } from "./state.js";

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

/**
 * The copy everyone gets, in words: "Notion 0.1.1 (Thetis's)" for a copy whose official version is everyone's,
 * "this one" for a shared or everyone's extension, the shared copy's name for an original that was shared, or
 * null when everyone gets none.
 */
export function everyonesCopy(info, label) {
  if (info.everyoneBy === "promoted" || info.everyone) return "this one";
  const official = titleCase(info.origin?.label ?? label);
  if (info.origin?.everyone) return `${official}${info.origin.version ? ` ${info.origin.version}` : ""} (Thetis's)`;
  if (info.fork?.everyone) return `${official}${info.fork.shipped ? ` ${info.fork.shipped}` : ""} (Thetis's)`;
  if (info.sharedAs) return `${label} (shared)`;
  return null;
}

/** The lineage drawing: registry → this copy → the copy everyone gets, and the customised copies under this one. */
function lineage(info, forks, label) {
  const reg = info.registry;
  const everyone = everyonesCopy(info, label);
  // A narrow viewBox, so the words stay readable when the card is a third of the page.
  const width = 300;
  const [xa, xb, xc] = [52, 150, 248];
  const height = 104 + Math.max(0, forks.length - 1) * 18;
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "ua-lineage", role: "img", "aria-label": "Lineage: the registry, this copy, the copy everyone gets, and people's customised copies" });
  const line = (x1, x2, cls) => svg("line", { x1, y1: 22, x2, y2: 22, class: `ua-lineage-line ${cls}` });
  root.append(line(xa + 12, xb - 14, reg ? "" : "is-dim"), line(xb + 14, xc - 12, everyone ? "" : "is-dim"));
  root.append(svg("circle", { cx: xa, cy: 22, r: 8, class: `ua-lineage-node is-registry${reg ? "" : " is-none"}` }));
  root.append(svg("circle", { cx: xb, cy: 22, r: 8, class: "ua-lineage-node is-this" }));
  root.append(svg("circle", { cx: xc, cy: 22, r: 8, class: `ua-lineage-node is-promoted${everyone ? "" : " is-none"}` }));
  const labelled = (x, y, words, cls, n = 15) => {
    const t = text(x, y, clip(words, n), { cls });
    t.append(svg("title", {}, words));
    return t;
  };
  root.append(text(xa, 46, reg ? "registry" : "no registry"));
  root.append(labelled(xa, 60, reg ? `${reg.registry} ${reg.version}` : "not listed", "is-mono"));
  root.append(text(xb, 46, "this copy", { cls: "is-strong" }));
  root.append(labelled(xb, 60, `${info.version}${info.git?.commit ? ` · ${info.git.commit}` : ""}`, "is-mono"));
  root.append(text(xc, 46, "everyone's copy"));
  root.append(labelled(xc, 60, everyone ?? "none", "is-mono"));
  forks.forEach((f, i) => {
    const y = 90 + i * 18;
    // From under this copy's two lines of words, so the curve never crosses them.
    root.append(svg("path", { d: `M${xb} 68 C${xb} ${y} ${xb} ${y} ${xb + 22} ${y}`, class: "ua-lineage-line is-fork" }));
    root.append(svg("circle", { cx: xb + 24, cy: y, r: 4, class: "ua-lineage-node is-fork" }));
    root.append(labelled(xb + 30, y + 4, `${f.label ?? f.name.replace(/^@[^/]+\//, "")} · ${f.user}`, "is-mono is-fork", 17));
    root.lastChild.setAttribute("text-anchor", "start");
  });
  if (!forks.length) root.append(text(xb, 90, "no customised copies", { cls: "is-dim" }));
  return root;
}

function provenanceCard(ext, ctx) {
  const { el } = ext.dom;
  const { badge, card } = ext.ui;
  const info = ctx.info;
  const label = ctx.label ?? info.label ?? info.name;
  const forks = ctx.where?.forks ?? [];
  const facts = Object.fromEntries(packageFacts(info).map(([k, v, tone]) => [k, { text: v, tone }]));
  const row = (k, v) => [el("dt", {}, k), el("dd", { class: v?.tone ? `is-${v.tone}` : null }, typeof v === "string" ? v : v?.text ?? "—")];
  const reg = info.registry;
  const everyone = everyonesCopy(info, label);
  const copies = forks.map((f) => `${f.label ?? f.name} (${f.user}${f.folder && !f.installed ? ", in the folder" : ""})`);
  const rows = [
    ...row("source", facts.source),
    ...row("registry", facts.registry),
    // A reload's "installed" and "available" are versions, not commits: only the install kind has a pin to say.
    ...row("pinned to", reg?.update?.apply === "install" ? `${short(reg.update.installed)} · ${reg.registry} now at ${short(reg.update.available)}` : info.source?.kind === "git" ? short(/@([0-9a-f]{7,40})$/.exec(info.source.ref)?.[1] ?? "") || "no pin" : "not pinned: not a registry install"),
    ...row("everyone's copy", everyone ? (everyone === "this one" ? "This one" : everyone) : "None: nobody gets it by default"),
    ...(facts.workspace ? row("loaded", facts.workspace) : []),
    ...(facts["own copy"] ? row("customised from", facts["own copy"]) : []),
    ...row("customised copies", copies.length ? copies.join(", ") : "none"),
    ...row("depends on", info.dependencies?.length ? el("code", {}, info.dependencies.join(", ")) : "nothing"),
    ...row("used by", info.dependents?.length ? el("code", {}, info.dependents.join(", ")) : "nothing installed here"),
  ];
  const headBadge = info.everyoneBy === "promoted" ? badge("Shared copy", "accent") : info.forkedFrom ? badge("Customised copy", "dim") : info.source?.kind === "system" ? badge("by Thetis", "dim") : info.source?.kind === "git" ? badge(`from ${reg?.registry ?? "a registry"}`, "accent") : badge("in a folder", "dim");
  const node = card(el("span", { class: "ua-card-title" }, "Provenance", headBadge), lineage(info, forks, label), el("dl", { class: "kv ua-pkg-facts" }, ...rows));
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
  put(body, graph, el("div", { class: "ua-legend" }, el("span", {}, el("span", { class: "ua-dot is-accent" }), ` ${git.upstream ?? "pushed"}`), el("span", {}, el("span", { class: "ua-dot is-warn" }), " local, not pushed"), el("span", {}, "commits touching this extension only")));

  void (async () => {
    let log = null;
    try {
      log = (await ext.request("package-log", { args: { name: ctx.name, limit: 5 } }))?.data ?? null;
    } catch (err) {
      if (!alive()) return;
      clear(graph);
      return void put(graph, el("p", { class: "text-faint" }, failureSentence("The commits", err, { admin: true })));
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
    if (!rows.length) rows.push(el("p", { class: "text-faint" }, "No commit touches this extension."));
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
      el("dl", { class: "kv" }, el("dt", {}, "checkout"), el("dd", {}, el("code", {}, info.root ?? "—")), el("dt", {}, "in a workspace"), el("dd", {}, el("code", {}, `store/node_modules/${info.name}`), el("span", { class: "text-faint" }, info.source?.kind === "system" ? " → the checkout, read-only" : ""))),
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
    host.append(el("p", { class: "panel-hint" }, `Nobody has ${ctx.label ?? ctx.name} now, so nothing can be read about its files. Install it for someone below.`));
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

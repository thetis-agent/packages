/* The Overview tab: three cards side by side, then Files. Provenance draws the lineage (the registry's
 * copy, this copy, the copy everyone gets, the customized copies hanging off it) as one small SVG, every name
 * whole, and lists in plain words with labels rather than ids: Source ("shared from Notion (your original) on 27
 * September 2026"), Registry ("not in any registry"), Pinned to (a registry install's only), Everyone's copy
 * ("Tool Exec 0.4.1 (Thetis's)" for a copy), the customized copies (the reader's folder copies included), what it
 * depends on and what depends on it. A shared copy is a "Shared copy", never "shipped with Thetis". Checkout asks `package-log` for the newest
 * commits touching the package and draws them on two lanes: what origin has on the accent lane, what is
 * only here on the warn lane, the working tree first when files are changed. Where it runs is the
 * person card from package-where.js. Every line is a fact the kernel, the index or git reported. */

import { packageFacts } from "./package-card.js";
import { failureSentence } from "./failed.js";
import { whereCard } from "./package-where.js";
import { baseOf, dateWords, scopeOf, titleCase } from "./state.js";

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

/** Words broken into lines of at most `n` characters, a long word on a line of its own. */
export function wrapWords(text, n = 14) {
  const lines = [];
  for (const word of String(text ?? "").split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= n) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length ? lines : [""];
}

/**
 * The lineage drawing: registry → this copy → the copy everyone gets, and the customized copies under this one.
 * Every name is whole, wrapped onto lines rather than cut, in type no smaller than the page's small print.
 */
function lineage(info, forks, label, user = "") {
  const reg = info.registry;
  const everyone = everyonesCopy(info, label);
  // A viewBox no wider than the card, so 11px type stays 11px or more.
  const width = 262;
  const [xa, xb, xc] = [44, 130, 214];
  const cols = [
    [xa, "registry", reg ? [...wrapWords(reg.registry, 12), reg.version] : wrapWords("not in any", 12)],
    [xb, "this copy", [...wrapWords(label, 12), info.version]],
    [xc, "everyone gets", everyone ? wrapWords(everyone === "this one" ? "this one" : everyone, 12) : ["none"]],
  ];
  const tallest = Math.max(...cols.map(([, , lines]) => lines.length));
  const top = 60 + tallest * 14; // where the copies start
  const forkLines = forks.map((f) => wrapWords(`${titleCase(f.label ?? f.name.replace(/^@[^/]+\//, ""))} · ${f.user === user ? "you" : f.user}${f.folder && !f.installed ? " (in the folder)" : ""}`, 16));
  const height = top + 10 + Math.max(1, forkLines.reduce((n, l) => n + l.length, 0)) * 14 + forks.length * 4;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "ua-lineage", role: "img", "aria-label": "Lineage: the registry, this copy, the copy everyone gets, and people's customized copies" });
  const line = (x1, x2, cls) => svg("line", { x1, y1: 22, x2, y2: 22, class: `ua-lineage-line ${cls}` });
  root.append(line(xa + 12, xb - 14, reg ? "" : "is-dim"), line(xb + 14, xc - 12, everyone ? "" : "is-dim"));
  root.append(svg("circle", { cx: xa, cy: 22, r: 8, class: `ua-lineage-node is-registry${reg ? "" : " is-none"}` }));
  root.append(svg("circle", { cx: xb, cy: 22, r: 8, class: "ua-lineage-node is-this" }));
  root.append(svg("circle", { cx: xc, cy: 22, r: 8, class: `ua-lineage-node is-promoted${everyone ? "" : " is-none"}` }));
  for (const [x, head, lines] of cols) {
    root.append(text(x, 46, head, { cls: x === xb ? "is-strong" : "" }));
    lines.forEach((l, i) => root.append(text(x, 60 + i * 14, l, { cls: "is-name" })));
  }
  let y = top + 10;
  forks.forEach((f, i) => {
    // From under this copy's words, so the curve never crosses them.
    root.append(svg("path", { d: `M${xb} ${top - 6} C${xb} ${y} ${xb} ${y} ${xb + 22} ${y}`, class: "ua-lineage-line is-fork" }));
    root.append(svg("circle", { cx: xb + 24, cy: y, r: 4, class: "ua-lineage-node is-fork" }));
    forkLines[i].forEach((l, j) => {
      const t = text(xb + 32, y + 4 + j * 14, l, { anchor: "start", cls: "is-name is-fork" });
      root.append(t);
    });
    y += forkLines[i].length * 14 + 4;
  });
  if (!forks.length) root.append(text(xb, top + 10, "no customized copies", { cls: "is-dim" }));
  return root;
}

/**
 * Where a copy's files came from, in plain words with labels rather than ids: "shared from Notion (your
 * original) on 27 September 2026", "by Thetis", "a folder in your home: packages/notion", or the registry's
 * repository.
 */
export function sourceWords(info, { user = "", label = "" } = {}) {
  const src = info.source;
  if (info.everyoneBy === "promoted") {
    const from = info.promotedFrom;
    if (!from?.name) return "shared from a person's extension";
    const whose = from.by ? (from.by === user ? "your original" : `${from.by}'s original`) : "the original";
    const on = dateWords(from.at);
    return `shared from ${label || titleCase(baseOf(from.name))} (${whose})${on ? ` on ${on}` : ""}`;
  }
  if (!src) return "not known";
  if (src.kind === "system") return scopeOf(info.name) === "thetis" || !scopeOf(info.name) ? "by Thetis" : `by ${scopeOf(info.name) === user ? "you" : scopeOf(info.name)}, kept on the server`;
  if (src.kind === "local") {
    const who = scopeOf(info.name);
    const dir = String(src.ref ?? "").replace(/^.*?(packages\/[^/]+)\/?$/, "$1");
    return `a folder in ${who === user ? "your" : who ? `${who}'s` : "a"} home${dir ? `: ${dir}` : ""}`;
  }
  const ref = String(src.ref ?? "");
  const pin = /@([0-9a-f]{7,40})$/.exec(ref);
  const rest = pin ? ref.slice(0, -pin[0].length) : ref;
  return rest.replace(/#.*$/, "") || "a registry";
}

function provenanceCard(ext, ctx) {
  const { el } = ext.dom;
  const { badge, card } = ext.ui;
  const info = ctx.info;
  const user = ctx.user ?? "";
  const label = ctx.label ?? info.label ?? info.name;
  const forks = ctx.where?.forks ?? [];
  const facts = Object.fromEntries(packageFacts(info).map(([k, v, tone]) => [k, { text: v, tone }]));
  const row = (k, v) => [el("dt", {}, k), el("dd", { class: v?.tone ? `is-${v.tone}` : null }, typeof v === "string" ? v : v?.text ?? "—")];
  const reg = info.registry;
  const everyone = everyonesCopy(info, label);
  const copyWord = (f) => `${f.label ? titleCase(f.label) : titleCase(baseOf(f.name))} (${f.user === user ? "yours" : `${f.user}'s`}${f.folder && !f.installed ? ", in the folder" : ""})`;
  const copies = forks.map(copyWord);
  const official = info.forkedFrom ? `${titleCase(info.origin?.label ?? label)} ${info.forkedFrom.version ?? ""} (${info.forkedFrom.name.startsWith("@thetis/") ? "Thetis's" : scopeOf(info.forkedFrom.name) === user ? "your original" : `${scopeOf(info.forkedFrom.name)}'s`})`.replace(/\s+\(/, " (") : null;
  const pinned = info.source?.kind === "git";
  const rows = [
    ...row("Source", sourceWords(info, { user, label })),
    ...row("Registry", reg ? `${reg.registry}${reg.version ? ` holds ${reg.version}` : ""}${reg.update?.apply === "install" ? `; ${reg.update.version} is newer` : ""}` : "not in any registry"),
    // A pin is a registry install's; anything else has none to speak of.
    ...(pinned ? row("Pinned to", reg?.update?.apply === "install" ? `${short(reg.update.installed)} · ${reg.registry} now at ${short(reg.update.available)}` : short(/@([0-9a-f]{7,40})$/.exec(info.source.ref)?.[1] ?? "") || "no pin") : []),
    ...row("Everyone's copy", everyone ? (everyone === "this one" ? "This one" : everyone) : "None: nobody gets it by default"),
    ...(info.loaded?.behindDisk ? row("Loaded", { text: `${info.loaded.user === user ? "Your" : `${info.loaded.user}'s`} workspace is waiting for a reload (${info.version} is ready once it restarts)`, tone: "warn" }) : []),
    ...(official ? row("Customized from", { text: official, tone: facts["own copy"]?.tone }) : []),
    ...row("Customized copies", copies.length ? copies.join(", ") : "none"),
    ...row("Depends on", info.dependencies?.length ? el("code", {}, info.dependencies.join(", ")) : "nothing"),
    ...row("Used by", info.dependents?.length ? el("code", {}, info.dependents.join(", ")) : "nothing installed here"),
  ];
  const headBadge = info.everyoneBy === "promoted" ? badge("Shared copy", "accent") : info.forkedFrom ? badge("Customized copy", "dim") : info.source?.kind === "system" ? badge(scopeOf(info.name) === "thetis" ? "by Thetis" : `by ${scopeOf(info.name) === user ? "you" : scopeOf(info.name)}`, "dim") : info.source?.kind === "git" ? badge(`from ${reg?.registry ?? "a registry"}`, "accent") : badge("in a folder", "dim");
  const node = card(el("span", { class: "ua-card-title" }, "Provenance", headBadge), lineage(info, forks, label, user), el("dl", { class: "kv ua-pkg-facts" }, ...rows));
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

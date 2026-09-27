/* One extension's page. It leads with what a person decides on: the name, the one-line summary, what they
 * get (tools, skills, pages), whether setup is needed, and **Install** or **Update** at the top. Admins' acts
 * for everyone sit under it in a quieter group. Two tabs follow: **Overview**, the tools one by one with what
 * each does, and **Technical details**, the README (rendered by the shell's markdown, which builds DOM and
 * never sets innerHTML; its local pictures come with the answer and are drawn from data: URLs, so the page
 * fetches nothing), the facts (versions, pins, source, steps, benchmarks, what was published) and the Publish
 * block. Everything comes from one `show` answer; an admin's people for the picker come from `people`. An
 * installed extension also gets its configuration report from `config-show`: the page says the kernel's one
 * sentence when something is missing, and **Configure** opens the shared form on the person's own layer,
 * where the row for each key says its state and offers the fix. It also asks `publish-targets` where this
 * space may publish, which carries the last publish to each target from that package's own store; that
 * answer is `available: false` on every installation without @thetis/package-publish, which is most of them,
 * and then no Publish block and no record row is drawn and nothing throws. It is asked twice: once without a
 * package, which costs nothing and is what the block is drawn from, and then -- only where the index says
 * nothing about this package -- once about the package, which reaches every registry and so goes out after
 * the page is drawn and fills in one line. `open` returns an unmount that stops a late answer from drawing
 * into a closed page. */

import { actionsFor } from "./actions.js";
import { publishRecord, stateBadges, technicalBadges } from "./badges.js";
import { configCard, summaryLine } from "./config-form.js";
import { updater } from "./updates-notice.js";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 tools · 2 skills · 1 page", or null when the extension brings none of the three. Exported for the tests. */
export function whatYouGet(r) {
  const parts = [r.tools?.length ? plural(r.tools.length, "tool") : null, r.skills ? plural(r.skills, "skill") : null, r.pages ? plural(r.pages, "page") : null, r.service ? "runs in the background" : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function openPage(ext, root, params) {
  const { el, clear } = ext.dom;
  const { badge, button, card, heading, kv, put, tags, when } = ext.ui;
  const name = params.name;
  let alive = true;

  const crumbBack = button("Extensions", { tone: "quiet" });
  crumbBack.addEventListener("click", () => ext.open.place("marketplace", {}));
  const crumb = el("nav", { class: "mk-crumb", "aria-label": "Where you are" }, crumbBack, el("span", { class: "mk-crumb-sep", "aria-hidden": "true" }, "›"), el("code", { class: "mk-crumb-name" }, name));
  const body = el("div", { class: "mk-page" }, el("p", { class: "panel-empty" }, "Loading…"));
  const configHost = el("section", { class: "mk-config", "aria-label": "Configuration", hidden: true });
  root.append(el("div", { class: "place-page mk-place" }, crumb, body, configHost));

  async function load() {
    let view;
    try {
      const out = await ext.request("show", { args: { name } });
      if (!alive) return;
      view = out?.data ?? {};
      if (!view.row) throw new Error(`${name} could not be read.`);
    } catch (err) {
      if (!alive) return;
      clear(body);
      body.append(el("p", { class: "mk-error" }, "This extension could not be read just now."), err?.message ? el("details", { class: "mk-details" }, el("summary", {}, "Details"), el("pre", { class: "mk-wrap" }, err.message)) : null);
      return;
    }
    const [people, config, publish] = await Promise.all([view.role !== "user" ? loadPeople() : [], view.row.installed ? loadConfig() : null, view.row.installed ? loadPublish() : null]);
    view.people = people;
    view.config = config;
    view.publish = publish;
    if (alive) draw(view);
  }

  /** The person's own report for an installed package, or null when the kernel cannot give one; the card then says nothing about it. */
  async function loadConfig() {
    try {
      const out = await ext.request("config-show", { args: { name } });
      return out?.data && Array.isArray(out.data.keys) ? out.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Where this workspace may publish. Asked without a package name, so it is the cheap question -- which
   * targets are configured -- and not the expensive one, which would mean reaching every registry on every
   * page open. What each target holds for this package is settled by the dry run in front of the confirm,
   * where it is wanted and where it is worth waiting for. A failure here is null and no Publish block.
   */
  async function loadPublish() {
    try {
      const out = await ext.request("publish-targets");
      return out?.data?.available ? out.data : null;
    } catch {
      return null;
    }
  }

  /** Opens the form under the README, once; a later click scrolls to it. The card's sentence follows every write. */
  function openConfig(view, sentence) {
    if (!configHost.hidden) return configHost.scrollIntoView({ behavior: "smooth", block: "start" });
    const write = (verb, args) => ext.request(verb, { args: { name, ...args } }).then((out) => out?.data);
    const closeBtn = button("Close", { tone: "quiet", onClick: () => { configHost.hidden = true; clear(configHost); } });
    put(
      configHost,
      el("div", { class: "mk-config-head" }, heading("Configuration", "your own values for this extension"), closeBtn),
      configCard(ext, view.config, {
        layer: "user",
        set: (key, value) => write("config-set", { key, value }),
        unset: (key) => write("config-unset", { key }),
        onReport: (next) => {
          view.config = next;
          sentence.hidden = !next.broken;
          if (sentence.parentElement) sentence.parentElement.hidden = !next.broken;
          sentence.replaceChildren(next.broken ? summaryLine(ext, next) : "");
        },
      }),
      el("p", { class: "panel-hint" }, "A value set here is yours alone and is used from the extension's next call. A secret is written and never shown again. A key marked admins only is set in the control panel, for everyone.")
    );
    configHost.hidden = false;
    configHost.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function loadPeople() {
    try {
      const out = await ext.request("people");
      return Array.isArray(out?.data) ? out.data : [];
    } catch {
      return [];
    }
  }

  /** A README's `![alt](bench/x/chart.svg)` resolves to the copy `show` sent, or to its alt text. */
  function imageOf(assets) {
    return (src) => {
      const asset = assets && Object.prototype.hasOwnProperty.call(assets, src) ? assets[src] : null;
      if (!asset || typeof asset.data !== "string") return null;
      if (asset.type === "image/svg+xml") return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asset.data)}`;
      if (asset.type === "image/png") return `data:image/png;base64,${asset.data}`;
      return null;
    };
  }

  function readme(text, assets) {
    if (typeof text !== "string" || !text.trim()) return el("p", { class: "mk-none" }, "This extension has no README.");
    return el("div", { class: "md mk-readme-body" }, ext.markdown(text, { image: imageOf(assets) }));
  }

  /** The version facts, for the Technical details tab: what is here, what the registry holds, and what is behind. */
  function versionRows(r, publishedLine) {
    const rows = [];
    if (r.installed) rows.push(["version", el("code", {}, r.version)]);
    if (r.installed && r.pin) rows.push(["commit", el("code", {}, r.pin)]);
    if (r.available) rows.push(["registry", el("span", {}, el("code", {}, r.tip || r.version), r.registry ? el("span", { class: "text-dim" }, ` in ${r.registry}`) : null)]);
    // One state for the person, whatever catches it up; the commit pair is here, where the technical words live.
    if (r.update?.apply === "reload") rows.push(["update", el("span", {}, `Update ready: ${r.update.installed} → ${r.update.available}`)]);
    else if (r.update && r.update.apply !== "unfork") rows.push(["update", el("span", {}, `Update ready: ${r.update.version}`, el("span", { class: "text-dim" }, ` (${r.update.registry}, ${r.update.from} → ${r.update.to})`))]);
    // And the other direction: the version here is newer than the one every other installation can reach, or
    // no registry holds this package at all.
    if (r.ahead?.state === "ahead") rows.push(["published", el("span", {}, el("code", {}, r.ahead.published), ` in ${r.ahead.registry} — ${r.ahead.version} is what is here`)]);
    // The index's own statement, then whatever this space's own record adds to it once it has been asked. The
    // line is a node the enrichment fills in later rather than a redraw, because a redraw would take the
    // publish panel with it.
    else if (r.ahead) rows.push(["published", publishedLine]);
    return rows;
  }

  /**
   * What is known about this package being published, in the order the two witnesses can be trusted.
   *
   * The index is the first and it is the one every surface has: it lists the registries this installation
   * mirrors, so when it does not carry a package the honest thing to say is exactly that -- not that the
   * package was never published, which is a claim about the world the index cannot make. `thetis packages
   * outdated` prints that sentence, the gallery card carries it as a badge, and this row says it too.
   *
   * The second is this workspace's own record, which only a page asking about one package can afford to
   * fetch. It is first-hand: the person published it from here, to a target that need not be mirrored here
   * at all, and nothing else in the product knows. It is said here rather than in the badge because a badge
   * has to mean the same thing on the card the person clicked to get here, where the record cannot be had.
   */
  function sayPublished(r, answer) {
    const record = publishRecord(answer, r.name);
    if (record) {
      const act = record.removed ? `taken out of ${record.target}` : `to ${record.target}`;
      return { dim: record.removed, nodes: [el("code", {}, record.version || r.version), ` ${act} · ${when(record.at)}, by this space's own record. No registry here lists it.`] };
    }
    // Asked and answered with nothing, which is not the same as not having asked: this person has neither
    // published this package from here nor taken it out, and the row is allowed to say so.
    if (answer) return { dim: true, nodes: ["no registry here lists it, and nothing has gone from here to a target yet"] };
    return { dim: true, nodes: ["no registry here lists it"] };
  }

  /** Fills the published line, which starts as the index's sentence and never ends up empty. */
  function fillPublished(line, r, answer) {
    const said = sayPublished(r, answer);
    line.className = said.dim ? "text-dim" : "";
    line.replaceChildren(...said.nodes);
  }

  /**
   * The expensive half of `publish-targets`, asked about one package and only where it could change what
   * the row says: the index is silent about this package, and something here can publish. It clones or
   * fetches every target, so it goes out after the page is drawn and updates one line when it lands --
   * the page never waits on it, and a failure leaves the index's own sentence standing, which is true.
   */
  async function enrich(view, line) {
    try {
      const out = await ext.request("publish-targets", { args: { package: name } });
      if (!alive || !out?.data?.available) return;
      fillPublished(line, view.row, out.data);
    } catch {
      return;
    }
  }

  /**
   * What was last published, per target, from the publishing package's own record. That record is the only
   * one there is: a publish is not a journal act, because the journal is the kernel's account of what the
   * kernel did and there is no seam for a package inside a fence to append to it -- rightly, since a log
   * anything may write into is a log nobody can lean on. So the package keeps its history in its own store
   * and hands it back here, which is what makes it a record rather than a write-only gesture.
   *
   * The row names the package, because the record is the last publish to that *target*, whatever it was
   * of, and on this page that is very often some other package. Absent without a word when there is none.
   */
  function publishRows(view) {
    const targets = view.publish?.targets ?? [];
    const many = targets.filter((t) => t.lastPublish || t.lastRemoval).length > 1;
    return targets.flatMap((t) => [
      t.lastPublish && [many ? `last publish to ${t.name}` : "last publish", act(t.lastPublish, `to ${t.lastPublish.target}`)],
      // The other act against the same registry, shown in its own right rather than folded into the one
      // above. A target whose last act was a removal would otherwise read as though it last saw a publish,
      // which is the one thing a person must not have to work out from a version they half remember.
      t.lastRemoval && [many ? `last removal from ${t.name}` : "last removal", act(t.lastRemoval, `out of ${t.lastRemoval.target}`)],
    ].filter(Boolean));
  }

  /** One record as a line: what it was of, where it went, and when. */
  function act(doc, where) {
    return el("span", {}, el("code", {}, doc.version ? `${doc.name}@${doc.version}` : doc.name), ` ${where}`, doc.at ? el("span", { class: "text-dim" }, ` · ${when(doc.at)}`) : null);
  }

  /** The Overview tab: each tool with what it does, and the pages and skills it adds. */
  function overview(r) {
    const tools = r.tools.length
      ? el("ul", { class: "mk-tools" }, ...r.tools.map((t) => el("li", { title: t.description || null }, el("code", {}, t.name), t.description ? el("span", { class: "text-dim" }, ` — ${firstSentence(t.description)}`) : null)))
      : null;
    const lines = [
      r.skills ? el("p", {}, `${plural(r.skills, "skill")} your agent can use when a conversation needs ${r.skills === 1 ? "it" : "them"}.`) : null,
      r.pages ? el("p", {}, `${plural(r.pages, "page")} on the screen: a place, a panel or a dock.`) : null,
      r.service ? el("p", {}, "It runs in the background for you.") : null,
    ].filter(Boolean);
    if (!tools && !lines.length) return el("p", { class: "mk-none" }, "See Technical details for what it does.");
    return el("div", { class: "mk-overview" }, tools ? heading(`Tools (${r.tools.length})`) : null, tools, ...lines);
  }

  /** A tool's description can be long; the Overview shows its first sentence, and the title the whole. */
  function firstSentence(text) {
    const m = /^(.+?[.!?])(\s|$)/.exec(text);
    return m ? m[1] : text;
  }

  /** Who made a system package everyone's default, as a clause: the one fact that decides whether an admin can undo it here. */
  const everyoneBy = (r) => (r.everyoneBy === "config" ? " · by the installation's configuration" : r.everyoneBy === "promoted" ? " · made so from a person's copy" : r.everyoneBy === "marked" ? " · marked by an admin" : "");

  function benchRows(r) {
    const bench = r.bench;
    if (!bench?.suites?.length) return [];
    const reports = bench.reports || [];
    const ran = new Set(reports.map((x) => x.suite));
    return [
      ["bench suites", tags(bench.suites.map((s) => (ran.has(s) ? s : `${s} (not run)`)), "dim")],
      reports.length && ["last run", el("div", { class: "tags" }, ...reports.map((x) => badge(`${x.suite} · ${x.arms} arms · ${when(x.generatedAt)}${x.passed ? "" : " · failed"}`, x.passed ? "ok" : "warn")))],
    ].filter(Boolean);
  }

  /** The Technical details tab: the maintainer's badges, the facts, the Publish block, and the README. */
  function technical(view, publishedLine, publish) {
    const r = view.row;
    const facts = kv(
      [
        ...versionRows(r, publishedLine),
        ["name", el("code", {}, r.name)],
        ["type", r.type],
        r.system && ["for everyone", r.everyone ? `yes${everyoneBy(r)}` : "no: each person installs it"],
        r.own && ["owner", "you"],
        r.license && ["license", r.license],
        r.forkedFrom && ["copy of", el("code", {}, `${r.forkedFrom.name}@${r.forkedFrom.version}`)],
        // Said next to "copy of", because the pair is the whole story: what this was copied from, and what that
        // package is at now. One without the other is what let a copy go stale unnoticed.
        r.fork && ["official now", r.fork.shipped ? el("code", {}, `${r.fork.name}@${r.fork.shipped}${r.fork.identical ? " — the same files as this copy" : ""}`) : el("span", { class: "text-faint" }, "not here any more")],
        r.replaced && ["replaces", el("code", {}, r.replaced)],
        r.source && ["source", el("code", { class: "mk-wrap" }, r.source)],
        r.steps.length && ["steps", tags(r.steps.map((s) => `${s.phase}: ${s.id}`), "dim")],
        r.keywords?.length && ["keywords", tags(r.keywords, "dim")],
        ...benchRows(r),
        ...publishRows(view),
      ].filter(Boolean)
    );
    const extra = technicalBadges(badge, r);
    return el("div", { class: "mk-technical" }, extra.length ? el("div", { class: "tags" }, ...extra) : null, facts, publish, el("section", { class: "mk-readme", "aria-label": "README" }, readme(view.readme, view.assets)));
  }

  /** Two tabs over one host: a plain button row, the selected one pressed. */
  function tabs(panes) {
    const host = el("div", { class: "mk-tab-body" });
    const row = el("div", { class: "mk-tabs", role: "tablist" });
    const pick = (i) => {
      [...row.children].forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
      host.replaceChildren(panes[i].node);
    };
    panes.forEach((p, i) => row.append(el("button", { type: "button", class: "mk-tab", role: "tab", onClick: () => pick(i) }, p.label)));
    pick(0);
    return el("div", { class: "mk-tabbed" }, row, host);
  }

  function draw(view) {
    const r = view.row;
    const label = r.label ?? r.name;
    // What the `updates` answer knows and the row does not: this copy's changes are all in the official version.
    const superseded = !!updater()?.last?.forks?.some((f) => f.name === r.name && f.state === "superseded");
    view.superseded = superseded;
    const publishedLine = el("span");
    if (r.ahead) fillPublished(publishedLine, r, null);
    clear(body);
    const hero = el("section", { class: "mk-hero" });
    const { buttons, adminButtons, adminHints, hints, picker, publish } = actionsFor(ext, view, hero);
    // The kernel's sentence about the configuration, said only when something is missing; Configure is the fix.
    const sentence = el("span", { class: "mk-config-line", hidden: !view.config?.broken || null }, view.config?.broken ? summaryLine(ext, view.config) : null);
    if (view.config) buttons.push(button("Configure", { tone: view.config.broken ? "primary" : "quiet", title: "Set your own values for this extension", onClick: () => openConfig(view, sentence) }));
    const gets = whatYouGet(r);
    put(
      hero,
      el("div", { class: "mk-hero-head" }, el("h2", { class: "mk-title" }, label), el("div", { class: "tags" }, ...stateBadges(badge, r, { superseded }))),
      r.description && el("p", { class: "mk-desc" }, r.description),
      gets && el("p", { class: "mk-gets" }, el("span", { class: "mk-gets-label" }, "What you get: "), gets),
      view.config ? el("p", { class: "mk-setup", hidden: !view.config.broken || null }, el("span", { class: "mk-gets-label" }, "Setup needed: "), sentence) : null,
      buttons.length ? el("div", { class: "card-actions mk-actions" }, ...buttons) : null,
      ...hints.slice(0, 2).map((h) => el("p", { class: "panel-hint" }, h)),
      adminButtons.length || picker
        ? el("div", { class: "mk-admin" }, el("span", { class: "mk-admin-label" }, "For everyone"), el("div", { class: "mk-admin-row" }, ...adminButtons, picker), ...adminHints.map((h) => el("p", { class: "panel-hint" }, h)))
        : null
    );
    body.append(hero, tabs([{ label: "Overview", node: overview(r) }, { label: "Technical details", node: technical(view, publishedLine, publish) }]));
    if (r.installed && r.ahead?.state === "unpublished" && view.publish?.available) void enrich(view, publishedLine);
  }

  void load();
  return () => {
    alive = false;
  };
}

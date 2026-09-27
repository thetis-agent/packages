/* One extension's page. The crumb `Extensions › <label>`; the header -- the label (its package id only as the
 * title's tooltip), the chips, and the publisher line -- then the description, a banner with the one reason
 * when there is one (state.js's `stateOf`, the same answer the card and the Control panel give), the **Needs**
 * line before an install, and the actions: **Install**, **Installed ✓ ▾**, **Update** or **Use Thetis's
 * version**, **Set up** when it has settings, and **⋯**. Tabs follow -- **Overview** (its tools, or its skills,
 * each with one line), **Settings** (the shared configuration form on the person's own layer, only when it has
 * settings), **README** (its own), **Details** (the package id, versions, source, the maintainer's badges and
 * the Publish block), and for an admin **People** and **Activity**, which lead to the Control panel -- and a
 * side panel: **About**, **Other versions** (the rest of its family, one line each), and for an admin **For
 * everyone**.
 *
 * Everything comes from one `show` answer (the row, its family and its README); an admin's people for the
 * picker come from `people`; an installed extension's configuration from `config-show`, folded onto the row so
 * its state is the kernel's; and `publish-targets` says where this space may publish -- `available: false` on
 * every installation without @thetis/package-publish, and then no Publish is offered and nothing throws. That
 * last is asked twice: once without a package, which costs nothing, and then, only where the index says nothing
 * about this package, once about it, after the page is drawn. `open` returns an unmount that stops a late
 * answer from drawing into a closed page. */

import { actionsFor } from "./actions.js";
import { chipNodes, publishRecord, technicalBadges } from "./badges.js";
import { configCard } from "./config-form.js";
import { WORDS, isAdminOnly, labelOf, needsLine, officialOf, otherVersions, publisherLine, stateOf, typeOf } from "./state.js";
import { updater } from "./updates-notice.js";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 tools · 2 skills · 1 page", or null when the extension brings none of the three. Exported for the tests. */
export function whatYouGet(r) {
  const parts = [r.tools?.length ? plural(r.tools.length, "tool") : null, r.skills ? plural(r.skills, "skill") : null, r.pages ? plural(r.pages, "page") : null, r.service ? "runs in the background" : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The Control panel's page for one extension, which an admin's People and Activity tabs lead to. */
const PANEL_SECTION = "@thetis/ui-admin#configuration";

export function openPage(ext, root, params) {
  const { el, clear } = ext.dom;
  const { badge, button, heading, kv, put, tags, when } = ext.ui;
  const name = params.name;
  let alive = true;

  const crumbBack = button("Extensions", { tone: "quiet" });
  crumbBack.addEventListener("click", () => ext.open.place("marketplace", {}));
  const crumbName = el("span", { class: "mk-crumb-name", title: name }, "");
  const crumb = el("nav", { class: "mk-crumb", "aria-label": "Where you are" }, crumbBack, el("span", { class: "mk-crumb-sep", "aria-hidden": "true" }, "›"), crumbName);
  const body = el("div", { class: "mk-page" }, el("p", { class: "panel-empty" }, "Loading…"));
  root.append(el("div", { class: "place-page mk-place" }, crumb, body));

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
      crumbName.textContent = name;
      body.append(el("p", { class: "mk-error" }, "This extension could not be read just now."), err?.message ? el("details", { class: "mk-details" }, el("summary", {}, "Details"), el("pre", { class: "mk-wrap" }, err.message)) : null);
      return;
    }
    const [people, config, publish] = await Promise.all([view.role !== "user" ? loadPeople() : [], view.row.installed ? loadConfig() : null, view.row.installed ? loadPublish() : null]);
    view.people = people;
    view.config = config;
    view.publish = publish;
    if (alive) draw(view);
  }

  /** The person's own report for an installed package, or null when the kernel cannot give one. */
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
   * page open. A failure here is null and no Publish.
   */
  async function loadPublish() {
    try {
      const out = await ext.request("publish-targets");
      return out?.data?.available ? out.data : null;
    } catch {
      return null;
    }
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
    return el("section", { class: "mk-readme", "aria-label": "README" }, el("div", { class: "md mk-readme-body" }, ext.markdown(text, { image: imageOf(assets) })));
  }

  /** The version facts, for the Details tab: what is here, what the registry holds, and what is behind. */
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

  /**
   * The Overview tab: each tool with what it does, each skill with one line, the pages it adds, and whether it
   * runs in the background. Nothing it does not bring is mentioned.
   */
  function overview(r) {
    const list = (items) => el("ul", { class: "mk-tools" }, ...items.map((t) => el("li", { title: t.description || null }, el("code", {}, t.name), t.description ? el("span", { class: "text-dim" }, ` — ${firstSentence(t.description)}`) : null)));
    const skills = r.skillList ?? [];
    const parts = [
      r.tools?.length ? [heading(`Tools (${r.tools.length})`), list(r.tools)] : null,
      skills.length ? [heading(`Skills (${skills.length})`), list(skills)] : r.skills ? el("p", {}, `${plural(r.skills, "skill")} your assistant uses when a conversation needs ${r.skills === 1 ? "it" : "them"}.`) : null,
      r.pages ? el("p", {}, r.pages === 1 ? "It adds a screen to the page." : `It adds ${r.pages} screens to the page.`) : null,
      r.type === "provider" ? el("p", {}, "It adds models you can pick for a conversation.") : null,
      r.service ? el("p", {}, "It runs in the background for you.") : null,
    ].filter(Boolean);
    if (!parts.length) return el("div", { class: "mk-overview" }, el("p", { class: "mk-none" }, r.description || "The README says what it does."));
    return el("div", { class: "mk-overview" }, ...parts.flat());
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

  /** The Details tab: the package id and the facts, the maintainer's badges, and the Publish block. */
  function details(view, publishedLine, publishBlock) {
    const r = view.row;
    const facts = kv(
      [
        ["id", el("code", {}, r.name)],
        ...versionRows(r, publishedLine),
        ["type", r.type],
        r.system && ["for everyone", r.everyone ? `yes${everyoneBy(r)}` : "no: each person installs it"],
        r.license && ["license", r.license],
        r.forkedFrom && ["copy of", el("code", {}, `${r.forkedFrom.name}@${r.forkedFrom.version}`)],
        // Said next to "copy of", because the pair is the whole story: what this was copied from, and what that
        // package is at now. One without the other is what let a copy go stale unnoticed.
        r.fork && ["official now", r.fork.shipped ? el("code", {}, `${r.fork.name}@${r.fork.shipped}${r.fork.identical ? " — the same files as this copy" : ""}`) : el("span", { class: "text-faint" }, "not here any more")],
        r.folder && ["folder", el("code", {}, r.folder.dir)],
        r.replaced && ["replaces", el("code", {}, r.replaced)],
        r.source && ["source", el("code", { class: "mk-wrap" }, r.source)],
        r.steps?.length && ["steps", tags(r.steps.map((s) => `${s.phase}: ${s.id}`), "dim")],
        r.keywords?.length && ["keywords", tags(r.keywords, "dim")],
        ...benchRows(r),
        ...publishRows(view),
      ].filter(Boolean)
    );
    const extra = technicalBadges(badge, r);
    return el("div", { class: "mk-technical" }, extra.length ? el("div", { class: "tags" }, ...extra) : null, facts, publishBlock);
  }

  /** Tabs over one host: a plain button row, the selected one pressed. Answers the node and `show(id)`. */
  function tabs(panes, first) {
    const host = el("div", { class: "mk-tab-body" });
    const row = el("div", { class: "mk-tabs", role: "tablist" });
    const pick = (i) => {
      [...row.children].forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
      const pane = panes[i];
      host.replaceChildren(typeof pane.node === "function" ? pane.node() : pane.node);
    };
    panes.forEach((p, i) => row.append(el("button", { type: "button", class: "mk-tab", role: "tab", "data-tab": p.id, onClick: () => pick(i) }, p.label)));
    const at = Math.max(0, panes.findIndex((p) => p.id === first));
    pick(at);
    return { node: el("div", { class: "mk-tabbed" }, row, host), show: (id) => { const i = panes.findIndex((p) => p.id === id); if (i >= 0) pick(i); return i >= 0; } };
  }

  /**
   * The Install beside another version in the side panel: the same confirm and the same request as the page's
   * own Install, for that version. A copy in the person's folder is built from there.
   */
  function installOther(o) {
    const m = o.row;
    const b = button("Install", { tone: "quiet" });
    b.addEventListener("click", async () => {
      const source = m.system ? m.name : m.folder && !m.installed ? m.folder.dir : m.source;
      const ok = await ext.ui.confirm(b, { title: `Install ${o.name}?`, lines: [["extension", `${m.name} ${m.version}`], ["for", "you"]], note: `${m.folder ? "It is built from your folder, which can take a minute." : m.system ? "It comes with Thetis, so nothing is fetched." : "It is fetched and built for you, which can take a minute."} It is another version of this extension: what both bring, you then have twice.`, confirmLabel: "Install" });
      if (!ok) return;
      try {
        const out = await ext.request("install", { args: { source } });
        ext.toast(`${o.name} is installed.`, { tone: "good" });
        ext.open.place("marketplace", { name: out?.data?.name ?? m.name });
      } catch (err) {
        ext.toast(err?.message || "That did not work.", { tone: "error" });
      }
    });
    return b;
  }

  /** A side-panel block: a small heading and its contents. */
  const aside = (title, ...children) => el("section", { class: "mk-side-block", "aria-label": title }, el("h3", { class: "mk-side-title" }, title), ...children.flat().filter(Boolean));

  /** The Settings tab: the shared form, on the person's own layer. The page's state follows every write. */
  function settings(view, redraw) {
    const write = (verb, args) => ext.request(verb, { args: { name, ...args } }).then((out) => out?.data);
    return el(
      "div",
      { class: "mk-config" },
      configCard(ext, view.config, {
        layer: "user",
        set: (key, value) => write("config-set", { key, value }),
        unset: (key) => write("config-unset", { key }),
        onReport: (next) => {
          view.config = next;
          redraw();
        },
      }),
      el("p", { class: "panel-hint" }, "A value set here is yours alone and is used from the extension's next call. A secret is written and never shown again. A key marked admins only is set in the Control panel, for everyone.")
    );
  }

  /** An admin's People or Activity tab: a sentence and the way to the Control panel's page for this extension. */
  function panelLink(sentence, tab) {
    return el(
      "div",
      { class: "mk-overview" },
      el("p", {}, sentence),
      el("div", {}, button("Open in the Control panel", { tone: "quiet", onClick: () => ext.open.place("panel", { section: PANEL_SECTION, child: name, tab }) }))
    );
  }

  function draw(view, { tab = params.tab ?? null } = {}) {
    const admin = view.role !== "user";
    const user = view.user ?? "";
    const members = [{ ...view.row }, ...(view.family ?? [])];
    const r = { ...view.row, ...(view.config ? { config: view.config } : {}) };
    members[0] = r;
    const fam = { members };
    const origin = officialOf(r, fam);
    const label = labelOf(r, origin);
    // What the `updates` answer knows and the row does not: this copy's changes are all in the official version.
    const superseded = !!updater()?.last?.forks?.some((f) => f.name === r.name && f.state === "superseded");
    const state = stateOf(r, { admin, origin, label, user, superseded });
    const publisher = publisherLine(r, { user, family: members });
    const hasSettings = !!(r.installed && view.config && view.config.keys.length);
    Object.assign(view, { state, label, publisher, superseded, hasSettings });
    crumbName.textContent = label;

    const publishedLine = el("span");
    if (r.ahead) fillPublished(publishedLine, r, null);
    clear(body);
    const hero = el("section", { class: "mk-hero" });
    let tabbed = null;
    const redraw = () => draw(view, { tab: "settings" });
    const acts = actionsFor(ext, { ...view, row: r, family: view.family ?? [] }, hero, {
      onSettings: () => tabbed?.show("settings"),
      onPublish: () => {
        tabbed?.show("details");
        body.querySelector(".mk-publish-block")?.scrollIntoView({ behavior: "smooth", block: "center" });
      },
    });
    const bannerTone = state.chips[0]?.id === "needsSetup" ? "err" : state.update ? "warn" : "dim";
    const needs = !r.installed ? needsLine(r) : null;
    put(
      hero,
      el("div", { class: "mk-hero-head" }, el("h2", { class: "mk-title", title: r.name }, label), state.chips.length ? el("div", { class: "tags" }, ...chipNodes(badge, state.chips)) : null),
      el("p", { class: "mk-by" }, publisher),
      r.description && el("p", { class: "mk-desc" }, r.description),
      state.reason ? el("p", { class: `mk-banner is-${bannerTone}`, role: state.chips.length ? "status" : null }, state.reason) : null,
      needs ? el("p", { class: "mk-needs" }, needs) : null,
      el("div", { class: "card-actions mk-actions" }, ...acts.primary, acts.required, acts.more),
      ...acts.hints.slice(0, 1).map((h) => el("p", { class: "panel-hint" }, h))
    );
    const publishBlock = acts.publish ? el("div", { class: "mk-publish-wrap" }, heading("Publish"), ...acts.publishHints.slice(0, 1).map((h) => el("p", { class: "panel-hint" }, h)), acts.publish) : null;
    const panes = [
      { id: "overview", label: "Overview", node: overview(r) },
      hasSettings ? { id: "settings", label: "Settings", node: () => settings(view, redraw) } : null,
      { id: "readme", label: "README", node: readme(view.readme, view.assets) },
      { id: "details", label: "Details", node: details({ ...view, row: r }, publishedLine, publishBlock) },
      admin ? { id: "people", label: "People", node: panelLink("Who has it, and installing or removing it for one person, are on its page in the Control panel.", "people") } : null,
      admin ? { id: "activity", label: "Activity", node: panelLink("What happened to it -- installs, updates, settings changed -- is on its page in the Control panel.", "activity") } : null,
    ].filter(Boolean);
    tabbed = tabs(panes, tab);

    const others = otherVersions(fam, r, { user, admin });
    const side = el(
      "aside",
      { class: "mk-side" },
      aside(
        "About",
        kv(
          [
            ["version", r.version ? el("span", {}, r.version) : null],
            typeOf(r) && ["kind", typeOf(r)],
            whatYouGet(r) && ["brings", whatYouGet(r)],
            r.license && ["license", r.license],
          ].filter(Boolean)
        )
      ),
      others.length
        ? aside(
            "Other versions",
            el(
              "ul",
              { class: "mk-versions" },
              ...others.map((o) =>
                el(
                  "li",
                  {},
                  el("span", { class: "mk-version-text" }, el("button", { type: "button", class: "mk-version-link", title: o.row.name, onClick: () => ext.open.place("marketplace", { name: o.row.name }) }, o.name), el("span", { class: "text-dim" }, ` — ${o.relation} · ${o.status}`)),
                  o.install ? installOther(o) : null
                )
              )
            )
          )
        : null,
      admin && (acts.adminButtons.length || acts.adminLines.length || acts.picker)
        ? aside("For everyone", el("div", { class: "mk-admin-row" }, ...acts.adminButtons), ...acts.adminLines.map((h) => el("p", { class: "panel-hint" }, h)), acts.picker)
        : null,
      !admin && isAdminOnly(r) && !r.installed ? aside("For admins", el("p", { class: "panel-hint" }, WORDS.adminOnly)) : null
    );
    body.append(el("div", { class: "mk-layout" }, el("div", { class: "mk-main" }, hero, tabbed.node), side));
    if (r.installed && r.ahead?.state === "unpublished" && view.publish?.available) void enrich(view, publishedLine);
  }

  void load();
  return () => {
    alive = false;
  };
}

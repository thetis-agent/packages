/* One package's page: the crumb back to the gallery, the README on the left (rendered by the shell's
 * markdown, which builds DOM and never sets innerHTML; its local pictures come with the answer and are
 * drawn from data: URLs, so the page fetches nothing), and on the right a card with the facts (the pin
 * installed here against the registry's tip, the type, the service, the license), what it brings as
 * pills, and the actions the state and the role allow. Everything comes from one `show` answer; an
 * admin's people for the picker come from `people`. An installed package also gets its configuration
 * report from `config-show`: the card says the kernel's one sentence when the package is missing
 * something, and **Configure** opens the shared form on the person's own layer below the README, where
 * the row for each key says its state and offers the fix. It also asks `publish-targets` where this
 * workspace may publish, which carries the last publish to each target from that package's own store;
 * that answer is `available: false` on every installation without @thetis/package-publish, which is most
 * of them, and then no Publish block and no record row is drawn and nothing throws. It is asked twice:
 * once without a package, which costs nothing and is what the block is drawn from, and then -- only where
 * the index says nothing about this package -- once about the package, which reaches every registry and so
 * goes out after the page is drawn and fills in one line. That second answer is the only first-hand
 * account of a publish there is, and it is what lets the page say a package went to a target this
 * installation does not mirror instead of leaving the index's silence to speak for it. `open` returns an unmount that stops a late
 * answer from drawing into a closed page. */

import { actionsFor } from "./actions.js";
import { publishRecord, stateBadges } from "./badges.js";
import { configCard, summaryLine } from "./config-form.js";

export function openPage(ext, root, params) {
  const { el, clear } = ext.dom;
  const { badge, button, card, heading, kv, put, tags, when } = ext.ui;
  const name = params.name;
  let alive = true;

  const crumbBack = button("Marketplace", { tone: "quiet" });
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
      body.append(el("p", { class: "mk-error" }, err?.message || `${name} could not be read.`));
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
      el("div", { class: "mk-config-head" }, heading("Configuration", "your own values for this package"), closeBtn),
      configCard(ext, view.config, {
        layer: "user",
        set: (key, value) => write("config-set", { key, value }),
        unset: (key) => write("config-unset", { key }),
        onReport: (next) => {
          view.config = next;
          sentence.hidden = !next.broken;
          sentence.replaceChildren(next.broken ? summaryLine(ext, next) : "");
        },
      }),
      el("p", { class: "panel-hint" }, "A value set here is yours alone and is live on the package's next call. A secret is written and never shown again. A key marked admins only is set in the control panel, for everyone.")
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
    if (typeof text !== "string" || !text.trim()) return el("p", { class: "mk-none" }, "This package has no README.");
    return el("div", { class: "md mk-readme-body" }, ext.markdown(text, { image: imageOf(assets) }));
  }

  /** The version facts: what is installed here and at which commit, against what the registry holds. */
  function versionRows(r, publishedLine) {
    const rows = [];
    if (r.installed) rows.push(["installed", el("code", {}, r.pin ? `${r.version} at ${r.pin}` : r.version)]);
    if (r.available) rows.push(["registry", el("span", {}, el("code", {}, r.tip || r.version), r.registry ? el("span", { class: "text-dim" }, ` in ${r.registry}`) : null)]);
    // The three kinds of behind read differently: a registry's newer commit, a version this workspace has
    // not loaded, or an origin this fork was copied from and has not followed. The fork case says nothing
    // here: the facts below carry it, under "forked from" and "shipped now", where it belongs.
    if (r.update?.apply === "reload") rows.push(["loaded", el("span", {}, `${r.update.installed} in your workspace, ${r.update.available} on disk: a reload applies it`)]);
    else if (r.update && r.update.apply !== "unfork") rows.push(["update", el("span", {}, `${r.update.version} is in ${r.update.registry} (${r.update.from} → ${r.update.to})`)]);
    // And the other direction, which no row has ever carried: the version here is newer than the one every
    // other installation can reach, or no registry holds this package at all. Said in full here, where
    // there is room for it; the badge says it short.
    if (r.ahead?.state === "ahead") rows.push(["published", el("span", {}, el("code", {}, r.ahead.published), ` in ${r.ahead.registry} — ${r.ahead.version} is what is here`)]);
    // The index's own statement, in the words the badge and the command line both use, and then whatever
    // this workspace's own record adds to it once it has been asked. The line is a node the enrichment
    // fills in later rather than a redraw, because a redraw here would take the publish panel with it.
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
      return { dim: record.removed, nodes: [el("code", {}, record.version || r.version), ` ${act} · ${when(record.at)}, by this workspace's own record. No registry here lists it.`] };
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

  /** Who made a system package everyone's default, as a clause: the one fact that decides whether an admin can undo it here. */
  const everyoneBy = (r) => (r.everyoneBy === "config" ? " · by the installation's configuration" : r.everyoneBy === "promoted" ? " · promoted" : r.everyoneBy === "marked" ? " · marked by an admin" : "");

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

  function brings(r) {
    const toolPills = r.tools.length ? el("div", { class: "tags" }, ...r.tools.map((t) => el("span", { class: "badge is-ok mk-pill", title: t.description || null }, t.name))) : el("span", { class: "text-faint" }, "no tools");
    return kv([
      ["tools", toolPills],
      ["steps", tags(r.steps.map((s) => `${s.phase}: ${s.id}`), "dim", "no steps")],
      ["service", r.service ? badge("runs a service", "warn") : el("span", { class: "text-faint" }, "none")],
      r.keywords?.length && ["keywords", tags(r.keywords, "dim")],
      ...benchRows(r),
    ].filter(Boolean));
  }

  function draw(view) {
    const r = view.row;
    const publishedLine = el("span");
    if (r.ahead) fillPublished(publishedLine, r, null);
    clear(body);
    const side = el("aside", { class: "mk-side" });
    const { buttons, hints, picker, publish } = actionsFor(ext, view, side);
    // The kernel's sentence about the configuration, said only when something is missing; Configure is the fix.
    const sentence = el("p", { class: "mk-config-line", hidden: !view.config?.broken || null }, view.config?.broken ? summaryLine(ext, view.config) : null);
    if (view.config) {
      const configure = button("Configure", { tone: view.config.broken ? "primary" : "quiet", title: "Set your own values for this package", onClick: () => openConfig(view, sentence) });
      buttons.unshift(configure);
    }
    put(
      side,
      card(
        el("div", { class: "tags" }, ...stateBadges(badge, r)),
        r.description && el("p", { class: "mk-desc" }, r.description),
        view.config ? sentence : null,
        kv([
          ...versionRows(r, publishedLine),
          // The three facts the badges say short, in full: whether it is here, whose it is, and who gets it.
          ["state", r.installed ? "in your workspace" : el("span", { class: "text-faint" }, "not in your workspace")],
          r.system && ["system", r.everyone ? `everyone's default${everyoneBy(r)}` : "optional: each person installs it"],
          r.own && ["owner", "you"],
          ["type", r.type],
          r.license && ["license", r.license],
          r.forkedFrom && ["forked from", el("code", {}, `${r.forkedFrom.name}@${r.forkedFrom.version}`)],
          // Said next to "forked from", because the pair is the whole story: what this was copied from, and
          // what that package is at now. One without the other is what let a fork go stale unnoticed.
          r.fork && ["shipped now", r.fork.shipped ? el("code", {}, `${r.fork.name}@${r.fork.shipped}${r.fork.identical ? " — the same files as this fork" : ""}`) : el("span", { class: "text-faint" }, "not here any more")],
          r.replaced && ["replaces", el("code", {}, r.replaced)],
          r.source && ["source", el("code", { class: "mk-wrap" }, r.source)],
          ...publishRows(view),
        ].filter(Boolean)),
        heading("Brings"),
        brings(r),
        buttons.length ? el("div", { class: "card-actions" }, ...buttons) : null,
        picker,
        publish
      ),
      ...hints.map((h) => el("p", { class: "panel-hint" }, h))
    );
    body.append(el("section", { class: "mk-readme", "aria-label": "README" }, readme(view.readme, view.assets)), side);
    if (r.installed && r.ahead?.state === "unpublished" && view.publish?.available) void enrich(view, publishedLine);
  }

  void load();
  return () => {
    alive = false;
  };
}

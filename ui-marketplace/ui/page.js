/* One package's page: the crumb back to the gallery, the README on the left (rendered by the shell's
 * markdown, which builds DOM and never sets innerHTML; its local pictures come with the answer and are
 * drawn from data: URLs, so the page fetches nothing), and on the right a card with the facts (the pin
 * installed here against the registry's tip, the type, the service, the license), what it brings as
 * pills, and the actions the state and the role allow. Everything comes from one `show` answer; an
 * admin's people for the picker come from `people`. An installed package also gets its configuration
 * report from `config-show`: the card says the kernel's one sentence when the package is missing
 * something, and **Configure** opens the shared form on the person's own layer below the README, where
 * the row for each key says its state and offers the fix. `open` returns an unmount that stops a late
 * answer from drawing into a closed page. */

import { actionsFor } from "./actions.js";
import { stateBadges } from "./badges.js";
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
    const [people, config] = await Promise.all([view.role !== "user" ? loadPeople() : [], view.row.installed ? loadConfig() : null]);
    view.people = people;
    view.config = config;
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
  function versionRows(r) {
    const rows = [];
    if (r.installed) rows.push(["installed", el("code", {}, r.pin ? `${r.version} at ${r.pin}` : r.version)]);
    if (r.available) rows.push(["registry", el("span", {}, el("code", {}, r.tip || r.version), r.registry ? el("span", { class: "text-dim" }, ` in ${r.registry}`) : null)]);
    // The two kinds of behind read differently: a registry's newer commit, or a version this workspace has not loaded.
    if (r.update?.apply === "reload") rows.push(["loaded", el("span", {}, `${r.update.installed} in your workspace, ${r.update.available} on disk: a reload applies it`)]);
    else if (r.update) rows.push(["update", el("span", {}, `${r.update.version} is in ${r.update.registry} (${r.update.from} → ${r.update.to})`)]);
    return rows;
  }

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
    clear(body);
    const side = el("aside", { class: "mk-side" });
    const { buttons, hints, picker } = actionsFor(ext, view, side);
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
          ...versionRows(r),
          !r.installed && !r.available && ["state", el("span", { class: "text-faint" }, "not installed")],
          ["type", r.type],
          r.license && ["license", r.license],
          r.forkedFrom && ["forked from", el("code", {}, `${r.forkedFrom.name}@${r.forkedFrom.version}`)],
          r.replaced && ["replaces", el("code", {}, r.replaced)],
          r.source && ["source", el("code", { class: "mk-wrap" }, r.source)],
        ].filter(Boolean)),
        heading("Brings"),
        brings(r),
        buttons.length ? el("div", { class: "card-actions" }, ...buttons) : null,
        picker
      ),
      ...hints.map((h) => el("p", { class: "panel-hint" }, h))
    );
    body.append(el("section", { class: "mk-readme", "aria-label": "README" }, readme(view.readme, view.assets)), side);
  }

  void load();
  return () => {
    alive = false;
  };
}

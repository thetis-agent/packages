/* The pages under Packages in the control panel (the manifest declares this entry `under: "packages"`).
 * `configurationChildren` answers the nav its children: first the fleet page, then one child per package
 * with configuration keys or with something worth a look, each with its marks. `mountConfiguration` draws
 * the fleet matrix (`fleet.js`) for the first child and a package's page (`package-page.js`) for any
 * other; `mountSettings` is the settings form alone, the page's Configuration tab, drawn with the shared
 * form so the state of every key is the kernel's and is said in the row.
 *
 * The layer picker at the top switches between the system layer (what everyone gets) and one person's
 * own layer, because both are the operator's to set and a person's broken key is invisible from the
 * system view. A key declared for the system is read-only in a person's view: it is set here, at the
 * system layer, and a person's layer never overrides it.
 *
 * "Reload the file" re-reads thetis.config.json and the env file without a restart; the answer names
 * what changed and which services were restarted for it, so the button says what it did rather than
 * that it ran. After a save or a clear the page asks the nav to read its children again, so the marks
 * beside the package follow the kernel's word. */

import { configCard, reloadSentence } from "./config-form.js";
import { mountFleet } from "./fleet.js";
import { mountPackagePage } from "./package-page.js";

/** The id of the first child under Packages: not a package but every workspace at once. */
export const FLEET = "*";

/**
 * The children under Packages, for the nav: first the fleet page, then one child per package with
 * configuration keys, or with something worth a look. The marks come from the `fleet` command (what the
 * registry holds, who runs a fork or older code, whose configuration is broken); an installation where it
 * cannot answer still lists the packages, without marks. Each glyph's sentence is its tooltip.
 */
export async function configurationChildren(ext) {
  const [list, fleet] = await Promise.all([ext.request("config-list"), ext.request("fleet").catch(() => ({ data: null }))]);
  const reports = Array.isArray(list.data) ? list.data : [];
  const known = new Map((fleet?.data?.packages ?? []).map((p) => [p.name, p]));
  const marksOf = (name, report) => {
    const p = known.get(name);
    const people = Object.entries(p?.byUser ?? {});
    const marks = [];
    if (p?.registry?.update) marks.push({ glyph: "↑", tone: "warn", title: `update ${p.registry.update.version || ""} on offer in the marketplace`.replace(/\s+/g, " ") });
    const forks = people.filter(([, u]) => u?.fork || u?.forkOf);
    if (forks.length) marks.push({ glyph: "Y", tone: "warn", title: `fork in use: ${forks.map(([who]) => who).join(", ")}` });
    const stale = people.filter(([, u]) => u?.stale);
    if (stale.length) marks.push({ glyph: "◐", tone: "warn", title: `older code running: ${stale.map(([who]) => who).join(", ")}` });
    const broken = people.filter(([, u]) => u?.broken).map(([who]) => who);
    if (report?.broken || p?.config?.broken || broken.length) marks.push({ glyph: "!", tone: "err", title: `config broken${broken.length ? ` for ${broken.join(", ")}` : ""}: ${report?.summary || p?.config?.summary || "a key is missing"}` });
    return marks;
  };
  const byName = new Map(reports.map((r) => [r.package, r]));
  for (const name of known.keys()) if (!byName.has(name)) byName.set(name, null);
  const kids = [];
  for (const [name, report] of byName) {
    const marks = marksOf(name, report);
    const keys = Array.isArray(report?.keys) ? report.keys.length : 0;
    if (!keys && !marks.length) continue;
    kids.push({ id: name, label: name, note: report?.summary || null, marks });
  }
  kids.sort((a, b) => a.id.localeCompare(b.id));
  return [{ id: FLEET, label: "All workspaces", kind: "page", note: "Every package in every workspace" }, ...kids];
}

/** The page under Packages: the fleet matrix for the first child (`*`), else one package's page. */
export function mountConfiguration(ext, root, { child, refresh, user, open } = {}) {
  if (child === FLEET) return mountFleet(ext, root, { refresh, onOpen: (name) => open?.(name) });
  if (child) return mountPackagePage(ext, root, { name: child, refresh, ...(user ? { user } : {}) });
  const { el } = ext.dom;
  root.append(el("div", { class: "panel-cols" }, el("div", { class: "panel-col" }, el("p", { class: "panel-hint" }, "Choose a package under Packages."))));
}

/** The settings form alone, as the package page's Configuration tab draws it. */
export function mountSettings(ext, root, { child, refresh } = {}) {
  const { el, clear } = ext.dom;
  const { busy, button, confirm, heading, put } = ext.ui;
  const wrap = el("div", { class: "panel-col ua-configuration" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  if (!child) return void put(wrap, el("p", { class: "panel-hint" }, "Choose a package under Packages to see what it is configured with."));

  let people = [];
  let person = ""; // "" is the system layer
  let report = null;

  async function load() {
    const stop = busy(wrap, `Reading ${child}…`);
    try {
      const [users, shown] = await Promise.all([ext.request("users"), ext.request("config-show", { args: person ? { name: child, user: person } : { name: child } })]);
      people = (Array.isArray(users.data) ? users.data : []).filter((p) => p.role !== "system");
      report = shown.data ?? null;
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    draw();
  }

  const write = (name, args) => ext.request(name, { args: person ? { ...args, user: person } : args }).then((out) => out?.data);

  async function reload(anchor) {
    const ok = await confirm(anchor, { title: "Re-read the file?", lines: [["reads", "thetis.config.json and the env file"]], note: "A package whose configuration changed has its service restarted in every workspace that runs one. Nothing else restarts.", confirmLabel: "Reload" });
    if (!ok) return;
    anchor.disabled = true;
    try {
      const out = await ext.request("config-reload");
      ext.toast(reloadSentence(out?.data), { tone: "good" });
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      anchor.disabled = false;
    }
    await load();
    refresh?.();
  }

  function draw() {
    clear(wrap);
    if (!report) return void put(wrap, el("p", { class: "panel-hint" }, `${child} could not be read.`));
    const layer = el("select", { class: "input", "aria-label": "Layer", onChange: () => { person = layer.value; void load(); } }, el("option", { value: "" }, "everyone (the system layer)"), ...people.map((p) => el("option", { value: p.id, selected: p.id === person || null }, `${p.id}'s own layer`)));
    const reloadBtn = button("Reload the file", { title: "Re-read thetis.config.json and the env file", onClick: () => void reload(reloadBtn) });
    const card = configCard(ext, report, {
      layer: person ? "user" : "system",
      who: person || null,
      set: (key, value) => write("config-set", { name: child, key, value }),
      unset: (key) => write("config-unset", { name: child, key }),
      onReport: (next) => {
        report = next;
        refresh?.();
      },
    });
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Configuration", report.inherits?.length ? `inherits from ${report.inherits.join(", ")}` : null), el("div", { class: "toolbar-gap" }), layer, reloadBtn),
      card,
      el("p", { class: "panel-hint" }, "A value set here is live on the package's next call; a package that runs a service has it restarted. A secret is written and never shown again: the row says whether one is set. ${VAR} in a value is read from the environment when the package is called, and the row names a variable that is not there. The file thetis.config.json is read once; Reload the file reads it again.")
    );
  }

  void load();
}

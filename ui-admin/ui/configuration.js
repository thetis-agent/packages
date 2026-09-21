/* Package settings: one page per package that has configuration, hung under the Packages section of the
 * control panel (the manifest declares this entry `under: "packages"`). `configurationChildren` answers
 * the nav its children from `config-list`: every package with at least one key, declared or stored, its
 * summary as the tooltip and a mark when it is broken. `mountConfiguration` draws one package's page from
 * `config-show`, with the shared form, whose header carries the kernel's one sentence about the package;
 * the state of every key is the kernel's and is said in the row.
 *
 * The layer picker at the top switches between the system layer (what everyone gets) and one person's
 * own layer, because both are the operator's to set and a person's broken key is invisible from the
 * system view. A key declared for the system is read-only in a person's view: it is set here, at the
 * system layer, and a person's layer never overrides it.
 *
 * "Reload the file" re-reads thetis.config.json and the env file without a restart; the answer names
 * what changed and which services were restarted for it, so the button says what it did rather than
 * that it ran. After a save or a clear the page asks the nav to read its children again, so the mark
 * beside the package follows the kernel's word. */

import { configCard, reloadSentence } from "./config-form.js";

/** The packages with configuration, for the nav under Packages. */
export async function configurationChildren(ext) {
  const list = await ext.request("config-list");
  return (Array.isArray(list.data) ? list.data : [])
    .filter((r) => Array.isArray(r.keys) && r.keys.length)
    .map((r) => ({ id: r.package, label: r.package, note: r.summary || null, mark: r.broken ? "err" : null }));
}

export function mountConfiguration(ext, root, { child, refresh } = {}) {
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
      el("div", { class: "toolbar" }, heading(child, report.inherits?.length ? `inherits from ${report.inherits.join(", ")}` : null), el("div", { class: "toolbar-gap" }), layer, reloadBtn),
      card,
      el("p", { class: "panel-hint" }, "A value set here is live on the package's next call; a package that runs a service has it restarted. A secret is written and never shown again: the row says whether one is set. ${VAR} in a value is read from the environment when the package is called, and the row names a variable that is not there. The file thetis.config.json is read once; Reload the file reads it again.")
    );
  }

  void load();
}

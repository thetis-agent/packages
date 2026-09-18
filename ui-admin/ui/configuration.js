/* Configuration: what each package is configured with, and what is missing. One card per package from
 * `config-list`, drawn by the shared form; the state of every key is the kernel's and is said in the row.
 * The layer picker at the top switches between the system layer (what everyone gets) and one person's
 * own layer, because both are the operator's to set and a person's broken key is invisible from the
 * system view. A key declared for the system is read-only in a person's view: it is set here, at the
 * system layer, and a person's layer never overrides it.
 *
 * "Reload the file" re-reads thetis.config.json and the env file without a restart; the answer names
 * what changed and which services were restarted for it, so the button says what it did rather than
 * that it ran. */

import { brokenSentence, configCard, reloadSentence } from "./config-form.js";

export function mountConfiguration(ext, root) {
  const { el, clear } = ext.dom;
  const { busy, button, confirm, heading, put } = ext.ui;
  let people = [];
  let person = ""; // "" is the system layer
  let reports = [];
  const wrap = el("div", { class: "panel-col ua-configuration" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  async function load() {
    const stop = busy(wrap, "Reading the configuration…");
    try {
      const [users, list] = await Promise.all([ext.request("users"), ext.request("config-list", { args: person ? { user: person } : {} })]);
      people = (Array.isArray(users.data) ? users.data : []).filter((p) => p.role !== "system");
      reports = Array.isArray(list.data) ? list.data : [];
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
  }

  function brokenLine() {
    const text = brokenSentence(reports);
    return text ? el("p", { class: "ua-broken", "data-broken": String(reports.filter((r) => r.broken).length) }, text) : null;
  }

  function draw() {
    clear(wrap);
    const layer = el("select", { class: "input", "aria-label": "Layer", onChange: () => { person = layer.value; void load(); } }, el("option", { value: "" }, "everyone (the system layer)"), ...people.map((p) => el("option", { value: p.id, selected: p.id === person || null }, `${p.id}'s own layer`)));
    const reloadBtn = button("Reload the file", { title: "Re-read thetis.config.json and the env file", onClick: () => void reload(reloadBtn) });
    const broken = brokenLine();
    const line = el("div", { class: "ua-broken-line" }, broken);
    const cards = reports.map((r) =>
      configCard(ext, r, {
        layer: person ? "user" : "system",
        who: person || null,
        set: (key, value) => write("config-set", { name: r.package, key, value }),
        unset: (key) => write("config-unset", { name: r.package, key }),
        onReport: (next) => {
          reports = reports.map((x) => (x.package === next.package ? next : x));
          clear(line);
          put(line, brokenLine());
        },
      })
    );
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Configuration", `${reports.length} ${reports.length === 1 ? "package" : "packages"}`), el("div", { class: "toolbar-gap" }), layer, reloadBtn),
      line,
      cards.length ? cards : el("p", { class: "panel-hint" }, person ? `${person} has no package installed.` : "No package is installed anywhere."),
      el("p", { class: "panel-hint" }, "A value set here is live on the package's next call; a package that runs a service has it restarted. A secret is written and never shown again: the row says whether one is set. ${VAR} in a value is read from the environment when the package is called, and the row names a variable that is not there. The file thetis.config.json is read once; Reload the file reads it again.")
    );
  }

  void load();
}

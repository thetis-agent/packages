/* The pages under Extensions in the control panel (the manifest declares this entry `under: "packages"`,
 * the shell's built-in section). `configurationChildren` answers the tree: first "All extensions", the table
 * of every extension, then every extension by name, so each is one click from the control panel. The ones that
 * ask for something -- an update ready (to install, or for people who have not applied it yet) or a setting
 * that is missing -- carry a mark, and only the marks are counted, so the tree's count is of what needs doing.
 * `mountConfiguration` draws All extensions (`fleet.js` in its simple view) for the first child and an
 * extension's page (`package-page.js`) for any other; `mountSettings` is the settings form alone, the page's
 * Settings tab, drawn with the shared form so the state of every key is the kernel's and is said in the row.
 *
 * The layer picker at the top of the form switches between the system layer (what everyone gets) and one
 * person's own layer, because both are the admin's to set and a person's missing key is invisible from the
 * system view. A key declared for the system is read-only in a person's view.
 *
 * "Read the file again" re-reads thetis.config.json and the env file without a restart; the answer names
 * what changed and which services were restarted for it. After a save or a clear the page asks the tree to
 * read its children again, so the marks beside the extensions follow the kernel's word. */

import { configCard, reloadSentence } from "./config-form.js";
import { mountFleet } from "./fleet.js";
import { mountPackagePage } from "./package-page.js";
import { failedCard, toastError } from "./failed.js";
import { shortName, stateWord, waitingSentence } from "./state.js";

/** The id of the first child under Extensions: not an extension but all of them. */
export const FLEET = "*";

/**
 * The one tree mark an extension gets, or null when it asks for nothing. A missing setting is `err`; an
 * update ready is `warn`, with who has not applied it or what the registry holds in the tooltip.
 */
export function markOf(p, report) {
  const broken = Object.entries(p?.byUser ?? {}).filter(([, u]) => u?.broken).map(([who]) => who);
  if (report?.broken || p?.config?.broken || broken.length) return { mark: "err", note: `Needs setup${broken.length ? ` for ${broken.join(", ")}` : ""}: ${report?.summary || p?.config?.summary || "a setting is missing"}` };
  const update = p?.registry?.update;
  const waiting = Array.isArray(p?.waiting) ? p.waiting.length : 0;
  if (p?.state === "update" || update) {
    const why = update?.apply === "install" ? `${update.version || "a newer version"} is in the registry` : waitingSentence(waiting) ?? "a workspace has not applied it";
    return { mark: "warn", note: `${stateWord("update")}: ${why}` };
  }
  return null;
}

/**
 * The children under Extensions, for the tree: All extensions first, then every extension by name, the ones
 * that ask for something with their one mark. An installation where `fleet` cannot answer still lists the
 * ones the configuration report knows.
 */
export async function configurationChildren(ext) {
  const [list, fleet] = await Promise.all([ext.request("config-list").catch(() => ({ data: [] })), ext.request("fleet").catch(() => ({ data: null }))]);
  const reports = new Map((Array.isArray(list?.data) ? list.data : []).map((r) => [r.package, r]));
  const rows = Array.isArray(fleet?.data?.packages) ? fleet.data.packages : [];
  const names = new Set([...rows.map((p) => p.name), ...reports.keys()]);
  const byName = new Map(rows.map((p) => [p.name, p]));
  const kids = [];
  for (const name of names) {
    const said = markOf(byName.get(name) ?? null, reports.get(name) ?? null);
    kids.push(said ? { id: name, label: shortName(name), note: said.note, mark: said.mark } : { id: name, label: shortName(name), note: stateWord("current") });
  }
  kids.sort((a, b) => a.label.localeCompare(b.label));
  return [{ id: FLEET, label: "All extensions", kind: "page", note: "Every extension installed here" }, ...kids];
}

/** The page under Extensions: All extensions for the first child (`*`), else one extension's page. */
export function mountConfiguration(ext, root, { child, refresh, user, open } = {}) {
  if (child === FLEET) return mountFleet(ext, root, { mode: "simple", refresh, onOpen: (name) => open?.(name), ...(user ? { user } : {}) });
  if (child) return mountPackagePage(ext, root, { name: child, refresh, ...(user ? { user } : {}) });
  const { el } = ext.dom;
  root.append(el("div", { class: "panel-cols" }, el("div", { class: "panel-col" }, el("p", { class: "panel-hint" }, "Choose All extensions under Extensions."))));
}

/** The settings form alone, as the package page's Configuration tab draws it. */
export function mountSettings(ext, root, { child, refresh } = {}) {
  const { el, clear } = ext.dom;
  const { busy, button, confirm, heading, put } = ext.ui;
  const wrap = el("div", { class: "panel-col ua-configuration" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  if (!child) return void put(wrap, el("p", { class: "panel-hint" }, "Choose an extension under Extensions to see its settings."));

  let people = [];
  let person = ""; // "" is the system layer
  let report = null;
  let failed = null;

  async function load() {
    const stop = busy(wrap, `Reading ${child}…`);
    try {
      const [users, shown] = await Promise.all([ext.request("users"), ext.request("config-show", { args: person ? { name: child, user: person } : { name: child } })]);
      people = (Array.isArray(users.data) ? users.data : []).filter((p) => p.role !== "system");
      report = shown.data ?? null;
      failed = null;
    } catch (err) {
      failed = err;
    } finally {
      stop();
    }
    draw();
  }

  const write = (name, args) => ext.request(name, { args: person ? { ...args, user: person } : args }).then((out) => out?.data);

  async function reload(anchor) {
    const ok = await confirm(anchor, { title: "Read the file again?", lines: [["reads", "thetis.config.json and the env file"]], note: "An extension whose settings changed has its service restarted in every workspace that runs one. Nothing else restarts.", confirmLabel: "Read it" });
    if (!ok) return;
    anchor.disabled = true;
    try {
      const out = await ext.request("config-reload");
      ext.toast(reloadSentence(out?.data), { tone: "good" });
    } catch (err) {
      toastError(ext, err, "The file could not be read again");
    } finally {
      anchor.disabled = false;
    }
    await load();
    refresh?.();
  }

  function draw() {
    clear(wrap);
    if (failed || !report) return void put(wrap, failedCard(ext, `The settings of ${shortName(child)}`, failed ?? new Error("no answer"), { admin: true, retry: () => void load() }));
    const layer = el("select", { class: "input", "aria-label": "Layer", onChange: () => { person = layer.value; void load(); } }, el("option", { value: "" }, "everyone (the system layer)"), ...people.map((p) => el("option", { value: p.id, selected: p.id === person || null }, `${p.id}'s own layer`)));
    const reloadBtn = button("Read the file again", { title: "Re-read thetis.config.json and the env file", onClick: () => void reload(reloadBtn) });
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
      el("div", { class: "toolbar" }, heading("Settings", report.inherits?.length ? `inherits from ${report.inherits.join(", ")}` : null), el("div", { class: "toolbar-gap" }), layer, reloadBtn),
      card,
      el("p", { class: "panel-hint" }, "A value set here is live on the extension's next call; an extension that runs a service has it restarted. A secret is written and never shown again: the row says whether one is set. ${VAR} in a value is read from the environment when the extension is called, and the row names a variable that is not there. The file thetis.config.json is read once; Read the file again reads it again.")
    );
  }

  void load();
}

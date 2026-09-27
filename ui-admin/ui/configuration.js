/* The pages under Extensions in the control panel (the manifest declares this entry `under: "packages"`,
 * the shell's built-in section). `configurationChildren` answers the tree: first "All extensions", the table
 * of every extension, then every extension by its friendly label in Title Case, so each is one click from the
 * control panel. The ones that ask for attention (Needs setup or Update available, `state.js`'s one state)
 * carry a mark with the one sentence why, and only the marks are counted, so the tree's count is of what needs
 * doing. `mountConfiguration` draws All extensions (`fleet.js` in its simple view) for the first child and an
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
import { described, rowFromFleet } from "./rows.js";

/** The id of the first child under Extensions: not an extension but all of them. */
export const FLEET = "*";

/** The signed-in person, as the shell's footer names them; the seam hands a tree's children no identity. */
const me = () => globalThis.document?.getElementById?.("user-name")?.textContent?.trim() || "";

/** One extension as the one state reads it, from its fleet row and its system-layer report, either of which may be missing. */
function rowOf(p, report, user) {
  const row = p ? rowFromFleet(p, { user }) : { name: report?.package, installed: true, label: null, type: null, config: null };
  // The report the tree read says more than the fleet's short form when the fleet could not answer.
  if (report?.broken && !row.config?.broken) row.config = { broken: true, summary: report.summary || "A setting is missing", keys: Array.isArray(report.keys) ? report.keys.filter((k) => k?.state === "missing") : [] };
  return row;
}

/**
 * The one tree mark an extension gets, or null when it asks for nothing: `err` for Needs setup, `warn` for
 * Update available, with the one sentence why as the tooltip. `rows` are the others, for a copy's official one.
 */
export function markOf(p, report, { user = "", rows = [] } = {}) {
  if (!p && !report) return null;
  const { state } = described(rowOf(p, report, user), { rows, user });
  if (!state.attention) return null;
  return { mark: state.setup.chip ? "err" : "warn", note: state.reason };
}

/**
 * The children under Extensions, for the tree: All extensions first, then every extension by its friendly
 * label, the ones that ask for attention with their one mark. Two extensions that read the same (an official
 * one and someone's customised copy of it) are told apart by who they are by. An installation where `fleet`
 * cannot answer still lists the ones the configuration report knows.
 */
export async function configurationChildren(ext, { user = me() } = {}) {
  const [list, fleet] = await Promise.all([ext.request("config-list").catch(() => ({ data: [] })), ext.request("fleet").catch(() => ({ data: null }))]);
  const reports = new Map((Array.isArray(list?.data) ? list.data : []).map((r) => [r.package, r]));
  const packages = Array.isArray(fleet?.data?.packages) ? fleet.data.packages : [];
  const names = new Set([...packages.map((p) => p.name), ...reports.keys()]);
  const byName = new Map(packages.map((p) => [p.name, p]));
  const rows = packages.map((p) => rowFromFleet(p, { user }));
  const kids = [];
  for (const name of names) {
    const said = described(rowOf(byName.get(name) ?? null, reports.get(name) ?? null, user), { rows, user });
    const mark = markOf(byName.get(name) ?? null, reports.get(name) ?? null, { user, rows });
    kids.push({ id: name, label: said.label, by: said.publisher.split(" · ")[0], ...(mark ? { note: mark.note, mark: mark.mark } : { note: `${said.publisher} · ${name}` }) });
  }
  const seen = new Map();
  for (const k of kids) seen.set(k.label, (seen.get(k.label) ?? 0) + 1);
  for (const k of kids) if (seen.get(k.label) > 1) k.label = `${k.label} (${k.by})`;
  kids.sort((a, b) => a.label.localeCompare(b.label));
  return [{ id: FLEET, label: "All extensions", kind: "page", note: "Every extension installed here" }, ...kids.map(({ by, ...k }) => k)];
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
    if (failed || !report) return void put(wrap, failedCard(ext, `The settings of ${child}`, failed ?? new Error("no answer"), { admin: true, retry: () => void load() }));
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

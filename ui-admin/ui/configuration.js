/* The pages under Extensions in the control panel (the manifest declares this entry `under: "packages"`,
 * the shell's built-in section). `configurationChildren` answers the tree: "All extensions", the table of what
 * is installed for the reader; "Who has what", every extension and which people have it; then every extension
 * by its friendly label in Title Case, one node per family: a customised copy hangs under the extension it was
 * made from ("Tool Exec — your copy"), so two entries never read the same. The ones that ask for attention
 * (Needs setup or Update available, `state.js`'s one state) carry a mark whose tooltip is "<Chip> — <the one
 * sentence why>", and only the marks are counted, so the tree's count is of what needs doing. The Extensions
 * place's own entry reads "Extensions page", so it is not mistaken for the section it sits in.
 * `mountConfiguration` draws All extensions and Who has what (`fleet.js`, its simple and full views) and an
 * extension's page (`package-page.js`) for any other child; `mountSettings` is the settings form alone, the
 * page's Settings tab, drawn with the shared form so the state of every key is the kernel's and is said in the row.
 *
 * The picker at the top of the form switches between everyone's settings and one person's own, because both
 * are the admin's to set and a person's missing key is invisible from everyone's view. A key declared for the
 * system is read-only in a person's view.
 *
 * "Read the file again" re-reads thetis.config.json and the env file without a restart; the answer names
 * what changed and which services were restarted for it. After a save or a clear the page asks the tree to
 * read its children again, so the marks beside the extensions follow the kernel's word. */

import { configCard, reloadSentence } from "./config-form.js";
import { mountFleet } from "./fleet.js";
import { mountPackagePage } from "./package-page.js";
import { failedCard, toastError } from "./failed.js";
import { described, rowFromFleet } from "./rows.js";
import { originNameOf, scopeOf } from "./state.js";

/** The id of the first child under Extensions: not an extension but all of them. */
export const FLEET = "*";
/** The id of the second: every extension and which people have it. */
export const WHO = "who";

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
 * Update available, with "<Chip> — <the one sentence why>" as the tooltip. `rows` are the others, for a copy's official one.
 */
export function markOf(p, report, { user = "", rows = [] } = {}) {
  if (!p && !report) return null;
  const { state } = described(rowOf(p, report, user), { rows, user });
  if (!state.attention) return null;
  const chip = state.chips.find((c) => c.id === "needsSetup" || c.id === "updateAvailable") ?? state.chips[0];
  // An optional setup (something everyone was given) is marked neutral, as the place says it.
  return { mark: state.tone === "dim" ? "dim" : state.setup.chip ? "err" : "warn", note: chip ? `${chip.label} — ${state.reason}` : state.reason };
}

/** What a copy's node under its origin reads: "Tool Exec — your copy", "Tool Exec — sam's copy". */
const copyLabel = (label, name, user) => `${label} — ${scopeOf(name) === user ? "your" : `${scopeOf(name)}'s`} copy`;

/**
 * The children under Extensions, for the tree: All extensions and Who has what first, then every extension by
 * its friendly label, one node per family (a copy under its origin), the ones that ask for attention with their
 * one mark. An installation where `fleet` cannot answer still lists the ones the configuration report knows.
 */
export async function configurationChildren(ext, { user = me() } = {}) {
  const [list, fleet] = await Promise.all([ext.request("config-list").catch(() => ({ data: [] })), ext.request("fleet").catch(() => ({ data: null }))]);
  const reports = new Map((Array.isArray(list?.data) ? list.data : []).map((r) => [r.package, r]));
  const packages = Array.isArray(fleet?.data?.packages) ? fleet.data.packages : [];
  const names = new Set([...packages.map((p) => p.name), ...reports.keys()]);
  const byName = new Map(packages.map((p) => [p.name, p]));
  const rows = packages.map((p) => rowFromFleet(p, { user }));
  const nodes = new Map();
  for (const name of names) {
    const said = described(rowOf(byName.get(name) ?? null, reports.get(name) ?? null, user), { rows, user });
    const mark = markOf(byName.get(name) ?? null, reports.get(name) ?? null, { user, rows });
    // The Extensions place's own entry, under the section called Extensions.
    const label = said.label === "Extensions" ? "Extensions page" : said.label;
    nodes.set(name, { id: name, label, ...(mark ? { note: mark.note, mark: mark.mark } : { note: said.publisher }) });
  }
  // A copy hangs under the extension it was made from, when that one is listed too.
  const top = [];
  for (const [name, node] of nodes) {
    const p = byName.get(name);
    const origin = p ? originNameOf(p) : null;
    const parent = origin && origin !== name ? nodes.get(origin) : null;
    if (!parent) {
      top.push(node);
      continue;
    }
    node.label = copyLabel(parent.label, name, user);
    (parent.children ??= []).push(node);
  }
  top.sort((a, b) => a.label.localeCompare(b.label));
  return [
    { id: FLEET, label: "All extensions", kind: "page", note: "Every extension installed here" },
    { id: WHO, label: "Who has what", kind: "page", note: "Every extension and which people have it" },
    ...top,
  ];
}

/**
 * The page under Extensions: All extensions (`*`), Who has what, or one extension's page. `tab` and `layer`
 * are a deep link's (another surface opening this page on its Settings tab, at everyone's layer or a person's).
 */
export function mountConfiguration(ext, root, { child, refresh, user, open, tab = null, layer = null } = {}) {
  if (child === FLEET) return mountFleet(ext, root, { mode: "simple", refresh, onOpen: (name) => open?.(name), ...(user ? { user } : {}) });
  if (child === WHO) return mountFleet(ext, root, { mode: "full", refresh, onOpen: (name) => open?.(name), ...(user ? { user } : {}) });
  if (child) return mountPackagePage(ext, root, { name: child, refresh, open: open ?? null, tab, layer, ...(user ? { user } : {}) });
  const { el } = ext.dom;
  root.append(el("div", { class: "panel-cols" }, el("div", { class: "panel-col" }, el("p", { class: "panel-hint" }, "Choose All extensions under Extensions."))));
}

/**
 * The settings form alone, as the package page's Settings tab draws it. `label` is the extension's label for the
 * card's header, `layer` the person whose own layer to open on ("" is everyone's), `onChange` is called after a
 * save or a clear so the page redraws its chip and banner at once.
 */
export function mountSettings(ext, root, { child, refresh, label = null, layer: initial = "", onChange, user = me() } = {}) {
  const { el, clear } = ext.dom;
  const { busy, button, confirm, heading, put } = ext.ui;
  const wrap = el("div", { class: "panel-col ua-configuration" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  if (!child) return void put(wrap, el("p", { class: "panel-hint" }, "Choose an extension under Extensions to see its settings."));

  let people = [];
  let holders = null; // who has it, for the clear confirm at everyone's layer
  let person = typeof initial === "string" ? initial : ""; // "" is everyone's layer
  let report = null;
  let failed = null;
  let alive = true;

  async function load() {
    const stop = busy(wrap, `Reading ${label ?? child}…`);
    try {
      const [users, shown, where] = await Promise.all([
        ext.request("users"),
        ext.request("config-show", { args: person ? { name: child, user: person } : { name: child } }),
        holders ? null : ext.request("package-where", { args: { name: child } }).catch(() => null),
      ]);
      people = (Array.isArray(users.data) ? users.data : []).filter((p) => p.role !== "system");
      if (where) holders = (where.data?.people ?? []).filter((p) => p.installed).map((p) => p.user);
      report = shown.data ?? null;
      failed = null;
    } catch (err) {
      failed = err;
    } finally {
      stop();
    }
    if (alive) draw();
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
    onChange?.();
  }

  function draw() {
    clear(wrap);
    if (failed || !report) return void put(wrap, failedCard(ext, `The settings of ${label ?? child}`, failed ?? new Error("no answer"), { admin: true, retry: () => void load() }));
    // "Everyone's key / sam's own key" when a key is what this extension asks for; its settings otherwise.
    const noun = (report.keys ?? []).some((k) => k.secret) ? "key" : "settings";
    const layer = el("select", { class: "input", "aria-label": "Whose settings", title: "Whose settings to see and change", onChange: () => { person = layer.value; void load(); } }, el("option", { value: "" }, `Everyone's ${noun}`), ...people.map((p) => el("option", { value: p.id, selected: p.id === person || null }, `${p.id === user ? "Your" : `${p.id}'s`} own ${noun}`)));
    const reloadBtn = button("Read the file again", { title: "Re-read thetis.config.json and the env file", onClick: () => void reload(reloadBtn) });
    const mine = person && person === user;
    const card = configCard(ext, report, {
      layer: person ? "user" : "system",
      who: person && !mine ? person : null,
      label,
      people: holders ?? [],
      reveal: (key) => ext.request("config-reveal", { args: { name: child, key, layer: person ? "user" : "system", ...(person ? { user: person } : {}) } }).then((out) => out?.data?.value),
      set: (key, value) => write("config-set", { name: child, key, value }),
      unset: (key) => write("config-unset", { name: child, key }),
      onReport: (next) => {
        report = next;
        refresh?.();
        onChange?.();
      },
    });
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Settings", person ? (mine ? "your own, used instead of everyone's" : `${person}'s own, used instead of everyone's`) : "what everyone gets, unless they set their own"), el("div", { class: "toolbar-gap" }), layer, reloadBtn),
      card,
      el("p", { class: "panel-hint" }, "A value set here is used from the extension's next call; an extension that runs a service has it restarted. ${VAR} in a value is read from the server's environment when the extension is called. The server's file thetis.config.json is read once; Read the file again reads it again.")
    );
  }

  void load();
  return () => {
    alive = false;
  };
}

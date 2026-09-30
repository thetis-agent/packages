/* The pages under Extensions in the control panel (the manifest declares this entry `under: "packages"`,
 * the shell's built-in section). `configurationChildren` answers the tree: "All extensions", the table of what
 * is installed for the reader; "Who has what", every extension and which people have it; then every extension
 * of this server by its friendly label in Title Case -- the ones nobody has too -- one node per family: a copy
 * hangs under the extension it was made from ("Your copy (Customized)"), and a person's package under what it
 * was published as ("GitHub — your original"), so two entries never read the same;
 * Thetis's own parts sit under one closed "Part of Thetis" node, as the Extensions place keeps them apart.
 *
 * The verdict is the place's, for the reader (`rows.js`'s `placeOf`): an extension whose family has a to-do in
 * the place's "Needs your attention" strip carries a mark in the to-do's tone (`look: true`, so the shell counts
 * it whatever its tone), and the count beside Extensions is exactly the place's attention count. Every node's
 * tooltip starts with its full name, then the to-do's sentence or the publisher line. The Extensions place's own
 * entry reads "Extensions page", so it is not mistaken for the section it sits in.
 * `mountConfiguration` draws All extensions, Part of Thetis and Who has what (`fleet.js`, its simple and full
 * views) and an extension's page (`package-page.js`) for any other child; `mountSettings` is the settings form
 * alone, the page's Settings tab, drawn with the shared form so the state of every key is the kernel's and is
 * said in the row.
 *
 * The picker at the top of the form switches between everyone's settings and one person's own, because both
 * are the admin's to set and a person's missing key is invisible from everyone's view. A key declared for the
 * system is read-only in a person's view.
 *
 * At a person's layer the form is told what each key falls back to (everyone's report, read beside it), so a
 * value of their own reads "used instead of everyone's" only when everyone has one. "Read the file again"
 * re-reads thetis.config.json and the env file without a restart; the answer names what changed and which
 * services were restarted for it. It sits under Advanced with the sentence on `${VAR}` and the file, which is
 * nobody's business but an admin troubleshooting. After a save or a clear the page asks the tree to read its
 * children again, so the marks beside the extensions follow the kernel's word. */

import { configCard, reloadSentence } from "./config-form.js";
import { mountFleet } from "./fleet.js";
import { mountPackagePage } from "./package-page.js";
import { failedCard, toastError } from "./failed.js";
import { described, placeOf, rowsFromFleet } from "./rows.js";
import { agentName, familiesOf, isCustomized, isPromoted, isVariant, officialOf, originNameOf, publishedCopyOf, scopeOf, titleOf } from "./state.js";

/** The id of the first child under Extensions: not an extension but all of them. */
export const FLEET = "*";
/** The id of the second: every extension and which people have it. */
export const WHO = "who";
/** The node Thetis's own parts hang under, which is also a page listing them. */
export const PARTS = "parts";

/** The signed-in person, as the shell's footer names them; the seam hands a tree's children no identity. */
const me = () => globalThis.document?.getElementById?.("user-name")?.textContent?.trim() || "";

/** The tree mark of a to-do's tone: red for setup, amber for an update, grey for the rest (still counted). */
const MARK = Object.freeze({ err: "err", warn: "warn", dim: "dim" });

/** The one tree mark a family's to-do in the place's strip gives, or null when it has none: `{ mark, why }`. */
export function markOf(entry) {
  if (!entry?.todo) return null;
  return { mark: MARK[entry.todo.tone] ?? "warn", why: entry.todo.reason };
}

/** What a copy's node under its origin reads: "Your copy (Customized)", "sam's copy", or a variant's own label. */
function copyLabel(row, family, user) {
  const origin = officialOf(row, family);
  if (isVariant(row, origin)) return null;
  const whose = scopeOf(row.name) === user ? "Your copy" : `${scopeOf(row.name)}'s copy`;
  return isCustomized(row) ? `${whose} (Customized)` : whose;
}

/**
 * The children under Extensions, for the tree: All extensions and Who has what first, then every extension by
 * its friendly label, one node per family (a copy under its origin), the parts of Thetis under one closed node.
 * A family with a to-do in the place's strip carries its one mark. An installation where `fleet` cannot answer
 * has only the two pages.
 */
export async function configurationChildren(ext, { user = me() } = {}) {
  const fleet = await ext.request("fleet").catch(() => ({ data: null }));
  const packages = Array.isArray(fleet?.data?.packages) ? fleet.data.packages : [];
  const rows = rowsFromFleet(packages, user);
  const place = placeOf(packages, user);
  const todo = new Map(place.attention.map((e) => [e.row.name, e]));
  const top = [];
  const parts = [];
  for (const family of familiesOf(rows)) {
    const node = (m, label) => {
      const d = described(m, { rows, user });
      const mark = markOf(todo.get(m.name));
      // The Extensions place's own entry, under the section called Extensions.
      const name = label ?? (d.label === "Extensions" ? "Extensions page" : d.label);
      return { id: m.name, label: name, why: mark?.why ?? d.publisher, ...(mark ? { mark: mark.mark, look: true } : {}) };
    };
    // The family's root: the shared copy everyone gets, else the member nothing else in it was copied from, else its headline.
    const root = family.members.find(isPromoted) ?? family.members.find((m) => m.name === family.origin) ?? family.headline;
    const parent = node(root);
    for (const m of family.members) {
      if (m === root) continue;
      // The original a shared copy was made from, or a published one went out from: the place's own title for it, "Notion — your original".
      const original = (isPromoted(root) || publishedCopyOf(m, family.members)) && !originNameOf(m) ? titleOf(m, { family: family.members, user, origin: officialOf(m, family) }) : null;
      const child = node(m, originNameOf(m) ? copyLabel(m, family, user) : original);
      child.note = `${child.label.startsWith(parent.label) ? child.label : `${parent.label}: ${child.label}`} — ${child.why}`;
      // A to-do on a member the tree folds away is the family's: the root carries the mark, so it is seen and counted once.
      if (child.look && !parent.look) Object.assign(parent, { mark: child.mark, look: true, why: child.why });
      delete child.look;
      delete child.why;
      (parent.children ??= []).push(child);
    }
    parent.note = `${parent.label} — ${parent.why}`;
    delete parent.why;
    (family.headline?.component ? parts : top).push(parent);
  }
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  top.sort(byLabel);
  parts.sort(byLabel);
  if (!packages.length) return [{ id: FLEET, label: "All extensions", kind: "page", note: "Every extension installed here" }, { id: WHO, label: "Who has what", kind: "page", note: "Every extension and which people have it" }];
  return [
    { id: FLEET, label: "All extensions", kind: "page", note: "Every extension installed here" },
    { id: WHO, label: "Who has what", kind: "page", note: "Every extension and which people have it" },
    ...top,
    ...(parts.length ? [{ id: PARTS, label: `Part of ${agentName()}`, closed: true, note: `Part of ${agentName()} — the ${parts.length} parts that make ${agentName()} run`, children: parts }] : []),
  ];
}

/**
 * The page under Extensions: All extensions (`*`), Who has what, Part of Thetis, or one extension's page. `tab`
 * and `layer` are a deep link's (another surface opening this page on its Settings tab, at everyone's layer or a
 * person's).
 */
export function mountConfiguration(ext, root, { child, refresh, user, open, tab = null, layer = null } = {}) {
  if (child === FLEET) return mountFleet(ext, root, { mode: "simple", refresh, onOpen: (name) => open?.(name), ...(user ? { user } : {}) });
  if (child === PARTS) return mountFleet(ext, root, { mode: "parts", refresh, onOpen: (name) => open?.(name), ...(user ? { user } : {}) });
  if (child === WHO) return mountFleet(ext, root, { mode: "full", refresh, onOpen: (name) => open?.(name), ...(user ? { user } : {}) });
  if (child) return mountPackagePage(ext, root, { name: child, refresh, open: open ?? null, tab, layer, ...(user ? { user } : {}) });
  const { el } = ext.dom;
  root.append(el("div", { class: "panel-cols" }, el("div", { class: "panel-col" }, el("p", { class: "panel-hint" }, "Choose All extensions under Extensions."))));
}

/**
 * What each key falls back to under a person's layer, from everyone's report: "everyone" when everyone's layer
 * or the server's file holds a value, "default" when the manifest gives one, "none" otherwise.
 */
export function fallbacksOf(report) {
  if (!report || !Array.isArray(report.keys)) return null;
  const out = {};
  for (const k of report.keys) {
    if (!k?.key) continue;
    out[k.key] = k.state === "unset" || k.state === "missing" || !k.source ? "none" : k.source === "default" ? "default" : "everyone";
  }
  return out;
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
  let below = null; // at a person's layer: what each key falls back to, from everyone's report
  let failed = null;
  let alive = true;

  async function load() {
    const stop = busy(wrap, `Reading ${label ?? child}…`);
    try {
      const [users, shown, where, everyone] = await Promise.all([
        ext.request("users"),
        ext.request("config-show", { args: person ? { name: child, user: person } : { name: child } }),
        holders ? null : ext.request("package-where", { args: { name: child } }).catch(() => null),
        person ? ext.request("config-show", { args: { name: child } }).catch(() => null) : null,
      ]);
      below = person ? fallbacksOf(everyone?.data) : null;
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
      me: user,
      below,
      // The server's file and `${VAR}`, an admin troubleshooting's business: inside the form's Advanced fold.
      advanced: () => el("div", { class: "ua-settings-advanced" }, el("p", { class: "panel-hint" }, "A value set here is used from the extension's next call; an extension that runs a service has it restarted. ${VAR} in a value is read from the server's environment when the extension is called. The server's file thetis.config.json is read once; Read the file again reads it again."), el("div", {}, reloadBtn)),
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
      el("div", { class: "toolbar" }, heading("Settings", person ? (mine ? "your own" : `${person}'s own`) : "what everyone gets, unless they set their own"), el("div", { class: "toolbar-gap" }), layer),
      card
    );
  }

  void load();
  return () => {
    alive = false;
  };
}

/* One extension's page in the control panel: the same header every extension surface uses (its friendly
 * label with the raw id as the tooltip, the publisher line, at most two chips, the description, a line on who
 * has it and where it runs, and a banner with the one sentence when it asks for attention), the admin's
 * actions on it, and the tabs: Overview, Settings, Activity, README, and Advanced. The actions are Update
 * (a registry holds a newer commit), Use Thetis's version (the admin's own customised copy, when the official
 * one is newer), Share with everyone… (a person's own extension; replaced by a disabled line when the copy is
 * older than Thetis's, so sharing never downgrades everyone), Turn on for everyone… and Turn off for
 * everyone… (an extension by Thetis or a registry), and Remove for everyone…, whose confirm names the people
 * who lose it. An extension Required by Thetis has no Remove of any kind: the button area says so. Advanced
 * holds what is for troubleshooting: making your own copy, where it runs person by person, and its history in
 * git. The page reads `package-info`, `package-where` and the system layer's `config-show` once and hands what
 * it read to every tab through `ctx`; a tab that needs more asks for it itself. An action goes behind the
 * shell's confirm popover, toasts the answer, reads the page again and asks the tree to read its children
 * again, so the marks beside the extensions follow. There is no restart button here: applying updates is one
 * action for everyone, on the extensions pages. */

import { mountActivity } from "./package-activity.js";
import { mountHistory } from "./package-history.js";
import { mountOverview } from "./package-overview.js";
import { mountReadme } from "./package-readme.js";
import { mountWhere } from "./package-where.js";
import { mountSettings } from "./configuration.js";
import { failureSentence, toastError } from "./failed.js";
import { described, rowFromInfo } from "./rows.js";
import { chipBadges, isRequired, labelOf, useOriginLabel, waitingSentence, WORDS } from "./state.js";

const TABS = [
  ["overview", "Overview"],
  ["configuration", "Settings"],
  ["activity", "Activity"],
  ["readme", "README"],
  ["advanced", "Advanced"],
];

/** The pages inside the Advanced tab. */
const ADVANCED = [
  ["where", "Where it runs"],
  ["history", "History"],
];

/** The signed-in person, as the shell's footer names them; the seam hands a package no identity. */
function me() {
  return document.getElementById("user-name")?.textContent?.trim() || null;
}

const shortHash = (hash) => (typeof hash === "string" ? hash.slice(0, 7) : "");

export function mountPackagePage(ext, root, { name, refresh, user = me() }) {
  const { el, clear } = ext.dom;
  const { button, busy, confirm, put } = ext.ui;
  let alive = true;
  let info = null;
  let where = null;
  let config = null; // the system layer's configuration report, for the one state
  let tab = "overview";
  let unmountTab = null;
  let pending = null; // what a tab was asked to show when it opens: { layer } or { actor }
  let inner = "where"; // the Advanced tab's page

  const page = el("div", { class: "ua-pkg" });
  const head = el("div", { class: "ua-pkg-head" });
  const tabs = el("div", { class: "ua-pkg-tabs", role: "tablist" });
  const body = el("div", { class: "ua-pkg-body" });
  root.append(page);
  put(page, head, tabs, body);

  /** What every tab may read and do. */
  const ctx = {
    name,
    user,
    get info() {
      return info;
    },
    get where() {
      return where;
    },
    refresh,
    reload: () => load(),
    /** Whether Thetis cannot work without it: no Remove of any kind, anywhere on the page. */
    get required() {
      return isRequired(info ?? { name });
    },
    /** Opens a tab, with a word for it: `{ layer: user }` for Settings, `{ actor: user }` for Activity. History and Where it runs are in Advanced. */
    show: (id, want = null) => {
      pending = want;
      if (ADVANCED.some(([key]) => key === id)) {
        inner = id;
        return showTab("advanced");
      }
      showTab(id);
    },
    act,
    // Permission tags left the page with the permission legend; a card that asked for one gets nothing.
    tag: () => null,
  };

  async function load() {
    const stop = busy(page, `Reading ${name}…`);
    try {
      // A package installed nowhere (removed for everyone, or replaced by a fork in every workspace) has no
      // record to read, but people and the where card still answer, and Install for them is the way back.
      let refused = null;
      const [about, runs, shown] = await Promise.all([
        ext.request("package-info", { args: { name } }).catch((err) => ((refused = err?.message || "could not be read"), { data: null })),
        ext.request("package-where", { args: { name } }).catch(() => ({ data: null })),
        ext.request("config-show", { args: { name } }).catch(() => ({ data: null })),
      ]);
      if (!alive) return;
      if (refused) ext.toast(failureSentence(label(), { message: refused }, { admin: true }), { tone: "warn" });
      info = about?.data ?? null;
      where = runs?.data ?? null;
      config = shown?.data ?? null;
    } catch (err) {
      if (!alive) return;
      toastError(ext, err, label());
    } finally {
      stop();
    }
    if (!alive) return;
    drawHead();
    showTab(tab);
  }

  // ---- actions: each confirmed, then toasted, then the page read again ----

  /**
   * Runs one command against the package after the person confirms it. `lines` are the facts in the
   * popover; the answer's `data.text` or a sentence of ours becomes the toast.
   */
  async function act(anchor, { verb, args, title, lines = [], note, confirmLabel = "Confirm", tone = "primary", said }) {
    const ok = await confirm(anchor, { title, lines: [["extension", name], ...lines], note, confirmLabel, tone });
    if (!ok || !alive) return false;
    anchor.disabled = true;
    try {
      const out = await ext.request(verb, { args: { name, ...args } });
      ext.toast(out?.data?.text || out?.text || said || `${title.replace(/\?$/, "")}: done.`, { tone: "good" });
    } catch (err) {
      toastError(ext, err, title.replace(/\?$/, ""));
      return false;
    } finally {
      if (alive) anchor.disabled = false;
    }
    if (!alive) return true;
    await load();
    refresh?.();
    return true;
  }

  /** The extension as the one state reads it, and that state. */
  const row = () => rowFromInfo(info, { config, where, user }) ?? { name, installed: false };
  const said = () => described(row(), { user });
  const label = () => (info ? said().label : labelOf({ name }));
  /** The people who have it, by id: whom Remove for everyone… names. */
  const holders = () => (where?.people ?? []).filter((p) => p.installed).map((p) => p.user);
  const owner = () => where?.people?.find((p) => p.installed)?.user ?? user;
  /** The admin's own copy of this extension, which Use Thetis's version speaks for. */
  const mineCopy = () => Boolean(info?.forkedFrom) && (where?.people ?? []).some((p) => p.user === user && p.installed && p.version === info.version);
  /** A person's own extension (not one shipped with Thetis) that everyone does not get yet: the one Share with everyone applies to. */
  const shareable = () => info && !info.everyone && info.source?.kind !== "system" && !name.startsWith("@thetis/");
  /** By Thetis or a registry, and not a promoted copy: what Turn on and Turn off for everyone are for. */
  const offered = () => info && info.everyoneBy !== "promoted" && (info.source?.kind === "system" || info.source?.kind === "git" || name.startsWith("@thetis/"));

  const line = (text, cls = "text-faint") => el("span", { class: `ua-pkg-action-line ${cls}` }, text);

  function actions() {
    const out = [];
    if (!info) return out;
    const reg = info.registry;
    const r = row();
    // Applying has nothing to install: the copy on disk is installed already, and applying updates puts it into service.
    if (reg?.update && reg.update.apply !== "reload") {
      const b = button("Update", { tone: "primary", title: `Update to ${reg.update.version}` });
      b.addEventListener("click", () => void act(b, { verb: "package-update", args: {}, title: "Update this extension?", lines: [["from", `${info.version} · ${shortHash(reg.update.installed)}`], ["to", `${reg.update.version} · ${shortHash(reg.update.available)}`], ["registry", reg.registry]], note: "The registry's copy replaces this one for everyone who has it. Updating keeps their settings. Each person gets it the next time their workspace applies updates.", confirmLabel: "Update" }));
      out.push(b);
    }
    // The official version moved past the one this copy was made from: the place's "origin" kind of update.
    const origin = said().state.update;
    const newer = origin?.kind === "origin" ? origin.to : null;
    if (newer && mineCopy()) {
      const back = button(useOriginLabel(r, user), { tone: "primary" });
      back.addEventListener("click", () => void act(back, { verb: "package-unfork", args: {}, title: `${useOriginLabel(r, user)}?`, lines: [["instead of", `your copy ${info.version}`], ["you get", `${info.forkedFrom.name} ${newer}`]], note: "Your copy stops being used for you; its files stay in your folder. Your saved settings are kept.", confirmLabel: "Use Thetis's version" }));
      out.push(back);
    }
    if (shareable()) {
      if (newer) out.push(line(`Your copy is older than Thetis's ${newer}; sharing it would replace it for everyone.`, "text-faint is-guard"));
      else if (info.sharedAs) out.push(line(`Already shared with everyone as ${label()}`));
      else {
        const share = button("Share with everyone…");
        const from = owner();
        share.addEventListener("click", () => void act(share, { verb: "package-promote", args: { user: from }, title: "Share with everyone?", lines: [["from", `${from}'s extension`], ["as", `${label()} (@thetis/${name.slice(name.indexOf("/") + 1)})`]], note: `Everyone gets a shared copy named ${label()}. Your own stays yours.`, confirmLabel: "Share with everyone" }));
        out.push(share);
      }
    }
    if (offered()) {
      if (!info.everyone) {
        const on = button("Turn on for everyone…");
        on.addEventListener("click", () => void act(on, { verb: "package-everyone", args: { on: true }, title: "Turn on for everyone?", lines: [["for", "every person, and new people too"]], note: "Every person gets it in their space. Anyone can still remove it for themselves.", confirmLabel: "Turn on for everyone" }));
        out.push(on);
      } else if (info.everyoneBy === "marked") {
        const off = button("Turn off for everyone…");
        off.addEventListener("click", () => void act(off, { verb: "package-everyone", args: { on: false }, title: "Turn off for everyone?", lines: [], note: "New people stop getting it; people who have it keep it.", confirmLabel: "Turn off for everyone" }));
        out.push(off);
      } else if (info.everyoneBy === "config") out.push(line("For everyone by the server's settings file"));
    }
    if (ctx.required) out.push(line(WORDS.required, "ua-pkg-required"));
    else if (holders().length) {
      const people = holders();
      const remove = button("Remove for everyone…", { tone: "warn" });
      remove.addEventListener("click", () => void act(remove, { verb: "package-remove", args: { user: "*" }, title: "Remove for everyone?", lines: [["people", people.join(", ")]], note: `${people.length === 1 ? `${people[0]} loses` : `These ${people.length} people lose`} it from their next reply. Their saved settings are kept, and the files stay where they are.${info.everyone ? " New people still get it while it is for everyone." : ""}`, confirmLabel: "Remove for everyone", tone: "warn" }));
      out.push(remove);
    }
    return out;
  }

  // ---- the header ----

  /** Who has it and where it runs, in one line, from `package-where`; the checkout's own warnings end it. */
  function facts() {
    const parts = [];
    const c = where?.counts ?? {};
    if (typeof c.installed === "number" && typeof c.people === "number") parts.push(el("span", {}, "installed for ", el("b", {}, `${c.installed} of ${c.people}`), " people"));
    const loaded = (where?.people ?? []).filter((p) => p.installed && p.loaded?.openedAt).length;
    if (loaded) parts.push(el("span", {}, "open in ", el("b", {}, String(loaded)), ` workspace${loaded === 1 ? "" : "s"}`));
    if (c.waiting) parts.push(el("b", { class: "ua-warn" }, waitingSentence(c.waiting)));
    const services = (where?.people ?? []).filter((p) => Array.isArray(p.services) && p.services.includes(name)).length;
    if (services) parts.push(el("span", {}, "a service in ", el("b", {}, String(services)), ` workspace${services === 1 ? "" : "s"}`));
    if (c.forks) parts.push(el("span", {}, el("b", {}, String(c.forks)), ` own ${c.forks === 1 ? "copy" : "copies"}`));
    if (info?.git?.ahead) parts.push(el("span", { class: "ua-warn" }, `${info.git.ahead} commit${info.git.ahead === 1 ? "" : "s"} not pushed`));
    if (info?.git?.changed) parts.push(el("span", { class: "ua-warn" }, `${info.git.changed} file${info.git.changed === 1 ? "" : "s"} uncommitted`));
    if (!parts.length) return null;
    return el("div", { class: "ua-pkg-facts-line" }, ...parts.flatMap((p, i) => (i ? [el("span", { class: "ua-sep" }, "·"), p] : [p])));
  }

  function drawHead() {
    clear(head);
    const shown = info ? said() : null;
    const state = shown?.state ?? { chips: [], attention: false, reason: "", waiting: false, setup: { chip: false } };
    const tone = state.setup?.chip ? "err" : "warn";
    put(
      head,
      el("div", { class: "ua-pkg-crumb" }, el("span", {}, "Control panel"), el("span", { class: "ua-sep" }, "/"), el("span", {}, "Extensions"), el("span", { class: "ua-sep" }, "/"), el("span", { title: name }, label())),
      el(
        "div",
        { class: "ua-pkg-title-row" },
        el(
          "div",
          { class: "ua-pkg-title-col" },
          el("div", { class: "ua-pkg-title" }, el("h2", { class: "ua-pkg-name", title: name }, label()), info?.version ? el("span", { class: "ua-pkg-version" }, info.version) : null, ...chipBadges(ext, state)),
          shown ? el("div", { class: "ua-pkg-pub text-dim" }, shown.publisher) : null,
          info?.description ? el("p", { class: "ua-pkg-desc" }, info.description) : null,
          facts()
        ),
        el("div", { class: "ua-pkg-actions-col" }, el("div", { class: "ua-pkg-actions" }, ...actions()))
      ),
      state.attention && state.reason ? el("div", { class: `ua-pkg-banner is-${tone}`, role: "status" }, state.reason) : state.waiting ? el("div", { class: "ua-pkg-banner is-dim" }, WORDS.waiting) : null
    );
    drawTabs();
  }

  function drawTabs() {
    clear(tabs);
    for (const [id, label] of TABS) {
      put(tabs, el("button", { type: "button", role: "tab", class: `ua-pkg-tab${id === tab ? " is-on" : ""}`, "aria-selected": id === tab ? "true" : "false", "data-tab": id, onClick: () => showTab(id) }, label));
    }
  }

  // ---- the tabs ----

  function showTab(id) {
    if (!alive) return;
    tab = id;
    drawTabs();
    unmountTab?.();
    unmountTab = null;
    clear(body);
    body.className = `ua-pkg-body is-${id}`;
    const want = pending;
    pending = null;
    switch (id) {
      case "overview":
        unmountTab = mountOverview(ext, body, ctx);
        break;
      case "configuration":
        unmountTab = mountSettings(ext, body, { child: name, refresh });
        if (want?.layer) chooseLayer(want.layer);
        break;
      case "advanced":
        unmountTab = mountAdvancedTab(body);
        break;
      case "activity":
        unmountTab = mountActivity(ext, body, { ...ctx, actor: want?.actor ?? null });
        break;
      case "readme":
        unmountTab = mountReadme(ext, body, ctx);
        break;
      default:
        break;
    }
    if (typeof unmountTab !== "function") unmountTab = null;
  }

  /**
   * The Advanced tab: making your own copy, then Where it runs and History behind a small switch. Your own copy
   * is a copy of the files in your home, used instead of this extension for you until you remove it.
   */
  function mountAdvancedTab(host) {
    let unmountInner = null;
    const fork = button("Make your own copy");
    fork.addEventListener("click", () => void act(fork, { verb: "package-fork", args: {}, title: "Make your own copy?", lines: [["as", `@${user ?? "you"}/${name.slice(name.indexOf("/") + 1)}`]], note: "A copy of the files lands in packages/ under your home, ready to edit, and is used instead of this extension for you. Use Thetis's version to go back to the official one.", confirmLabel: "Make a copy" }));
    const strip = el("div", { class: "ua-pkg-tabs ua-pkg-subtabs", role: "tablist" });
    const inside = el("div", { class: "ua-pkg-advanced-body" });
    function drawInner() {
      clear(strip);
      for (const [id, label] of ADVANCED) put(strip, el("button", { type: "button", role: "tab", class: `ua-pkg-tab${id === inner ? " is-on" : ""}`, "aria-selected": id === inner ? "true" : "false", "data-tab": id, onClick: () => { inner = id; drawInner(); } }, label));
      unmountInner?.();
      unmountInner = null;
      clear(inside);
      const out = inner === "history" ? mountHistory(ext, inside, { name, ctx }) : mountWhere(ext, inside, ctx);
      unmountInner = typeof out === "function" ? out : null;
    }
    put(host, el("div", { class: "card ua-own-copy" }, el("div", { class: "card-body" }, el("div", { class: "ua-line" }, fork, el("span", { class: "text-dim" }, "A copy of your own to change, used instead of this one for you.")))), strip, inside);
    drawInner();
    return () => {
      unmountInner?.();
      unmountInner = null;
    };
  }

  /** Points the settings form's layer select at a person once the form has drawn; the form loads its answer first. */
  function chooseLayer(person) {
    const deadline = Date.now() + 8000;
    const tick = () => {
      if (!alive || tab !== "configuration") return;
      const select = body.querySelector('.ua-configuration select[aria-label="Layer"]');
      if (select && [...select.options].some((o) => o.value === person)) {
        if (select.value !== person) {
          select.value = person;
          select.dispatchEvent(new Event("change"));
        }
        return;
      }
      if (Date.now() < deadline) setTimeout(tick, 120);
    };
    tick();
  }

  void load();
  return () => {
    alive = false;
    unmountTab?.();
    unmountTab = null;
  };
}

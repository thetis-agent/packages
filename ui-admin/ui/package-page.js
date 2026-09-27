/* One extension's page in the control panel: the same header every extension surface uses (its friendly
 * label with the raw id as the tooltip, the publisher line, at most two chips, the description, a line on who
 * has it and where it runs, and a banner with the one sentence when it asks for attention), the admin's
 * actions on it, and the tabs: Overview, Settings, Activity, README, and Advanced. Advanced holds what is for
 * troubleshooting: making your own copy, where it runs person by person, and its history in git. The page
 * reads `package-info`, `package-where` and everyone's `config-show` once and hands what it read to every tab
 * through `ctx`; a tab that needs more asks for it itself. An action goes behind the shell's confirm popover,
 * toasts the answer, reads the page again and asks the tree to read its children again, so the marks beside the
 * extensions follow. A save or a clear in Settings redraws the header's chips and banner at once.
 *
 * What everyone gets is one table (the Extensions fix round's decision 8), the same in the Extensions place:
 * - a shared copy says "Shared with everyone from <label> by <person> on <date>. Your people get this one." The
 *   kernel cannot stop a promotion (`packages.unmarkEveryone` refuses one), so there is no Stop sharing button,
 *   and Remove for everyone… says plainly that it stays shared;
 * - its original says "Already shared with everyone as <label>" with Open it, and nothing else;
 * - a copy of someone's may be shared by its owner (never offered when the official version is newer: sharing
 *   would replace it for everyone), and never says "Already shared";
 * - by Thetis or a registry and not for everyone: Turn on for everyone…, whose confirm says when it needs a key;
 *   marked for everyone: Turn off for everyone… and Remove for everyone…, each saying what happens to whom;
 * - admin-only (`audience: "admin"`, host, storage, the sign-in page): no Turn on, and "Only admins can have
 *   this."; what runs inside Thetis itself (the sign-in page, the registries' service, gateways, storage, host,
 *   anything only the system workspace holds): no Install, no Turn on, no Remove;
 * - Remove for everyone… only when someone besides the reader has it ("Only you have this. Use Remove for me.");
 *   never on an extension Required by Thetis. There is no restart button here: applying updates is one action
 *   for everyone, on the extensions pages. */

import { mountActivity } from "./package-activity.js";
import { mountHistory } from "./package-history.js";
import { mountOverview } from "./package-overview.js";
import { mountReadme } from "./package-readme.js";
import { mountWhere } from "./package-where.js";
import { mountSettings } from "./configuration.js";
import { failureSentence, toastError } from "./failed.js";
import { described, rowFromInfo } from "./rows.js";
import { compareVersions, everyoneActions, isAdminOnly, isRequired, labelOf, listOf, nounOf, titleCase, useOriginLabel, WORDS } from "./state.js";
import { chipBadges, waitingSentence } from "./words.js";

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

/** What runs inside Thetis itself rather than for a person: nobody installs it, turns it on or removes it. */
export const RUNS_INSIDE = Object.freeze({
  types: Object.freeze(["gateway", "storage", "host"]),
  names: Object.freeze(["@thetis/gateway-login", "@thetis/marketplace"]),
  line: "Runs inside Thetis itself",
});

/** Whether an extension runs inside Thetis itself: by its type or name, or held by the system workspace alone. */
export const runsInside = (info) => !!info && (RUNS_INSIDE.types.includes(info.type) || RUNS_INSIDE.names.includes(info.name) || info.systemOnly === true);

/** The sentence an admin-only extension says where a person would be offered it. */
export const ADMINS_ONLY_LINE = "Only admins can have this.";

/** The deep links a page may be opened with: another surface's tab names, as this page calls them. */
const TAB_ALIASES = { people: "overview", settings: "configuration" };

/** The signed-in person, as the shell's footer names them; the seam hands a package no identity. */
function me() {
  return document.getElementById("user-name")?.textContent?.trim() || null;
}

const shortHash = (hash) => (typeof hash === "string" ? hash.slice(0, 7) : "");

/**
 * The sentence the Turn on confirm adds for an extension that needs a key before it works: what it needs, and
 * whether anyone has one. `config` is everyone's report; `people` what package-where says of each person.
 */
export function needsSentence(config, people = []) {
  const keys = (config?.keys ?? []).filter((k) => k?.state === "missing" && k.required !== false);
  if (!keys.length) return null;
  const nouns = keys.map((k) => nounOf(k).noun);
  const nobody = !people.some((p) => p.installed && p.config && !p.config.broken);
  return `It needs ${listOf(nouns)}.${nobody ? " Nobody has one yet: set one for everyone first, or each person sets their own." : " Set one for everyone, or each person sets their own."}`;
}

export function mountPackagePage(ext, root, { name, refresh, user = me(), open = null, tab: wantTab = null, layer: wantLayer = null }) {
  const { el, clear } = ext.dom;
  const { button, busy, confirm, put } = ext.ui;
  let alive = true;
  let info = null;
  let where = null;
  let config = null; // everyone's configuration report, for the one state
  let gone = false; // installed in no workspace now: said on the page, never as a failure
  let tab = TAB_ALIASES[wantTab] ?? (TABS.some(([id]) => id === wantTab) ? wantTab : "overview");
  let unmountTab = null;
  let pending = tab === "configuration" && typeof wantLayer === "string" ? { layer: wantLayer } : null; // what a tab was asked to show when it opens: { layer } or { actor }
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
    get label() {
      return label();
    },
    refresh,
    reload: () => load(),
    /** Whether Thetis cannot work without it: no Remove of any kind, anywhere on the page. */
    get required() {
      return isRequired(info ?? { name });
    },
    /** Runs inside Thetis itself: nobody installs it, turns it on or removes it. */
    get inside() {
      return runsInside(info);
    },
    /** Only an admin may have it: the people list offers it to admins only. */
    get adminOnly() {
      return isAdminOnly(info ?? { name });
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

  /** Reads the page's three answers. `quiet` redraws the header alone, as after a save in Settings. */
  async function load({ quiet = false } = {}) {
    const stop = quiet ? () => {} : busy(page, `Reading ${label()}…`);
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
      // Nobody has it any more (the last person's was just removed): that is the page's news, not a failure.
      gone = Boolean(refused && /not installed in any workspace/.test(refused));
      if (refused && !gone) ext.toast(failureSentence(label(), { message: refused }, { admin: true }), { tone: "warn" });
      info = about?.data ?? (gone ? null : info);
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
    if (!quiet) showTab(tab);
  }

  // ---- actions: each confirmed, then toasted, then the page read again ----

  /**
   * Runs one command against the package after the person confirms it. `lines` are the facts in the
   * popover; the answer's `data.text` or a sentence of ours becomes the toast.
   */
  async function act(anchor, { verb, args, title, lines = [], note, confirmLabel = "Confirm", tone = "primary", said: done }) {
    const ok = await confirm(anchor, { title, lines: [["extension", label()], ...lines], note, confirmLabel, tone });
    if (!ok || !alive) return false;
    anchor.disabled = true;
    try {
      const out = await ext.request(verb, { args: { name, ...args } });
      ext.toast(out?.data?.text || out?.text || done || `${title.replace(/\?$/, "")}: done.`, { tone: "good" });
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
  /** The official version, when it is newer than the one this copy was made from. */
  const officialNewer = () => {
    const base = info?.fork?.version ?? info?.forkedFrom?.version ?? null;
    const shipped = info?.fork?.shipped ?? info?.origin?.version ?? null;
    return base && shipped && compareVersions(shipped, base) > 0 ? shipped : null;
  };

  const line = (text, cls = "text-faint") => el("span", { class: `ua-pkg-action-line ${cls}` }, text);

  /**
   * The row the decision table reads (state.js's `everyoneActions`, the Extensions place's own rules): this
   * extension as the reader has it, its family (the shared copy an original was shared as), and who has it.
   */
  function table() {
    const r = { ...row(), installed: holders().includes(user) };
    const family = [r, ...(info.sharedAs ? [{ name: info.sharedAs, label: info.label, everyone: true, everyoneBy: "promoted" }] : [])];
    return everyoneActions(r, { family, user, holders: holders(), origin: said().origin ?? (info.origin ? { name: info.origin.name, label: info.origin.label, version: info.origin.version } : null), label: label() });
  }

  function actions() {
    const out = [];
    if (!info) return out;
    const reg = info.registry;
    const r = row();
    // Only a real newer version of what is installed: a registry's newer commit. Applying what is on disk is
    // one action for everyone, on All extensions.
    if (reg?.update?.apply === "install") {
      const b = button("Update", { tone: "primary", title: `Update to ${reg.update.version}` });
      b.addEventListener("click", () => void act(b, { verb: "package-update", args: {}, title: `Update ${label()}?`, lines: [["from", `${info.version} · ${shortHash(reg.update.installed)}`], ["to", `${reg.update.version} · ${shortHash(reg.update.available)}`], ["registry", reg.registry]], note: "The registry's copy replaces this one for everyone who has it. Updating keeps their settings. Each person gets it the next time their workspace applies updates.", confirmLabel: "Update" }));
      out.push(b);
    }
    // A customised copy whose official version moved on: not an update, a choice, said with what it costs.
    const newer = officialNewer();
    if (newer && mineCopy()) {
      const back = button(useOriginLabel(r, user));
      const whose = useOriginLabel(r, user).replace(/^Use /, "").replace(/ version$/, "");
      back.addEventListener("click", () => void act(back, { verb: "package-unfork", args: {}, title: `${useOriginLabel(r, user)}?`, lines: [["instead of", `your copy ${info.version}`], ["you get", `${titleCase(info.origin?.label ?? label())} ${newer}`]], note: `${useOriginLabel(r, user)} replaces your changes with ${whose} ${newer}. Your copy's files stay in your folder, and your saved settings are kept.`, confirmLabel: useOriginLabel(r, user) }));
      out.push(back);
    }
    // What everyone gets: one row of the decision table, the place's own rules.
    const t = table();
    const inside = runsInside(info);
    for (const text of t.lines) {
      if (text === WORDS.adminOnly || /^Runs inside Thetis/.test(text)) continue; // said once, below
      if (t.open && /^Already shared/.test(text)) {
        const go = button("Open it", { onClick: () => open?.(t.open) });
        go.classList.add("is-sm");
        out.push(el("span", { class: "ua-pkg-action-line text-faint" }, `${text} `, open ? go : null));
      } else if (text === WORDS.onlyYou) continue; // after the other actions
      else out.push(line(text, /older than Thetis/.test(text) ? "text-faint is-guard" : /^Shared with everyone/.test(text) ? "ua-pkg-shared" : "text-faint"));
    }
    if (inside) out.push(line(RUNS_INSIDE.line));
    else if (isAdminOnly(info)) out.push(line(ADMINS_ONLY_LINE));
    if (!inside && t.acts.includes("share")) {
      const share = button("Share with everyone…");
      const from = owner();
      share.addEventListener("click", () => void act(share, { verb: "package-promote", args: { user: from }, title: `Share ${label()} with everyone?`, lines: [["from", `${from}'s extension`], ["as", label()]], note: `Everyone gets a shared copy named ${label()}. Your own stays yours.`, confirmLabel: "Share with everyone" }));
      out.push(share);
    }
    if (!inside && t.acts.includes("turnOn")) {
      const on = button("Turn on for everyone…");
      const needs = needsSentence(config, where?.people ?? []);
      on.addEventListener("click", () => void act(on, { verb: "package-everyone", args: { on: true }, title: `Turn on ${label()} for everyone?`, lines: [["for", "every person, and new people too"]], note: `Every person gets it. Anyone can still remove it for themselves.${needs ? ` ${needs}` : ""}`, confirmLabel: "Turn on for everyone" }));
      out.push(on);
    }
    if (!inside && t.acts.includes("turnOff")) {
      const off = button("Turn off for everyone…");
      off.addEventListener("click", () => void act(off, { verb: "package-everyone", args: { on: false }, title: `Turn off ${label()} for everyone?`, lines: [], note: t.hints.turnOff ?? WORDS.turnOffHint, confirmLabel: "Turn off for everyone" }));
      out.push(off);
    }
    if (ctx.required) out.push(line(WORDS.required, "ua-pkg-required"));
    else if (!inside && t.acts.includes("removeEveryone")) {
      // Last, so a destructive action is never the first thing on the page.
      const people = holders();
      const remove = button("Remove for everyone…", { tone: "warn" });
      const stays = info.everyoneBy === "promoted" ? " It stays shared, so people added later still get it." : info.everyoneBy === "marked" ? " New people still get it until it is turned off for everyone." : info.everyoneBy === "config" ? " New people still get it: Server settings give it to everyone." : "";
      remove.addEventListener("click", () => void act(remove, { verb: "package-remove", args: { user: "*" }, title: `Remove ${label()} for everyone?`, lines: [["people", people.join(", ")]], note: `${t.hints.removeEveryone ?? `It is taken away from ${listOf(people)} now.`} Their saved settings are kept.${stays}`, confirmLabel: "Remove for everyone", tone: "warn" }));
      out.push(remove);
    } else if (!inside && t.lines.includes(WORDS.onlyYou)) out.push(line(WORDS.onlyYou));
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
    if (c.forks) parts.push(el("span", {}, el("b", {}, String(c.forks)), ` customised ${c.forks === 1 ? "copy" : "copies"}`));
    if (info?.git?.ahead) parts.push(el("span", { class: "ua-warn" }, `${info.git.ahead} commit${info.git.ahead === 1 ? "" : "s"} not pushed`));
    if (info?.git?.changed) parts.push(el("span", { class: "ua-warn" }, `${info.git.changed} file${info.git.changed === 1 ? "" : "s"} uncommitted`));
    if (!parts.length) return null;
    return el("div", { class: "ua-pkg-facts-line" }, ...parts.flatMap((p, i) => (i ? [el("span", { class: "ua-sep" }, "·"), p] : [p])));
  }

  function drawHead() {
    clear(head);
    const shown = info ? said() : null;
    const state = shown?.state ?? { chips: [], attention: false, reason: "", waiting: false, setup: { chip: false } };
    const tone = state.tone ?? (state.setup?.chip ? "err" : "warn"); // an optional setup (given to everyone) is neutral
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
          facts(),
          gone ? el("p", { class: "ua-pkg-desc" }, "Nobody has this now. Install it for someone under Who has it.") : null,
          // The banner sits with the title, so on a phone it comes before the actions under it.
          state.attention && state.reason ? el("div", { class: `ua-pkg-banner is-${tone}`, role: "status" }, state.reason) : state.waiting ? el("div", { class: "ua-pkg-banner is-dim" }, WORDS.waiting) : null
        ),
        el("div", { class: "ua-pkg-actions-col" }, el("div", { class: "ua-pkg-actions" }, ...actions()))
      )
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
        unmountTab = mountSettings(ext, body, { child: name, refresh, user, label: label(), layer: typeof want?.layer === "string" ? want.layer : "", onChange: () => void load({ quiet: true }) });
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

  void load();
  return () => {
    alive = false;
    unmountTab?.();
    unmountTab = null;
  };
}

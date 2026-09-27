/* One extension's page: the header (name, version, its state in a few badges, the description, a line on
 * who has it and where it runs), the everyday actions on it, and the tabs: Overview, Settings, Activity,
 * README, and Advanced. The everyday actions are Update (when its registry holds a newer commit), Make it
 * the default for everyone (for a person's own extension) and Remove. Advanced holds what is for
 * troubleshooting: making your own copy, where it runs person by person, and its history in git. The page
 * reads `package-info` and `package-where` once and hands what it read to every tab through `ctx`; a tab
 * that needs more asks for it itself. An action goes behind the shell's confirm popover, toasts the answer,
 * reads the page again and asks the tree to read its children again, so the marks beside the extensions
 * follow. There is no restart button here: applying updates is one action for everyone, on the extensions
 * pages. */

import { mountActivity } from "./package-activity.js";
import { mountHistory } from "./package-history.js";
import { mountOverview } from "./package-overview.js";
import { mountReadme } from "./package-readme.js";
import { mountWhere } from "./package-where.js";
import { mountSettings } from "./configuration.js";
import { copyState } from "./package-card.js";
import { failureSentence, toastError } from "./failed.js";
import { shortName, stateBadge, waitingSentence } from "./state.js";

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
  const { badge, button, busy, confirm, put } = ext.ui;
  let alive = true;
  let info = null;
  let where = null;
  let config = null; // the system-layer report's summary, for the header badge
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
      if (refused) ext.toast(failureSentence(shortName(name), { message: refused }, { admin: true }), { tone: "warn" });
      info = about?.data ?? null;
      where = runs?.data ?? null;
      config = shown?.data ? { broken: Boolean(shown.data.broken), summary: shown.data.summary || "" } : null;
    } catch (err) {
      if (!alive) return;
      toastError(ext, err, shortName(name));
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

  /** A person's own extension (not one shipped with Thetis) that everyone does not get yet: the one Make it the default applies to. */
  const promotable = () => info && !info.everyone && info.source?.kind !== "system" && !name.startsWith("@thetis/");
  const owner = () => where?.people?.find((p) => p.installed)?.user ?? user;

  function actions() {
    const out = [];
    const reg = info?.registry;
    // Applying has nothing to install: the copy on disk is installed already, and applying updates puts it into service.
    if (reg?.update && reg.update.apply !== "reload") {
      const b = button(`Update to ${reg.update.version}`, { tone: "primary" });
      b.addEventListener("click", () => void act(b, { verb: "package-update", args: {}, title: "Update this extension?", lines: [["from", `${info.version} · ${shortHash(reg.update.installed)}`], ["to", `${reg.update.version} · ${shortHash(reg.update.available)}`], ["registry", reg.registry]], note: "The registry's copy replaces this one for everyone who has it. Each person gets it the next time their workspace applies updates.", confirmLabel: "Update" }));
      out.push(b);
    }
    if (promotable()) {
      const promote = button("Make it the default for everyone");
      const from = owner();
      promote.addEventListener("click", () => void act(promote, { verb: "package-promote", args: { user: from }, title: "Make it the default for everyone?", lines: [["from", `${from}'s extension`], ["as", `@thetis/${name.slice(name.indexOf("/") + 1)}`]], note: "It is copied into the extensions Thetis ships, the person's own copy is removed, and every workspace gets it.", confirmLabel: "Make it the default" }));
      out.push(promote);
    }
    const remove = button("Remove", { tone: "warn" });
    const everyone = Boolean(info?.everyone);
    remove.addEventListener("click", () => void act(remove, { verb: "package-remove", args: { user: everyone ? "*" : owner() }, title: everyone ? "Remove this extension for everyone?" : "Remove this extension?", lines: [["from", everyone ? "every workspace" : `${owner()}'s workspace`]], note: "The files stay in place; only the link is removed. Its tools stop on the next reply.", confirmLabel: "Remove", tone: "warn" }));
    out.push(remove);
    return out;
  }

  // ---- the header ----

  function headBadges() {
    const out = [badge(info?.type ?? "extension", "dim")];
    if (info?.everyone) out.push(badge("Default for everyone", "accent"));
    if (config) out.push(config.broken ? badge(`needs setup: ${config.summary}`, "err") : badge("set up", "ok"));
    if (info?.forkedFrom) out.push(badge(`own copy of ${info.forkedFrom.name}`, "warn"));
    if (info) out.push(stateBadge(ext, copyState(info)));
    if (info?.git?.ahead) out.push(badge(`${info.git.ahead} commit${info.git.ahead === 1 ? "" : "s"} not pushed`, "warn"));
    if (info?.git?.changed) out.push(badge(`${info.git.changed} file${info.git.changed === 1 ? "" : "s"} uncommitted`, "warn"));
    return out;
  }

  /** Who has it and where it runs, in one line, from `package-where`. Nothing is said about what is not known. */
  function facts() {
    if (!where) return null;
    const c = where.counts ?? {};
    const parts = [];
    if (typeof c.installed === "number" && typeof c.people === "number") parts.push(el("span", {}, "installed for ", el("b", {}, `${c.installed} of ${c.people}`), " people"));
    const loaded = (where.people ?? []).filter((p) => p.installed && p.loaded?.openedAt).length;
    if (loaded) parts.push(el("span", {}, "open in ", el("b", {}, String(loaded)), ` workspace${loaded === 1 ? "" : "s"}`));
    if (c.waiting) parts.push(el("b", { class: "ua-warn" }, waitingSentence(c.waiting)));
    const services = (where.people ?? []).filter((p) => Array.isArray(p.services) && p.services.includes(name)).length;
    if (services) parts.push(el("span", {}, "a service in ", el("b", {}, String(services)), ` workspace${services === 1 ? "" : "s"}`));
    if (c.forks) parts.push(el("span", {}, el("b", {}, String(c.forks)), ` own ${c.forks === 1 ? "copy" : "copies"}`));
    if (!parts.length) return null;
    return el("div", { class: "ua-pkg-facts-line" }, ...parts.flatMap((p, i) => (i ? [el("span", { class: "ua-sep" }, "·"), p] : [p])));
  }

  function drawHead() {
    clear(head);
    put(
      head,
      el("div", { class: "ua-pkg-crumb" }, el("span", {}, "Control panel"), el("span", { class: "ua-sep" }, "/"), el("span", {}, "Extensions"), el("span", { class: "ua-sep" }, "/"), el("code", {}, name)),
      el(
        "div",
        { class: "ua-pkg-title-row" },
        el(
          "div",
          { class: "ua-pkg-title-col" },
          el("div", { class: "ua-pkg-title" }, el("h2", { class: "ua-pkg-name" }, name), info?.version ? el("span", { class: "ua-pkg-version" }, info.version) : null, ...headBadges()),
          info?.description ? el("p", { class: "ua-pkg-desc" }, info.description) : null,
          facts()
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
    fork.addEventListener("click", () => void act(fork, { verb: "package-fork", args: {}, title: "Make your own copy?", lines: [["as", `@${user ?? "you"}/${name.slice(name.indexOf("/") + 1)}`]], note: "A copy of the files lands in packages/ under your home, ready to edit, and is used instead of this extension for you. Remove your copy to switch back to the official version.", confirmLabel: "Make a copy" }));
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

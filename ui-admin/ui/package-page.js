/* One package's page under Packages: the header (name, version, what it is and where it stands in badges,
 * the description, a facts line on who has it and where it runs), the actions on it, and the tabs:
 * Overview, History, Configuration, Where it runs, Activity, README. The page reads `package-info` and
 * `package-where` once and hands what it read to every tab through `ctx`; a tab that needs more asks
 * for it itself. An action goes behind the shell's confirm popover, toasts the answer, reads the page
 * again and asks the tree to read its children again, so the marks beside the packages follow.
 *
 * Every action and section is tagged with who it is for: `admin` on what needs an admin and acts for
 * everyone (Update, Promote, Remove, History, Where it runs, the checkout, the system layer), `yours`
 * or `anyone` on what any person does for their own workspace (Fork, Reload workspace, their own
 * layer). The page is shown to admins today; the tags are the spec for the day a person opens it. */

import { mountActivity } from "./package-activity.js";
import { mountHistory } from "./package-history.js";
import { mountOverview } from "./package-overview.js";
import { mountReadme } from "./package-readme.js";
import { mountWhere } from "./package-where.js";
import { mountSettings } from "./configuration.js";

const TABS = [
  ["overview", "Overview", null],
  ["history", "History", "admin"],
  ["configuration", "Configuration", null],
  ["where", "Where it runs", "admin"],
  ["activity", "Activity", null],
  ["readme", "README", null],
];

/** The small tag that says who a control or section is for. */
export function tag(ext, kind) {
  const { el } = ext.dom;
  const words = { admin: "admin", yours: "yours", anyone: "anyone" };
  return el("span", { class: `ua-tag is-${kind === "admin" ? "admin" : "yours"}`, title: kind === "admin" ? "Needs an admin; acts for everyone" : "Anyone, for their own workspace" }, words[kind] ?? kind);
}

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
    /** Opens a tab, with a word for it: `{ layer: user }` for Configuration, `{ actor: user }` for Activity. */
    show: (id, want = null) => {
      pending = want;
      showTab(id);
    },
    act,
    tag: (kind) => tag(ext, kind),
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
      if (refused) ext.toast(refused, { tone: "warn" });
      info = about?.data ?? null;
      where = runs?.data ?? null;
      config = shown?.data ? { broken: Boolean(shown.data.broken), summary: shown.data.summary || "" } : null;
    } catch (err) {
      if (!alive) return;
      ext.toast(err.message, { tone: "error" });
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
    const ok = await confirm(anchor, { title, lines: [["package", name], ...lines], note, confirmLabel, tone });
    if (!ok || !alive) return false;
    anchor.disabled = true;
    try {
      const out = await ext.request(verb, { args: { name, ...args } });
      ext.toast(out?.data?.text || out?.text || said || `${title.replace(/\?$/, "")}: done.`, { tone: "good" });
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
      return false;
    } finally {
      if (alive) anchor.disabled = false;
    }
    if (!alive) return true;
    await load();
    refresh?.();
    return true;
  }

  function actions() {
    const out = [];
    const reg = info?.registry;
    if (reg?.update) {
      const b = button(`Update to ${reg.update.version}`, { tone: "primary" });
      b.append(tag(ext, "admin"));
      b.addEventListener("click", () => void act(b, { verb: "package-update", args: {}, title: "Update this package?", lines: [["from", `${info.version} · ${shortHash(reg.update.installed)}`], ["to", `${reg.update.version} · ${shortHash(reg.update.available)}`], ["registry", reg.registry]], note: "The registry's copy replaces this one for everyone who has it; a service it runs restarts.", confirmLabel: "Update" }));
      out.push(b);
    }
    const fork = button("Fork");
    fork.append(tag(ext, "anyone"));
    fork.addEventListener("click", () => void act(fork, { verb: "package-fork", args: {}, title: "Fork this package?", lines: [["as", `@${user ?? "you"}/${name.slice(name.indexOf("/") + 1)}`]], note: "A copy of the files lands in packages/ under your home as your own package, ready to edit. Installing the fork replaces the original for you until the fork is removed.", confirmLabel: "Fork" }));
    out.push(fork);
    if (info && !info.everyone) {
      const promote = button("Promote");
      promote.append(tag(ext, "admin"));
      const owner = where?.people?.find((p) => p.installed)?.user ?? user;
      promote.addEventListener("click", () => void act(promote, { verb: "package-promote", args: { user: owner }, title: "Promote this package?", lines: [["from", `${owner}'s package`], ["to", `@thetis/${name.slice(name.indexOf("/") + 1)} for everyone`]], note: "The files are copied to the system packages, the person's copy is removed, and every workspace gets the promoted one.", confirmLabel: "Promote" }));
      out.push(promote);
    }
    if (user) {
      const reload = button("Reload workspace");
      reload.append(tag(ext, "yours"));
      reload.addEventListener("click", () => void act(reload, { verb: "fence-reload", args: { user }, title: "Reload your workspace?", lines: [["workspace", user]], note: "Your fence closes and opens again on the code on disk. A turn in flight finishes its current tool call first; the services restart.", confirmLabel: "Reload", said: `${user}'s workspace reloaded.` }));
      out.push(reload);
    }
    const remove = button("Remove", { tone: "warn" });
    remove.append(tag(ext, "admin"));
    const everyone = Boolean(info?.everyone);
    remove.addEventListener("click", () => void act(remove, { verb: "package-remove", args: { user: everyone ? "*" : (where?.people?.find((p) => p.installed)?.user ?? user) }, title: everyone ? "Remove this package for everyone?" : "Remove this package?", lines: [["from", everyone ? "every workspace" : `${where?.people?.find((p) => p.installed)?.user ?? user}'s workspace`]], note: "The files stay in place; only the link is removed. Steps and tools it brings stop on the next turn.", confirmLabel: "Remove", tone: "warn" }));
    out.push(remove);
    return out;
  }

  // ---- the header ----

  function headBadges() {
    const out = [badge(info?.type ?? "package", "dim"), info?.everyone ? badge("Everyone", "accent") : badge("Only me", "dim")];
    if (config) out.push(config.broken ? badge(`config: ${config.summary}`, "err") : badge("config whole", "ok"));
    if (info?.forkedFrom) out.push(badge(`fork of ${info.forkedFrom.name} ${info.forkedFrom.version}`, "warn"));
    if (info?.registry?.update) out.push(badge(`update ${info.registry.update.version} on offer`, "warn"));
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
    if (loaded) parts.push(el("span", {}, "loaded in ", el("b", {}, String(loaded)), ` workspace${loaded === 1 ? "" : "s"}`, c.stale ? [", ", el("b", { class: "ua-warn" }, `${c.stale} running older code`)] : null));
    const services = (where.people ?? []).filter((p) => Array.isArray(p.services) && p.services.includes(name)).length;
    if (services) parts.push(el("span", {}, "a service in ", el("b", {}, String(services)), ` workspace${services === 1 ? "" : "s"}`));
    if (c.forks) parts.push(el("span", {}, el("b", {}, String(c.forks)), ` fork${c.forks === 1 ? "" : "s"}`));
    if (!parts.length) return null;
    return el("div", { class: "ua-pkg-facts-line" }, ...parts.flatMap((p, i) => (i ? [el("span", { class: "ua-sep" }, "·"), p] : [p])));
  }

  function drawHead() {
    clear(head);
    put(
      head,
      el("div", { class: "ua-pkg-crumb" }, el("span", {}, "Control panel"), el("span", { class: "ua-sep" }, "/"), el("span", {}, "Packages"), el("span", { class: "ua-sep" }, "/"), el("code", {}, name)),
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
      ),
      // The legend sits under the whole row: inside the actions column it made that column wide and the title narrow.
      el("div", { class: "ua-pkg-legend" }, el("span", {}, tag(ext, "admin"), " needs an admin, acts for everyone"), el("span", {}, tag(ext, "yours"), " anyone, for their own workspace"), el("span", {}, "unmarked: read by anyone"))
    );
    drawTabs();
  }

  function drawTabs() {
    clear(tabs);
    for (const [id, label, who] of TABS) {
      put(tabs, el("button", { type: "button", role: "tab", class: `ua-pkg-tab${id === tab ? " is-on" : ""}`, "aria-selected": id === tab ? "true" : "false", "data-tab": id, onClick: () => showTab(id) }, label, who ? tag(ext, who) : null));
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
      case "history":
        unmountTab = mountHistory(ext, body, { name, ctx });
        break;
      case "configuration":
        unmountTab = mountSettings(ext, body, { child: name, refresh });
        if (want?.layer) chooseLayer(want.layer);
        break;
      case "where":
        unmountTab = mountWhere(ext, body, ctx);
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

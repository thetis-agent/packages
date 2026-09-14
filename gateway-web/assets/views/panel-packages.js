/* Packages: one table of everything known here, deduplicated by name. A package is installed for the
 * person ("Only me" in their scope, "Everyone" as a system package) or available from a registry. The
 * card on the right shows what it brings and the actions the state and the role allow: install for me,
 * install for someone (admin), install for everyone (admin), remove, make it the default for everyone. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { badge, busy, button, card, confirm, field, heading, kv, put, table, tags, when } from "../lib/panel-ui.js";
import { toast } from "../lib/toast.js";

const enc = (name) => encodeURIComponent(name);

export function mountPackages(root, { role, user }) {
  const admin = role !== "user";
  let whose = user;
  let installed = [];
  let index = null;      // { updatedAt, registries, results } or null when there is no marketplace
  let query = "";
  let selected = null;
  let people = [];

  const filter = el("input", { class: "input", type: "search", placeholder: "Filter packages", "aria-label": "Filter packages", onInput: (e) => { query = e.target.value.trim().toLowerCase(); drawList(); } });
  const listEl = el("div", { class: "panel-col" });
  const detailEl = el("div", { class: "panel-col is-side" });
  const picker = admin ? el("select", { class: "input", "aria-label": "Whose packages", onChange: (e) => { whose = e.target.value; selected = null; void load(); } }) : null;
  root.append(el("div", { class: "panel-cols" }, listEl, detailEl));

  const mine = () => whose === user;

  async function load() {
    const stop = busy(listEl, "Reading packages…");
    try {
      if (admin && !people.length) {
        people = (await api("/api/admin/users")).filter((p) => p.role !== "system");
        clear(picker).append(...people.map((p) => el("option", { value: p.id, selected: p.id === whose || null }, p.id === user ? `${p.id} (me)` : p.id)));
      }
      installed = await api(mine() ? "/api/packages" : `/api/admin/packages?user=${enc(whose)}`);
    } catch (err) {
      toast(err.message, { tone: "error" });
      installed = [];
    }
    try {
      index = await api("/api/marketplace");
    } catch (err) {
      index = null;
      if (err.status !== 404) toast(err.message, { tone: "error" });
    }
    stop();
    if (selected && !rows().some((r) => r.name === selected)) selected = null;
    drawList();
    drawDetail();
  }

  /** Installed rows first, then what the registries offer that is not installed; one row per name. */
  function rows() {
    const byName = new Map();
    for (const r of installed) byName.set(r.name, { ...r, state: r.scope, installed: true });
    for (const r of index?.results ?? []) {
      const have = byName.get(r.name);
      if (have) byName.set(r.name, { ...have, registry: r.registry, source: r.source, description: r.description, keywords: r.keywords, available: r.version });
      else byName.set(r.name, { ...r, state: "available", installed: false });
    }
    return [...byName.values()];
  }

  function visible() {
    return rows().filter((r) => !query || r.name.toLowerCase().includes(query) || r.type.toLowerCase().includes(query) || (r.description || "").toLowerCase().includes(query));
  }

  function stateBadge(r) {
    if (r.state === "everyone") return badge("Everyone", "accent");
    if (r.state === "me") return badge(mine() ? "Only me" : `Only ${whose}`, "dim");
    return badge(`Available · ${r.registry}`, "ok");
  }

  function brings(r) {
    const parts = [];
    if (r.steps?.length) parts.push(`${r.steps.length} step${r.steps.length === 1 ? "" : "s"}`);
    if (r.tools?.length) parts.push(`${r.tools.length} tool${r.tools.length === 1 ? "" : "s"}`);
    if (r.service) parts.push("a service");
    return el("span", { class: "text-dim" }, parts.join(", ") || "—");
  }

  function drawList() {
    clear(listEl);
    const all = rows();
    const shown = visible();
    const note = `${installed.length} installed${index ? ` · ${index.total} in the registries · updated ${when(index.updatedAt)}` : ""}`;
    put(
      listEl,
      el("div", { class: "toolbar" }, heading("Packages", note), el("div", { class: "toolbar-gap" }), picker && field("Whose", picker), filter),
      table(
        [
          { key: "name", label: "Package", render: (r) => el("div", {}, el("code", {}, r.name), r.description && el("div", { class: "text-dim small" }, r.description)) },
          { key: "version", label: "Version", render: (r) => el("code", { class: "text-dim" }, r.version) },
          { key: "state", label: "State", render: stateBadge },
          { key: "brings", label: "Brings", render: brings },
        ],
        shown,
        { onRow: (r) => { selected = r.name; drawList(); drawDetail(); }, selectedKey: selected, empty: all.length ? "No package matches the filter." : "Nothing is installed here, and no registry is configured." }
      ),
      addBlock(),
      !index && el("p", { class: "panel-hint" }, "No marketplace index yet. Registries are configured under packages[\"@thetis/marketplace\"].registries; the service refreshes them on a timer.")
    );
  }

  function addBlock() {
    const input = el("input", { class: "input", type: "text", placeholder: mine() ? "packages/<name>, a git URL, or url#dir" : `a path under ${whose}'s home, a git URL, or url#dir`, "aria-label": "Package source", spellcheck: "false" });
    const go = button("Put it in place", { tone: "primary", onClick: () => void add() });
    const block = el("div", { class: "card add-block" }, el("div", { class: "card-head" }, "Add a package from a source"), el("div", { class: "card-body" }, el("div", { class: "row" }, input, go), el("p", { class: "text-faint" }, admin ? "Admins can also name a shipped package, such as @thetis/gateway-web. Building can take a minute." : `The package.json must be scoped @${user}/<name>. Building can take a minute.`)));
    async function add() {
      const source = input.value.trim();
      if (!source) return input.focus();
      const stop = busy(block, "Putting it in place… this can take a minute.");
      go.disabled = true;
      try {
        const row = mine() ? await api("/api/packages", { method: "POST", body: { source } }) : await api("/api/admin/packages", { method: "POST", body: { user: whose, source } });
        toast(`${row.name}@${row.version} is in place. It is live on the next turn.`, { tone: "good" });
        input.value = "";
        selected = row.name;
        await load();
      } catch (err) {
        toast(err.message, { tone: "error" });
      } finally {
        stop();
        go.disabled = false;
      }
    }
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } });
    return block;
  }

  function drawDetail() {
    clear(detailEl);
    const row = rows().find((r) => r.name === selected);
    if (!row) return put(detailEl, el("div", { class: "panel-hint" }, "Select a package to see what it brings and what you can do with it."));
    const actions = [];
    const hints = [];
    if (!row.installed) {
      const forMe = button(mine() ? "Install for me" : `Install for ${whose}`, { tone: "primary", onClick: () => void install(row, whose, forMe) });
      actions.push(forMe);
      hints.push(row.name.startsWith("@thetis/") ? "A shipped package is linked already built. It is live on the next turn." : "The package is cloned from its registry and built in the person's own space. It is live on their next turn.");
    }
    if (admin && row.state !== "everyone" && (row.source || row.name.startsWith("@thetis/"))) {
      const everyone = button("Install for everyone", { tone: "primary", onClick: () => void installEveryone(row, everyone) });
      actions.push(everyone);
      hints.push("Everyone gets it now, and every new person from then on.");
    }
    if (row.installed && row.state === "me" && admin) {
      const promote = button("Make it the default for everyone", { tone: "primary", onClick: () => void promoteRow(row, promote) });
      actions.push(promote);
      hints.push(`Making it the default copies the package under @thetis, adds it for every person, and removes ${mine() ? "your" : `${whose}'s`} own copy.`);
    }
    if (row.installed) {
      const remove = button("Remove", { tone: "warn", onClick: () => void removeRow(row, remove) });
      actions.push(remove);
    }
    put(
      detailEl,
      card(
        el("code", {}, row.name),
        row.description && el("p", {}, row.description),
        kv([
          ["version", el("code", {}, row.version + (row.available && row.available !== row.version ? ` (registry has ${row.available})` : ""))],
          ["type", row.type],
          ["state", stateBadge(row)],
          row.registry && ["registry", row.registry],
          row.source && ["source", el("code", { class: "wrap" }, row.source)],
        ].filter(Boolean)),
        heading("What it brings"),
        kv([
          ["steps", tags((row.steps || []).map((s) => `${s.phase}: ${s.id}`), "dim", "no steps")],
          ["tools", tags(row.tools || [], "ok", "no tools")],
          ["service", row.service ? badge("runs a service", "warn") : el("span", { class: "text-faint" }, "none")],
          row.keywords?.length && ["keywords", tags(row.keywords, "dim")],
        ].filter(Boolean)),
        el("div", { class: "card-actions" }, ...actions)
      ),
      ...hints.map((h) => el("p", { class: "panel-hint" }, h))
    );
  }

  /** A shipped @thetis package installs by name, already built; anything else by its registry source. */
  function sourceOf(row) {
    return row.name.startsWith("@thetis/") ? row.name : row.source;
  }

  async function install(row, who, anchor) {
    const ok = await confirm(anchor, {
      title: who === user ? "Install for you?" : `Install for ${who}?`,
      lines: [["package", `${row.name}@${row.version}`], ["from", row.registry || "a source"], ["for", who === user ? "you only" : who]],
      note: "It is live on the next turn.",
      confirmLabel: "Install",
    });
    if (!ok) return;
    const stop = busy(detailEl, "Installing… this can take a minute.");
    try {
      const r = who === user ? await api("/api/packages", { method: "POST", body: { source: sourceOf(row) } }) : await api("/api/admin/packages", { method: "POST", body: { user: who, source: sourceOf(row) } });
      toast(`${r.name}@${r.version} is in place for ${who === user ? "you" : who}.`, { tone: "good" });
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
  }

  async function installEveryone(row, anchor) {
    const ok = await confirm(anchor, {
      title: "Install for everyone?",
      lines: [["package", `${row.name}@${row.version}`], ["from", row.registry || "a source"], ["for", "everyone, now and later"]],
      note: row.name.startsWith("@thetis/") ? "Every person gets it on their next turn, and every new person is set up with it." : "It is installed for you and then made the default under @thetis for everyone.",
      confirmLabel: "Install for everyone",
    });
    if (!ok) return;
    const stop = busy(detailEl, "Installing for everyone… this can take a minute.");
    try {
      const r = await api("/api/admin/packages/everyone", { method: "POST", body: { source: sourceOf(row) } });
      toast(`${r.name} is installed for everyone (${r.userspaces.length} ${r.userspaces.length === 1 ? "person" : "people"}).`, { tone: "good" });
      selected = r.name;
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
  }

  async function removeRow(row, anchor) {
    const ok = await confirm(anchor, {
      title: "Remove this package?",
      lines: [["package", row.name], ["from", mine() ? "your own setup" : `${whose}'s setup`]],
      note: row.state === "everyone" ? "This is a system package. Steps and tools it brings stop on the next turn; an admin can add it back." : "Its files stay in place; only the link is removed. Steps and tools it brings stop on the next turn.",
      confirmLabel: "Remove",
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(detailEl, "Removing…");
    try {
      await api(mine() ? `/api/packages/${enc(row.name)}` : `/api/admin/packages/${enc(row.name)}?user=${enc(whose)}`, { method: "DELETE" });
      toast(`${row.name} was removed.`, { tone: "good" });
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
  }

  async function promoteRow(row, anchor) {
    const base = row.name.slice(row.name.indexOf("/") + 1);
    const ok = await confirm(anchor, {
      title: "Make it the default for everyone?",
      lines: [["package", row.name], ["becomes", `@thetis/${base}`], ["for", "everyone, now and later"]],
      note: `Everyone gets @thetis/${base} on their next turn. ${mine() ? "Your" : `${whose}'s`} own copy ${row.name} is removed.`,
      confirmLabel: "Make it the default",
    });
    if (!ok) return;
    const stop = busy(detailEl, "Making it the default…");
    try {
      const r = await api(`/api/admin/packages/${enc(row.name)}/promote`, { method: "POST", body: { user: whose } });
      toast(`${r.name} is now the default for everyone (${r.userspaces.length} ${r.userspaces.length === 1 ? "person" : "people"}).`, { tone: "good" });
      selected = r.name;
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
  }

  void load();
}

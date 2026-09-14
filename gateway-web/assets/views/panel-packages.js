/* Packages: what is added for a person and what each one brings. "Only me" is a package in that person's
 * scope; "Everyone" is a system package. Adding takes a path under home, a git URL, `url#dir`, or for
 * admins a `@thetis/<name>`. Removing and making default confirm first. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { badge, busy, button, card, confirm, field, heading, kv, put, table, tags } from "../lib/panel-ui.js";
import { toast } from "../lib/toast.js";

const enc = (name) => encodeURIComponent(name);

export function mountPackages(root, { role, user }) {
  const admin = role !== "user";
  let whose = user;
  let rows = [];
  let query = "";
  let selected = null;
  let people = [];

  const filter = el("input", { class: "input", type: "search", placeholder: "Filter packages", "aria-label": "Filter packages", onInput: (e) => { query = e.target.value.trim().toLowerCase(); drawList(); } });
  const listEl = el("div", { class: "panel-col" });
  const detailEl = el("div", { class: "panel-col is-side" });
  const picker = admin ? el("select", { class: "input", "aria-label": "Whose packages", onChange: (e) => { whose = e.target.value; selected = null; void load(); } }) : null;

  root.append(el("div", { class: "panel-cols" }, listEl, detailEl));

  const mine = () => whose === user;
  const listPath = () => (mine() ? "/api/packages" : `/api/admin/packages?user=${enc(whose)}`);

  async function load() {
    const stop = busy(listEl, "Reading packages…");
    try {
      if (admin && !people.length) {
        people = await api("/api/admin/users");
        clear(picker).append(...people.filter((p) => p.id !== "_system").map((p) => el("option", { value: p.id, selected: p.id === whose || null }, p.id === user ? `${p.id} (me)` : p.id)));
      }
      rows = await api(listPath());
    } catch (err) {
      toast(err.message, { tone: "error" });
      rows = [];
    } finally {
      stop();
    }
    if (selected && !rows.some((r) => r.name === selected)) selected = null;
    drawList();
    drawDetail();
  }

  function visible() {
    return rows.filter((r) => !query || r.name.toLowerCase().includes(query) || r.type.toLowerCase().includes(query));
  }

  function drawList() {
    clear(listEl);
    const shown = visible();
    put(listEl, 
      el("div", { class: "toolbar" }, heading("Added here", `${rows.length} package${rows.length === 1 ? "" : "s"}`), el("div", { class: "toolbar-gap" }), picker && field("Whose", picker), filter),
      table(
        [
          { key: "name", label: "Package", render: (r) => el("code", {}, r.name) },
          { key: "version", label: "Version", render: (r) => el("code", { class: "text-dim" }, r.version) },
          { key: "scope", label: "Runs for", render: (r) => badge(r.scope === "everyone" ? "Everyone" : "Only me", r.scope === "everyone" ? "accent" : "dim") },
          { key: "brings", label: "Brings", render: (r) => brings(r) },
        ],
        shown,
        { onRow: (r) => { selected = r.name; drawList(); drawDetail(); }, selectedKey: selected, empty: rows.length ? "No package matches the filter." : "Nothing is installed here yet." }
      ),
      addBlock()
    );
  }

  function brings(r) {
    const parts = [];
    if (r.steps.length) parts.push(`${r.steps.length} step${r.steps.length === 1 ? "" : "s"}`);
    if (r.tools.length) parts.push(`${r.tools.length} tool${r.tools.length === 1 ? "" : "s"}`);
    if (r.service) parts.push("a service");
    return el("span", { class: "text-dim" }, parts.join(", ") || "—");
  }

  function addBlock() {
    const input = el("input", { class: "input", type: "text", placeholder: mine() ? "packages/<name>, a git URL, or url#dir" : `a path under ${whose}'s home, a git URL, or url#dir`, "aria-label": "Package source", spellcheck: "false" });
    const go = button("Put it in place", { tone: "primary", onClick: () => void add() });
    const block = el("div", { class: "card add-block" }, el("div", { class: "card-head" }, "Add a package"), el("div", { class: "card-body" }, el("div", { class: "row" }, input, go), el("p", { class: "text-faint" }, admin ? "Admins can also name a system package, such as @thetis/gateway-web. Building can take a minute." : "The package.json must be scoped @" + user + "/<name>. Building can take a minute.")));
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
    const row = rows.find((r) => r.name === selected);
    if (!row) return put(detailEl, el("div", { class: "panel-hint" }, "Select a package to see what it brings."));
    const removeBtn = button("Remove", { tone: "warn", onClick: () => void remove(row, removeBtn) });
    const promoteBtn = admin && row.scope === "me" ? button("Make it the default for everyone", { tone: "primary", onClick: () => void promote(row, promoteBtn) }) : null;
    put(detailEl, 
      card(
        el("code", {}, row.name),
        kv([
          ["version", el("code", {}, row.version)],
          ["type", row.type],
          ["runs for", badge(row.scope === "everyone" ? "Everyone" : "Only me", row.scope === "everyone" ? "accent" : "dim")],
        ]),
        heading("What it brings"),
        kv([
          ["steps", tags(row.steps.map((s) => `${s.phase}: ${s.id}`), "dim", "no steps")],
          ["tools", tags(row.tools, "ok", "no tools")],
          ["service", row.service ? badge("runs a service", "warn") : el("span", { class: "text-faint" }, "none")],
        ]),
        el("div", { class: "card-actions" }, promoteBtn, removeBtn)
      ),
      promoteBtn && el("p", { class: "panel-hint" }, "Making it the default copies the package under @thetis, adds it for every person, and removes the owner's own copy.")
    );
  }

  async function remove(row, anchor) {
    const ok = await confirm(anchor, {
      title: "Remove this package?",
      lines: [["package", row.name], ["from", mine() ? "your own setup" : `${whose}'s setup`]],
      note: row.scope === "everyone" ? "This is a system package. Steps and tools it brings stop on the next turn; an admin can add it back." : "Its files stay in place; only the link is removed. Steps and tools it brings stop on the next turn.",
      confirmLabel: "Remove",
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(detailEl, "Removing…");
    try {
      await api(mine() ? `/api/packages/${enc(row.name)}` : `/api/admin/packages/${enc(row.name)}?user=${enc(whose)}`, { method: "DELETE" });
      toast(`${row.name} was removed.`, { tone: "good" });
      selected = null;
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
  }

  async function promote(row, anchor) {
    const base = row.name.slice(row.name.indexOf("/") + 1);
    const ok = await confirm(anchor, {
      title: "Make it the default for everyone?",
      lines: [["package", row.name], ["becomes", `@thetis/${base}`], ["for", "everyone, now and later"]],
      note: `Everyone gets @thetis/${base} on their next turn. ${whose === user ? "Your" : `${whose}'s`} own copy ${row.name} is removed.`,
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

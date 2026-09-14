/* Marketplace: what the registries offer. Search is over the index the marketplace service wrote;
 * installing sends the package's `url#dir` source through the same route as a typed source. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { badge, busy, button, card, confirm, field, heading, kv, put, table, tags, when } from "../lib/panel-ui.js";
import { toast } from "../lib/toast.js";

export function mountMarketplace(root, { role, user }) {
  const admin = role !== "user";
  let query = "";
  let results = [];
  let meta = null;
  let missing = null;
  let selected = null;
  let people = [];
  let timer = null;

  const search = el("input", { class: "input", type: "search", placeholder: "Search packages", "aria-label": "Search the marketplace", onInput: (e) => { query = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(() => void load(), 200); } });
  const listEl = el("div", { class: "panel-col" });
  const detailEl = el("div", { class: "panel-col is-side" });
  root.append(el("div", { class: "panel-cols" }, listEl, detailEl));

  async function load() {
    try {
      const r = await api(`/api/marketplace?q=${encodeURIComponent(query)}`);
      results = r.results;
      meta = { updatedAt: r.updatedAt, registries: r.registries, total: r.total };
      missing = null;
    } catch (err) {
      results = [];
      meta = null;
      missing = err.status === 404 ? err.message : null;
      if (err.status !== 404) toast(err.message, { tone: "error" });
    }
    if (selected && !results.some((r) => r.name === selected)) selected = null;
    drawList();
    drawDetail();
  }

  function drawList() {
    clear(listEl);
    if (missing) {
      put(listEl, card("No marketplace yet", el("p", {}, missing), el("p", { class: "text-faint" }, "The registries are configured under packages[\"@thetis/marketplace\"].registries. Each one is a git repository of package directories. The marketplace service refreshes them on a timer.")));
      return;
    }
    const failed = (meta?.registries ?? []).filter((r) => r.error);
    put(listEl, 
      el("div", { class: "toolbar" }, heading("Available", meta ? `${meta.total} package${meta.total === 1 ? "" : "s"} · updated ${when(meta.updatedAt)}` : ""), el("div", { class: "toolbar-gap" }), search),
      failed.length ? el("p", { class: "notice is-warn" }, `Could not refresh ${failed.map((r) => r.name).join(", ")}: ${failed[0].error}`) : null,
      table(
        [
          { key: "name", label: "Package", render: (r) => el("div", {}, el("code", {}, r.name), r.description && el("div", { class: "text-dim small" }, r.description)) },
          { key: "version", label: "Version", render: (r) => el("code", { class: "text-dim" }, r.version) },
          { key: "type", label: "Type" },
          { key: "registry", label: "Registry" },
        ],
        results,
        { onRow: (r) => { selected = r.name; drawList(); drawDetail(); }, selectedKey: selected, empty: query ? "No package matches." : (meta?.registries?.length ? "The registries hold no packages yet." : "No registries are configured.") }
      )
    );
    search.focus({ preventScroll: true });
  }

  function drawDetail() {
    clear(detailEl);
    const row = results.find((r) => r.name === selected);
    if (!row) return put(detailEl, el("div", { class: "panel-hint" }, "Select a package to read about it and install it."));
    const forMe = button("Install for me", { tone: "primary", onClick: () => void install(row, user, forMe) });
    let forOther = null;
    let pick = null;
    if (admin) {
      pick = el("select", { class: "input", "aria-label": "Install for" });
      forOther = button("Install for…", { onClick: () => void install(row, pick.value, forOther) });
      void peopleInto(pick);
    }
    put(detailEl, 
      card(
        el("code", {}, row.name),
        row.description && el("p", {}, row.description),
        kv([
          ["version", el("code", {}, row.version)],
          ["type", row.type],
          ["registry", row.registry],
          ["source", el("code", { class: "wrap" }, row.source)],
        ]),
        heading("What it brings"),
        kv([
          ["steps", tags(row.steps.map((s) => `${s.phase}: ${s.id}`), "dim", "no steps")],
          ["tools", tags(row.tools, "ok", "no tools")],
          ["service", row.service ? badge("runs a service", "warn") : el("span", { class: "text-faint" }, "none")],
          ["keywords", tags(row.keywords, "dim", "none")],
        ]),
        el("div", { class: "card-actions" }, forMe, pick && el("div", { class: "row" }, pick, forOther))
      ),
      el("p", { class: "panel-hint" }, row.name.startsWith("@thetis/") ? "A @thetis package installs by name from the packages this installation ships, already built. Admins only." : `The package is cloned from its registry and built in the person's own space. ${row.name.split("/")[0]}/* must be theirs.`)
    );
  }

  async function peopleInto(select) {
    try {
      if (!people.length) people = await api("/api/admin/users");
      clear(select).append(...people.filter((p) => p.id !== "_system").map((p) => el("option", { value: p.id }, p.id === user ? `${p.id} (me)` : p.id)));
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  async function install(row, who, anchor) {
    const ok = await confirm(anchor, {
      title: who === user ? "Install for you?" : `Install for ${who}?`,
      lines: [["package", `${row.name}@${row.version}`], ["from", row.registry], ["for", who === user ? "you only" : who]],
      note: "The package is cloned and built in that person's own space. It is live on their next turn.",
      confirmLabel: "Install",
    });
    if (!ok) return;
    const stop = busy(detailEl, "Installing… this can take a minute.");
    try {
      // A @thetis package that ships with this installation is already built; it installs by name. Anything else is cloned and built.
      const source = row.name.startsWith("@thetis/") ? row.name : row.source;
      const r = who === user ? await api("/api/packages", { method: "POST", body: { source } }) : await api("/api/admin/packages", { method: "POST", body: { user: who, source } });
      toast(`${r.name}@${r.version} is in place for ${who === user ? "you" : who}.`, { tone: "good" });
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
  }



  void load();
  return () => clearTimeout(timer);
}

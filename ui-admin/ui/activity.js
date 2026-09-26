/* Activity: the kernel's journal, newest first. Operator acts, mounts, turns, and services, each with who
 * did it and to whom. Read by field name; a row's data is shown as it was recorded. A user gets only the
 * rows where they are the actor or the target -- the kernel narrows them, not this page -- so the Who and
 * To columns are kept (an admin's act on you names the admin) and the heading says whose rows these are. */

const KINDS = ["", "user.create", "user.remove", "user.role", "user.status", "user.password", "mounts", "ssh", "package.install", "package.uninstall", "package.promote", "package.everyone", "update.start", "update.done", "update.fail", "turn.start", "turn.end", "service.start", "service.stop", "service.fail"];
const LIMIT = 300;

export function mountActivity(ext, root, who = {}) {
  const mine = who.role === "user";
  const { el, clear } = ext.dom;
  const { badge, busy, heading, put, table, when } = ext.ui;
  let rows = [];
  let kind = "";
  const wrap = el("div", { class: "panel-col ua-activity" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  const pick = el("select", { class: "input", "aria-label": "Kind", onChange: (e) => { kind = e.target.value; void load(); } }, ...KINDS.map((k) => el("option", { value: k }, k || "everything")));
  const reload = el("button", { type: "button", class: "btn is-quiet", onClick: () => void load() }, "Reload");

  async function load() {
    const stop = busy(wrap, "Reading the journal…");
    try {
      const out = await ext.request("journal", { args: { limit: LIMIT, kind: kind || undefined } });
      rows = Array.isArray(out.data) ? out.data : [];
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
      rows = [];
    } finally {
      stop();
    }
    draw();
  }

  function tone(k) {
    if (k.endsWith(".fail") || k === "user.remove" || k === "package.uninstall") return "warn";
    if (k === "package.promote" || k === "user.create" || k === "package.install" || k === "mounts" || k === "ssh") return "accent";
    return "dim";
  }

  function detail(row) {
    const d = row.data || {};
    const parts = [];
    if (d.name) parts.push(row.kind === "host.call" && d.method ? `${d.name}.${d.method}` : String(d.name));
    if (d.promoted) parts.push(`→ ${d.promoted}`);
    if (d.package) parts.push(String(d.package));
    if (d.role) parts.push(`role ${d.role}`);
    if (d.status) parts.push(`status ${d.status}`);
    if (Array.isArray(d.mounts)) parts.push(d.mounts.length ? d.mounts.map((m) => `${m.path} (${m.mode})`).join(", ") : "no mounts");
    if (Array.isArray(d.ssh)) parts.push(d.ssh.length ? d.ssh.map((k) => String(k).split("/").filter(Boolean).at(-1)).join(", ") : "no keys");
    if (d.turn) parts.push(String(d.turn));
    if (typeof d.ms === "number") parts.push(`${(d.ms / 1000).toFixed(1)} s`);
    if (d.error) parts.push(`error: ${d.error.message || d.error}`);
    if (d.reported && typeof d.reported.cost === "number") parts.push(`$${d.reported.cost.toFixed(4)}`);
    return parts.join(" · ");
  }

  function draw() {
    clear(wrap);
    put(
      wrap,
      el("div", { class: "toolbar" }, heading(mine ? "What was done by you or to you" : "Activity", `${rows.length} newest rows`), el("div", { class: "toolbar-gap" }), pick, reload),
      table(
        [
          { key: "at", label: "When", render: (r) => el("span", { class: "text-dim", title: r.at }, when(r.at)) },
          { key: "kind", label: "What", render: (r) => badge(r.kind, tone(r.kind)) },
          { key: "actor", label: "Who", render: (r) => el("code", {}, r.actor || "kernel") },
          { key: "target", label: "To", render: (r) => el("code", {}, r.target || "") },
          { key: "data", label: "Details", render: (r) => el("span", { class: "text-dim small" }, detail(r)) },
        ],
        rows,
        { rowKey: (r) => r.at + r.kind + (r.target || ""), empty: mine ? "Nothing recorded about you yet." : "Nothing recorded yet." }
      )
    );
  }

  void load();
}

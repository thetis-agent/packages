/* Mounts: which host directories are bound into whose fence, at their host path, read-write or read-only.
 * One table of every person's mounts, and a form that adds one. Every change sends that person's whole
 * list through `mounts-set`, as the command line does; the kernel closes the person's fence, which
 * reopens with the new binds and restarts their services, so the page says that before it sends. */

export function mountMounts(ext, root) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, confirm, field, heading, put, table } = ext.ui;
  let people = [];
  let byUser = {}; // user -> [{ path, mode }]
  const wrap = el("div", { class: "panel-col ua-mounts" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  const rows = () => Object.entries(byUser).flatMap(([user, list]) => (list ?? []).map((m) => ({ user, ...m })));

  async function load() {
    const stop = busy(wrap, "Reading the mounts…");
    try {
      const [users, mounts] = await Promise.all([ext.request("users"), ext.request("mounts-list")]);
      people = (Array.isArray(users.data) ? users.data : []).filter((p) => p.role !== "system");
      byUser = mounts.data && typeof mounts.data === "object" ? mounts.data : {};
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    draw();
  }

  /** Sends one person's whole list. The sentence names what reopens. */
  async function set(user, mounts, done) {
    try {
      await ext.request("mounts-set", { args: { user, mounts } });
      ext.toast(done, { tone: "good" });
      await load();
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    }
  }

  async function remove(anchor, row) {
    const ok = await confirm(anchor, { title: "Unbind this directory?", lines: [["person", row.user], ["path", row.path], ["mode", row.mode]], note: `${row.user}'s fence reopens without it; their services restart.`, confirmLabel: "Unbind", tone: "warn" });
    if (!ok) return;
    await set(row.user, (byUser[row.user] ?? []).filter((m) => m.path !== row.path), `${row.path} was unbound for ${row.user}.`);
  }

  function addBlock() {
    const who = el("select", { class: "input", "aria-label": "Person" }, ...people.map((p) => el("option", { value: p.id }, p.id)));
    const path = el("input", { class: "input ua-path", type: "text", placeholder: "/srv/repos/project", "aria-label": "Host path", autocomplete: "off", spellcheck: "false" });
    const mode = el("select", { class: "input", "aria-label": "Mode" }, el("option", { value: "rw" }, "read-write"), el("option", { value: "ro" }, "read-only"));
    const go = button("Bind directory", { tone: "primary", onClick: () => void add() });
    async function add() {
      const user = who.value;
      const value = path.value.trim();
      if (!user) return ext.toast("Add a person first.", { tone: "error" });
      if (!value.startsWith("/") || value === "/" || value.includes("/../") || value.endsWith("/..") || (value.length > 1 && value.endsWith("/"))) return ext.toast("A path is absolute and normalized, and not / itself.", { tone: "error" }), path.focus();
      const ok = await confirm(go, { title: "Bind this directory?", lines: [["person", user], ["path", value], ["mode", mode.value]], note: `${user}'s fence reopens with it; their services restart. The agent then reads${mode.value === "rw" ? " and writes" : ""} there.`, confirmLabel: "Bind" });
      if (!ok) return;
      go.disabled = true;
      try {
        await set(user, [...(byUser[user] ?? []).filter((m) => m.path !== value), { path: value, mode: mode.value }], `${value} was bound for ${user}.`);
        path.value = "";
      } finally {
        go.disabled = false;
      }
    }
    return el(
      "div",
      { class: "card add-block ua-add" },
      el("div", { class: "card-head" }, "Bind a host directory"),
      el("div", { class: "card-body" }, el("div", { class: "row wrap" }, field("Person", who), field("Host path", path), field("Mode", mode), go), el("p", { class: "text-faint" }, "The directory appears inside the person's fence at the same path. A mount is a hole in the fence: the kernel does not check what the directory holds. A path already bound gets the new mode."))
    );
  }

  function draw() {
    clear(wrap);
    const list = rows();
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Mounts", `${list.length} ${list.length === 1 ? "mount" : "mounts"}`)),
      table(
        [
          { key: "user", label: "Person", render: (r) => el("code", {}, r.user) },
          { key: "path", label: "Host path", render: (r) => el("code", { class: "ua-wrap" }, r.path) },
          { key: "mode", label: "Mode", render: (r) => badge(r.mode === "rw" ? "read-write" : "read-only", r.mode === "rw" ? "warn" : "dim") },
          { key: "actions", label: "", render: (r) => { const b = button("Unbind", { tone: "warn", onClick: () => void remove(b, r) }); return b; } },
        ],
        list,
        { rowKey: (r) => `${r.user} ${r.path}`, empty: "No host directory is bound into anyone's fence." }
      ),
      addBlock(),
      el("p", { class: "panel-hint" }, "A change closes that person's fence. It reopens with the new binds on their next request, and their services restart. Changing your own mounts reopens this page.")
    );
  }

  void load();
}

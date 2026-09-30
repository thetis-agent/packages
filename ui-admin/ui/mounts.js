/* Mounts, the first tab of Access: which host directories are bound into whose workspace, at their host
 * path, read-write or read-only. A user sees only their own, read-only, each in one sentence that says
 * whether it is really there ("your space" in their words). An admin sees one table of every person's
 * mounts, and a form that adds one. Every change sends that person's whole list through `mounts-set`, as the
 * command line does; the kernel closes the person's workspace, which reopens with the new binds and restarts
 * their services, so the page says that before it sends.
 *
 * A row says whether the host still has a directory at the path, because the workspace skips a mount whose
 * path is gone and opens without it: a bind that is only written down looks the same as one that works
 * until the table says which. The path is picked, not typed, for the same reason — the picker cannot
 * offer a directory that is not there. A list that could not be read says so, with what fixes it: it is
 * never drawn as "0 mounts". */

import { failedCard, isLost, toastError } from "./failed.js";
import { agentName } from "./state.js";

/**
 * One mount of your own, said in one sentence from what the server found at the path (`present`, `kind`
 * from host-grants' withPresence), never guessed here. `broken` is true when the fence opened without it;
 * a kernel older than those fields says so rather than claiming either.
 */
export function mountSentence(m) {
  const how = m.mode === "rw" ? "read-write" : "read-only";
  if (m.present === undefined) return { tone: "dim", broken: false, text: `Written down ${how}; this installation does not say whether the host has it.` };
  if (m.present) return { tone: "ok", broken: false, text: `Bound ${how}, at the same path.` };
  if (m.kind === "file") return { tone: "err", broken: true, text: "Not bound: the host has a file at this path, not a directory, so your space opened without it." };
  return { tone: "err", broken: true, text: "Not bound: the host has no directory at this path, so your space opened without it." };
}

/** The command an admin runs on the host to drop a mount that is not there, in the CLI's own words. */
export const removeCommand = (user, path) => `thetis mounts remove ${user} ${path}`;

/**
 * A user's own mounts, read-only: a person cannot bind a host directory, only see what an admin bound and
 * whether it is really in their workspace. The rows come from `mounts-list`, which the kernel answers for
 * the caller alone.
 */
function mountOwnMounts(ext, root, me) {
  const { el, clear } = ext.dom;
  const { badge, busy, heading, put, table } = ext.ui;
  let list = [];
  let failed = null;
  const wrap = el("div", { class: "panel-col ua-own-mounts" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  async function load() {
    const stop = busy(wrap, "Reading your mounts…");
    try {
      const out = await ext.request("mounts-list", { args: { user: me } });
      list = Array.isArray(out.data?.[me]) ? out.data[me] : [];
      failed = null;
    } catch (err) {
      failed = err;
    } finally {
      stop();
    }
    draw();
  }

  function draw() {
    clear(wrap);
    if (failed) return void put(wrap, heading("Your mounts"), failedCard(ext, "Your mounts", failed, { admin: false, retry: () => void load() }));
    const said = list.map((m) => ({ ...m, said: mountSentence(m) }));
    const broken = said.filter((m) => m.said.broken);
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Your mounts", `${list.length} ${list.length === 1 ? "mount" : "mounts"}`)),
      broken.length ? el("p", { class: "ua-broken" }, `${broken.length === 1 ? "One mount is" : `${broken.length} mounts are`} not in your space: ${broken.length === 1 ? "it was" : "they were"} granted, but the host has no directory there.`) : null,
      table(
        [
          { key: "path", label: "Host path", render: (m) => el("code", { class: "ua-wrap" }, m.path) },
          { key: "mode", label: "Mode", render: (m) => badge(m.mode === "rw" ? "read-write" : "read-only", m.mode === "rw" ? "warn" : "dim") },
          { key: "state", label: "In your space", render: (m) => el("span", { class: m.said.broken ? "ua-refused" : "text-dim" }, m.said.text) },
        ],
        said,
        { rowKey: (m) => m.path, empty: "Nothing from the host is bound into your space." }
      ),
      broken.length ? el("div", { class: "panel-hint" }, el("p", {}, "An admin can change this under Access, or put the directory back on the host. On the host, an admin drops a mount that is not there with:"), el("pre", { class: "ua-pre" }, broken.map((m) => removeCommand(me, m.path)).join("\n"))) : null,
      el("p", { class: "panel-hint" }, "A mount is a host directory bound into your space at the same path. Only an admin binds one; it appears the next time your space opens.")
    );
  }

  void load();
}

export function mountMounts(ext, root, who = {}) {
  if (who.role === "user") return mountOwnMounts(ext, root, who.user);
  const { el, clear } = ext.dom;
  const { badge, busy, button, confirm, field, heading, pickDirectory, put, table } = ext.ui;
  let people = [];
  let byUser = {}; // user -> [{ path, mode }]
  let failed = null;
  const wrap = el("div", { class: "panel-col ua-mounts" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  const rows = () => Object.entries(byUser).flatMap(([user, list]) => (list ?? []).map((m) => ({ user, ...m })));

  async function load() {
    const stop = busy(wrap, "Reading the mounts…");
    try {
      const [users, mounts] = await Promise.all([ext.request("users"), ext.request("mounts-list")]);
      people = (Array.isArray(users.data) ? users.data : []).filter((p) => p.role !== "system");
      byUser = mounts.data && typeof mounts.data === "object" ? mounts.data : {};
      failed = null;
    } catch (err) {
      failed = err;
    } finally {
      stop();
    }
    draw();
  }

  /**
   * Sends one person's whole list. The sentence names what reopens. Setting your own mounts closes the
   * workspace this page is served from, so the request can be lost: the page waits for the new one to answer
   * rather than calling that a failure. A refusal from a gateway still there is a refusal, said plainly.
   */
  async function set(user, mounts, done) {
    try {
      const out = await ext.request("mounts-set", { args: { user, mounts } });
      const written = (out?.data ?? []).filter((m) => m.present === false).map((m) => m.path);
      ext.toast(written.length ? `${done} The host has no directory at ${written.join(", ")}, so the workspace opens without it.` : done, { tone: written.length ? "warn" : "good" });
    } catch (err) {
      if (!isLost(err)) {
        toastError(ext, err, "The mounts were not changed");
        return void (await load());
      }
      ext.toast(`${done} Waiting for the workspace to answer again…`, { tone: "good" });
      await settle();
    }
    await load();
  }

  /** Waits for the gateway to answer after its own workspace was closed: the gateway's helper, or up to half a minute of polling. */
  async function settle(deadline = Date.now() + 30_000) {
    if (typeof ext.awaitReturn === "function") return void (await ext.awaitReturn({ timeoutMs: 30_000 }));
    for (;;) {
      try {
        await ext.request("mounts-list");
        return;
      } catch {
        if (Date.now() >= deadline) return;
        await new Promise((done) => setTimeout(done, 700));
      }
    }
  }

  async function remove(anchor, row) {
    const ok = await confirm(anchor, { title: "Unbind this directory?", lines: [["person", row.user], ["path", row.path], ["mode", row.mode]], note: `${row.user}'s workspace reopens without it; their services restart.`, confirmLabel: "Unbind", tone: "warn" });
    if (!ok) return;
    await set(row.user, (byUser[row.user] ?? []).filter((m) => m.path !== row.path), `${row.path} was unbound for ${row.user}.`);
  }

  function addBlock() {
    const who = el("select", { class: "input", "aria-label": "Person" }, ...people.map((p) => el("option", { value: p.id }, p.id)));
    const path = el("input", { class: "input ua-path", type: "text", placeholder: "/srv/repos/project", "aria-label": "Host path", autocomplete: "off", spellcheck: "false" });
    const mode = el("select", { class: "input", "aria-label": "Mode" }, el("option", { value: "rw" }, "read-write"), el("option", { value: "ro" }, "read-only"));
    const go = button("Bind directory", { tone: "primary", onClick: () => void add() });
    const browse = button("Choose…", {
      onClick: async () => {
        const chosen = await pickDirectory(browse, {
          title: "Choose a host directory",
          start: path.value.trim().startsWith("/") ? path.value.trim() : "/",
          browse: async (at) => (await ext.request("mounts-browse", { args: { path: at } }))?.data ?? null,
          note: "Only a directory the host really has can be chosen.",
        });
        if (chosen) {
          path.value = chosen;
          path.focus();
        }
      },
    });
    async function add() {
      const user = who.value;
      const value = path.value.trim();
      if (!user) return ext.toast("Add a person first.", { tone: "error" });
      if (!value.startsWith("/") || value === "/" || value.includes("/../") || value.endsWith("/..") || (value.length > 1 && value.endsWith("/"))) return ext.toast("A path is absolute and normalized, and not / itself.", { tone: "error" }), path.focus();
      const ok = await confirm(go, { title: "Bind this directory?", lines: [["person", user], ["path", value], ["mode", mode.value]], note: `${user}'s workspace reopens with it; their services restart. The agent then reads${mode.value === "rw" ? " and writes" : ""} there.`, confirmLabel: "Bind" });
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
      el("div", { class: "card-body" }, el("div", { class: "row wrap" }, field("Person", who), field("Host path", path), browse, field("Mode", mode), go), el("p", { class: "text-faint" }, `The directory appears inside the person's workspace at the same path. A mount is a hole in the sandbox: ${agentName()} does not check what the directory holds. A path already bound gets the new mode. A path the host does not have is written down and skipped when the workspace opens, so bind one that is there.`))
    );
  }

  function draw() {
    clear(wrap);
    if (failed) return void put(wrap, heading("Mounts"), failedCard(ext, "Mounts", failed, { admin: true, retry: () => void load() }));
    const list = rows();
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Mounts", `${list.length} ${list.length === 1 ? "mount" : "mounts"}`)),
      table(
        [
          { key: "user", label: "Person", render: (r) => el("code", {}, r.user) },
          { key: "path", label: "Host path", render: (r) => el("code", { class: "ua-wrap" }, r.path) },
          { key: "mode", label: "Mode", render: (r) => badge(r.mode === "rw" ? "read-write" : "read-only", r.mode === "rw" ? "warn" : "dim") },
          // A kernel older than these fields says nothing about the path, and so does the row.
          { key: "state", label: "On the host", render: (r) => (r.present === undefined ? badge("not known", "dim") : r.present ? badge("bound", "ok") : badge(r.kind === "file" ? "skipped · a file" : "skipped · not there", "err")) },
          { key: "actions", label: "", render: (r) => { const b = button("Unbind", { tone: "warn", onClick: () => void remove(b, r) }); return b; } },
        ],
        list,
        { rowKey: (r) => `${r.user} ${r.path}`, empty: "No host directory is bound into anyone's workspace." }
      ),
      addBlock(),
      el("p", { class: "panel-hint" }, "A change closes that person's workspace. It reopens with the new binds on their next request, and their services restart. Changing your own mounts reopens this page. A mount marked skipped is written down and not in the workspace: the host has no directory at that path.")
    );
  }

  void load();
}

/* People: who can sign in and what they may do. Admin only. Your own account is not offered here. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { badge, busy, button, card, confirm, field, heading, kv, put, table, when } from "../lib/panel-ui.js";
import { toast } from "../lib/toast.js";

export function mountPeople(root, { user }) {
  let people = [];
  let selected = null;
  const listEl = el("div", { class: "panel-col" });
  const detailEl = el("div", { class: "panel-col is-side" });
  root.append(el("div", { class: "panel-cols" }, listEl, detailEl));

  async function load() {
    const stop = busy(listEl, "Reading people…");
    try {
      people = (await api("/api/admin/users")).filter((p) => p.role !== "system");
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    if (selected && !people.some((p) => p.id === selected)) selected = null;
    drawList();
    drawDetail();
  }

  function drawList() {
    clear(listEl);
    put(listEl, 
      el("div", { class: "toolbar" }, heading("People", `${people.length} ${people.length === 1 ? "person" : "people"}`)),
      table(
        [
          { key: "id", label: "Person", render: (p) => el("span", {}, el("code", {}, p.id), p.id === user ? el("span", { class: "text-faint" }, " (me)") : null) },
          { key: "role", label: "Role", render: (p) => badge(p.role, p.role === "admin" ? "accent" : "dim") },
          { key: "status", label: "Status", render: (p) => badge(p.status, p.status === "active" ? "ok" : "warn") },
          { key: "createdAt", label: "Since", render: (p) => el("span", { class: "text-dim" }, when(p.createdAt)) },
        ],
        people,
        { onRow: (p) => { selected = p.id; drawList(); drawDetail(); }, selectedKey: selected, rowKey: (p) => p.id }
      ),
      addBlock()
    );
  }

  function addBlock() {
    const id = el("input", { class: "input", type: "text", placeholder: "id, e.g. alice", "aria-label": "Id", autocomplete: "off", spellcheck: "false", pattern: "[a-z][a-z0-9-]{0,31}" });
    const role = el("select", { class: "input", "aria-label": "Role" }, el("option", { value: "user" }, "user"), el("option", { value: "admin" }, "admin"));
    const password = el("input", { class: "input", type: "password", placeholder: "password (8+ characters)", "aria-label": "Password", autocomplete: "new-password" });
    const go = button("Add person", { tone: "primary", onClick: () => void add() });
    const block = el("div", { class: "card add-block" }, el("div", { class: "card-head" }, "Add a person"), el("div", { class: "card-body" }, el("div", { class: "row wrap" }, field("Id", id), field("Role", role), field("Password", password), go), el("p", { class: "text-faint" }, "Ids are lowercase letters, digits and dashes. Without a password the person cannot sign in here until one is set.")));
    async function add() {
      const value = id.value.trim();
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) return toast("An id is lowercase letters, digits and dashes, up to 32 characters.", { tone: "error" }), id.focus();
      if (password.value && password.value.length < 8) return toast("A password needs at least 8 characters.", { tone: "error" }), password.focus();
      go.disabled = true;
      try {
        await api("/api/admin/users", { method: "POST", body: { id: value, role: role.value, password: password.value || undefined } });
        toast(`${value} was added.`, { tone: "good" });
        id.value = "";
        password.value = "";
        selected = value;
        await load();
      } catch (err) {
        toast(err.message, { tone: "error" });
      } finally {
        go.disabled = false;
      }
    }
    return block;
  }

  function drawDetail() {
    clear(detailEl);
    const p = people.find((x) => x.id === selected);
    if (!p) return put(detailEl, el("div", { class: "panel-hint" }, "Select a person to change what they may do."));
    if (p.id === user) return put(detailEl, card(el("code", {}, p.id), el("p", { class: "text-dim" }, "This is you. Your own role, status and password are changed by another admin or on the host.")));
    const roleBtn = button(p.role === "admin" ? "Make a user" : "Make an admin", { onClick: () => void change(roleBtn, "role", { role: p.role === "admin" ? "user" : "admin" }, `${p.id} becomes ${p.role === "admin" ? "a user: no control panel beyond their own packages." : "an admin: people, promotion, everyone's packages."}`) });
    const statusBtn = button(p.status === "active" ? "Suspend" : "Activate", { tone: p.status === "active" ? "warn" : "quiet", onClick: () => void change(statusBtn, "status", { status: p.status === "active" ? "suspended" : "active" }, p.status === "active" ? `${p.id} cannot sign in or start turns until activated again.` : `${p.id} can sign in and start turns again.`) });
    const pw = el("input", { class: "input", type: "password", placeholder: "new password (8+ characters)", "aria-label": "New password", autocomplete: "new-password" });
    const pwBtn = button("Set password", { onClick: () => void setPassword(pwBtn, pw) });
    const removeBtn = button("Remove", { tone: "warn", onClick: () => void remove(removeBtn, p) });
    put(detailEl, 
      card(
        el("code", {}, p.id),
        kv([["role", badge(p.role, p.role === "admin" ? "accent" : "dim")], ["status", badge(p.status, p.status === "active" ? "ok" : "warn")], ["since", new Date(p.createdAt).toLocaleString()]]),
        el("div", { class: "card-actions" }, roleBtn, statusBtn),
        heading("Password"),
        el("div", { class: "row" }, pw, pwBtn),
        el("p", { class: "text-faint" }, "Setting a password signs the person out everywhere."),
        el("div", { class: "card-actions" }, removeBtn)
      ),
      el("p", { class: "panel-hint" }, "Removing a person deletes their userspace: every conversation and package they have. This cannot be undone.")
    );
  }

  async function change(anchor, what, body, note) {
    const ok = await confirm(anchor, { title: `Change ${what}?`, lines: [["person", selected]], note, confirmLabel: "Change" });
    if (!ok) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(selected)}/${what}`, { method: "POST", body });
      toast(`${selected}'s ${what} was changed.`, { tone: "good" });
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  async function setPassword(anchor, input) {
    if (input.value.length < 8) return toast("A password needs at least 8 characters.", { tone: "error" }), input.focus();
    try {
      await api(`/api/admin/users/${encodeURIComponent(selected)}/password`, { method: "POST", body: { password: input.value } });
      input.value = "";
      toast(`${selected}'s password was set.`, { tone: "good" });
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  async function remove(anchor, p) {
    const ok = await confirm(anchor, { title: "Remove this person?", lines: [["person", p.id], ["deletes", "their conversations and packages"]], note: "This cannot be undone.", confirmLabel: "Remove", tone: "warn" });
    if (!ok) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      toast(`${p.id} was removed.`, { tone: "good" });
      selected = null;
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  void load();
}

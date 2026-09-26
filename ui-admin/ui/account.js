/* Account: who you are here, and your password. Everyone sees it, an admin included, and it is only ever
 * about the person signed in: the id and role come from the `account` command, which reads them from the
 * gateway's own record of who is asking, and `password-change` sends your id from the server side, never
 * from this page. A signed-in person is active by definition, so there is no status to show.
 *
 * Changing the password forgets every sign-in of yours, this browser's included, so on success the page
 * sends you to the sign-in page rather than leaving you on a page whose next request would be refused. */

export function mountAccount(ext, root, who = {}) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, card, confirm, field, heading, kv, put } = ext.ui;
  let me = { user: who.user ?? "", role: who.role ?? "" };
  const wrap = el("div", { class: "panel-col ua-account" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  async function load() {
    const stop = busy(wrap, "Reading your account…");
    try {
      const out = await ext.request("account");
      if (out?.data?.user) me = { user: out.data.user, role: out.data.role ?? me.role };
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    draw();
  }

  function passwordForm() {
    // The id rides along, hidden, so a password manager files the new password under the right account.
    const username = el("input", { type: "text", autocomplete: "username", value: me.user, hidden: true, readonly: "", tabindex: "-1", "aria-hidden": "true" });
    const current = el("input", { class: "input", type: "password", autocomplete: "current-password", "aria-label": "Current password", required: "" });
    const next = el("input", { class: "input", type: "password", autocomplete: "new-password", "aria-label": "New password", required: "" });
    const again = el("input", { class: "input", type: "password", autocomplete: "new-password", "aria-label": "New password again", required: "" });
    const go = button("Change password", { tone: "primary", type: "submit" });

    async function submit(e) {
      e.preventDefault();
      if (!current.value) return ext.toast("Your current password is needed to change it.", { tone: "error" }), current.focus();
      if (!next.value) return ext.toast("The new password is empty.", { tone: "error" }), next.focus();
      if (next.value !== again.value) return ext.toast("The two new passwords differ.", { tone: "error" }), again.focus();
      const ok = await confirm(go, { title: "Change your password?", lines: [["account", me.user]], note: "This signs you out everywhere, this browser included.", confirmLabel: "Change it", tone: "warn" });
      if (!ok) return;
      go.disabled = true;
      try {
        await ext.request("password-change", { args: { current: current.value, password: next.value } });
        current.value = next.value = again.value = "";
        ext.toast("Your password was changed. Sign in again with the new one.", { tone: "good" });
        // Every sign-in token of yours is gone; the root sends a stranger to the sign-in page.
        setTimeout(() => location.assign("/"), 1200);
      } catch (err) {
        ext.toast(err.message, { tone: "error" });
        go.disabled = false;
      }
    }

    return el(
      "form",
      { class: "ua-password", onSubmit: (e) => void submit(e) },
      username,
      field("Current password", current),
      field("New password", next),
      field("New password again", again),
      el("div", { class: "row" }, go),
      el("p", { class: "text-faint" }, "Changing it signs you out everywhere, this browser included; you sign in again with the new one.")
    );
  }

  function draw() {
    clear(wrap);
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Your account")),
      card(
        el("code", {}, me.user || "—"),
        kv([["id", el("code", {}, me.user || "—")], ["role", badge(me.role || "unknown", me.role === "admin" ? "accent" : "dim")]]),
        el("p", { class: "text-faint" }, me.role === "admin" ? "An admin: you manage people, mounts, keys and packages for everyone. Another admin, or the host, changes your role." : "A user: you manage your own workspace, keys and packages. An admin changes your role or binds host directories for you."),
        el("p", { class: "text-faint" }, "Your picture is the round button at the bottom of the sidebar: click it to change it.")
      ),
      card("Password", passwordForm())
    );
  }

  void load();
}

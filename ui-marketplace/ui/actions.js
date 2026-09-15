/* The actions a package page offers, and the confirm popover in front of each: Install for me, Update,
 * Remove, Delete (a package of one's own, with its files), and for an admin Install for everyone, Make
 * it the default for everyone, and Install for a person. Every popover states the facts a person should
 * read first and one sentence on what happens next; nothing is sent until they confirm. After an action
 * the place is re-opened on the page, or on the gallery when the package is gone from here. */

/** A shipped @thetis package installs by name, already built; anything else by its registry source. */
const sourceOf = (row) => (row.name.startsWith("@thetis/") ? row.name : row.source);

const count = (n) => `${n} ${n === 1 ? "person" : "people"}`;

export function actionsFor(ext, view, host) {
  const { el } = ext.dom;
  const { button, busy, confirm } = ext.ui;
  const { row, user, role, people } = view;
  const admin = role !== "user";
  const own = row.installed && row.name.startsWith(`@${user}/`);
  const buttons = [];
  const hints = [];

  const go = (name) => ext.open.place("marketplace", name ? { name } : {});

  /** Runs one command behind its popover; a failure is a toast and the page stays as it is. */
  async function run(anchor, popover, busyText, send, after) {
    const ok = await confirm(anchor, popover);
    if (!ok) return;
    const stop = busy(host, busyText);
    try {
      const out = await send();
      after(out?.data ?? {});
    } catch (err) {
      ext.toast(err?.message || "That did not work.", { tone: "error" });
    } finally {
      stop();
    }
  }

  function installMe(anchor) {
    return run(
      anchor,
      { title: "Install for you?", lines: [["package", `${row.name}@${row.version}`], ["from", row.registry || "a source"], ["for", "you only"]], note: "It is live on the next turn.", confirmLabel: "Install" },
      "Installing… this can take a minute.",
      () => ext.request("install", { args: { source: sourceOf(row) } }),
      (r) => {
        ext.toast(`${r.name}@${r.version} is in place for you.`, { tone: "good" });
        go(r.name);
      }
    );
  }

  function updateMe(anchor) {
    return run(
      anchor,
      { title: "Update for you?", lines: [["package", `${row.name}@${row.update.version}`], ["from", row.update.registry], ["commit", `${row.update.from} → ${row.update.to}`]], note: "It is live on the next turn. The copy you have keeps working if the new one fails to build.", confirmLabel: "Update" },
      "Updating… this can take a minute.",
      () => ext.request("update", { args: { name: row.name } }),
      (r) => {
        ext.toast(`${r.name}@${r.version} is in place for you.`, { tone: "good" });
        go(r.name);
      }
    );
  }

  function installFor(anchor, who) {
    return run(
      anchor,
      { title: `Install for ${who}?`, lines: [["package", `${row.name}@${row.version}`], ["from", row.registry || "a source"], ["for", who]], note: "It is live on their next turn.", confirmLabel: "Install" },
      `Installing for ${who}… this can take a minute.`,
      () => ext.request("install-for", { args: { user: who, source: sourceOf(row) } }),
      (r) => {
        ext.toast(`${r.name}@${r.version} is in place for ${who}.`, { tone: "good" });
        go(row.name);
      }
    );
  }

  function installEveryone(anchor) {
    const shipped = row.name.startsWith("@thetis/");
    return run(
      anchor,
      { title: "Install for everyone?", lines: [["package", `${row.name}@${row.version}`], ["from", row.registry || "a source"], ["for", "everyone, now and later"]], note: shipped ? "Every person gets it on their next turn, and every new person is set up with it." : "It is installed for you and then made the default under @thetis for everyone.", confirmLabel: "Install for everyone" },
      "Installing for everyone… this can take a minute.",
      () => ext.request("install-everyone", { args: { source: sourceOf(row) } }),
      (r) => {
        ext.toast(`${r.name} is installed for everyone (${count(r.userspaces?.length ?? 0)}).`, { tone: "good" });
        go(r.name);
      }
    );
  }

  function promote(anchor) {
    const base = row.name.slice(row.name.indexOf("/") + 1);
    return run(
      anchor,
      { title: "Make it the default for everyone?", lines: [["package", row.name], ["becomes", `@thetis/${base}`], ["for", "everyone, now and later"]], note: `Everyone gets @thetis/${base} on their next turn. Your own copy ${row.name} is removed.`, confirmLabel: "Make it the default" },
      "Making it the default…",
      () => ext.request("promote", { args: { user, name: row.name } }),
      (r) => {
        ext.toast(`${r.name} is now the default for everyone (${count(r.userspaces?.length ?? 0)}).`, { tone: "good" });
        go(r.name);
      }
    );
  }

  function remove(anchor) {
    const note = row.replaced
      ? `Its files stay in place; only the link is removed. ${row.replaced} comes back on the next turn.`
      : row.scope === "everyone"
        ? "This is a system package. Steps and tools it brings stop on the next turn; an admin can add it back."
        : "Its files stay in place; only the link is removed. Steps and tools it brings stop on the next turn.";
    return run(
      anchor,
      { title: "Remove this package?", lines: [["package", row.name], ["from", "your own setup"]], note, confirmLabel: "Remove", tone: "warn" },
      "Removing…",
      () => ext.request("remove", { args: { name: row.name } }),
      () => {
        ext.toast(`${row.name} was removed.`, { tone: "good" });
        go(row.available ? row.name : row.replaced || null);
      }
    );
  }

  function del(anchor) {
    return run(
      anchor,
      { title: "Delete this package?", lines: [["package", row.name], row.forkedFrom && ["forked from", `${row.forkedFrom.name}@${row.forkedFrom.version}`], ["comes back", row.replaced || "nothing"]].filter(Boolean), note: "This deletes the files under packages/ too. Steps and tools it brings stop on the next turn.", confirmLabel: "Delete", tone: "warn" },
      "Deleting…",
      () => ext.request("delete", { args: { name: row.name } }),
      (r) => {
        ext.toast(r.restored ? `${r.name} was deleted. ${r.restored} is back in place.` : `${r.name} was deleted.`, { tone: "good" });
        go(r.restored || null);
      }
    );
  }

  const add = (label, tone, handler) => {
    const b = button(label, { tone });
    b.addEventListener("click", () => void handler(b));
    buttons.push(b);
    return b;
  };

  if (!row.installed) {
    add("Install for me", "primary", installMe);
    hints.push(row.name.startsWith("@thetis/") ? "A shipped package is linked already built. It is live on the next turn." : "The package is cloned from its registry and built in your own space. It is live on your next turn.");
  }
  if (row.update) {
    add(`Update to ${row.update.version}`, "primary", updateMe);
    hints.push(`The registry holds a newer commit (${row.update.from} → ${row.update.to}). Nothing changes until you take it, and the copy you have keeps working if the new one fails to build.`);
  }
  if (admin && row.scope !== "everyone" && (row.source || row.name.startsWith("@thetis/"))) {
    add("Install for everyone", "primary", installEveryone);
    hints.push("Everyone gets it now, and every new person from then on.");
  }
  if (admin && row.installed && row.scope === "me" && !row.name.startsWith("@thetis/")) {
    add("Make it the default for everyone", "primary", promote);
    hints.push(`Making it the default copies the package under @thetis, adds it for every person, and removes your own copy.`);
  }
  if (row.installed) add("Remove", "warn", remove);
  if (own) {
    add("Delete", "warn", del);
    hints.push(row.replaced ? `Remove or Delete puts ${row.replaced} back in place.` : "Delete removes the package and its files under packages/.");
  }

  // An admin installs for one person from a picker: the people, then a button naming the chosen one.
  let picker = null;
  const others = (people || []).filter((p) => p.id !== user);
  if (admin && others.length && row.scope !== "everyone" && (row.source || row.name.startsWith("@thetis/"))) {
    const select = el("select", { class: "input mk-person", "aria-label": "Person" }, ...others.map((p) => el("option", { value: p.id }, p.id)));
    const b = button(`Install for ${select.value}`, { tone: "quiet" });
    select.addEventListener("change", () => {
      b.textContent = `Install for ${select.value}`;
    });
    b.addEventListener("click", () => void installFor(b, select.value));
    picker = el("div", { class: "mk-picker" }, select, b);
  }

  return { buttons, hints, picker };
}

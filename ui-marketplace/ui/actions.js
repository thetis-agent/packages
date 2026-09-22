/* The actions a package page offers, and the confirm popover in front of each: Install for me, Update or
 * Reload my workspace or Go back to the package this was forked from, Remove, Delete (a package of one's
 * own, with its files), Publish to a registry -- with the packages already on the branch that a push would
 * carry with it, ticked one by one or named as the reason it cannot go -- and for an admin Install for
 * everyone, Make it the default for everyone, and Install for a person. Update, Reload and Go back are the three kinds of behind: a
 * registry holding a newer commit is installed, files on disk the workspace has not read are already installed and are put
 * into service by reloading the workspace, and a fork's origin has moved on without it, which going back
 * to that origin takes. Every popover states the facts a person should read first and one sentence on what
 * happens next; nothing is sent until they confirm. After an action the place is re-opened on the page, or
 * on the gallery when the package is gone from here. */

/** How long the page waits for its own workspace to answer again after it was reloaded. */
const SETTLE_MS = 30_000;

/**
 * A request that lost its gateway, as against one a gateway refused with a sentence. Reloading your own
 * workspace closes the fence answering the page, which leaves either no answer at all (status 0) or the
 * door's own 502/503 while the socket is gone; anything else came from a gateway that is still there.
 */
const lostGateway = (err) => {
  const status = Number(err?.status);
  return !Number.isFinite(status) || status === 0 || status >= 502;
};

/** Asks the new workspace for this page until it answers, or until the deadline passes. */
async function settle(ext, name, deadline = Date.now() + SETTLE_MS) {
  for (;;) {
    try {
      await ext.request("show", { args: { name } });
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((done) => setTimeout(done, 700));
    }
  }
}

/** A shipped @thetis package installs by name, already built; anything else by its registry source. */
const sourceOf = (row) => (row.name.startsWith("@thetis/") ? row.name : row.source);

const count = (n) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * The people a fleet-wide install did not reach, because they are holding a fork of the package. The
 * kernel will not install a package over somebody's fork of it, and an admin acting on people who are not
 * at the keyboard must not be allowed to read "installed for everyone" and walk away: without this line
 * they would believe a gateway is the default everywhere while three people are still on their own copy.
 */
const forksNote = (r) => (r.forks?.length ? ` Not ${r.forks.map((f) => `${f.user} (holding ${f.fork})`).join(", ")}: a person's fork of it stays in place.` : "");

/**
 * A publish in a checkout that *is* the registry pushes the branch, so anything already committed on that
 * branch goes with it even though the publish's own commit is scoped to one directory. That is the
 * maintainer's ordinary state -- work committed across several packages as they went -- so the publishing
 * package refuses and names the passengers rather than shipping them quietly. A dry run reports the same
 * rows in `blockers[].details` instead of refusing, which is what lets this page draw them.
 *
 * A row is a passenger when it names a package, and `publishable` is the whole decision: a package whose
 * version has gone past what the registry holds can be published in its own right and so can be offered as
 * a tick; one that cannot be published can never be named, and is shown as the reason the publish cannot
 * go. The rows arrive already sorted into `details.blocked` and `details.nameable`, and the blocked ones
 * come first here because they are what has to be dealt with before any tick means anything. A blocker
 * whose `details` is a plain list of paths -- staged files -- names no package and contributes no rows; its
 * sentence still stands on its own.
 */
export const passengersOf = (blockers) =>
  (blockers ?? [])
    .flatMap((b) => {
      const d = b.details;
      if (Array.isArray(d)) return d;
      return d && typeof d === "object" ? [...(d.blocked ?? []), ...(d.nameable ?? [])] : [];
    })
    .filter((d) => d && typeof d === "object" && typeof d.package === "string");

/** Whether this passenger can be named in `with`. `moved` is the fallback for a row that does not say. */
const canRide = (row) => (row.publishable === undefined ? !!row.moved : !!row.publishable);

/** The blocker sentences, whole, as the publishing package wrote them: one refusal, one paragraph. */
export const blockerLines = (blockers) => (blockers ?? []).map((b) => b.message).filter((m) => typeof m === "string" && m);

/**
 * Why this one can never be named. The publishing package says it two ways: a `problem` is a sentence about
 * the manifest and is already a sentence, and `reason: "not-newer"` is a version that has not moved, which
 * is the common one and reads better said in terms of the two versions than by its code.
 */
function blockedWhy(row, target) {
  if (typeof row.problem === "string" && row.problem) return row.problem;
  if (row.moved === false) return `its version has not moved past the ${row.holds || "version"} ${target || "the registry"} holds, so it cannot be published at all.`;
  return "it cannot be published as it stands.";
}

/** What one passenger is, in the line beside its tick or its cross. */
function passengerLine(row, target) {
  const at = row.version ? ` ${row.version}` : "";
  const held = row.holds ? `${target || "the registry"} holds ${row.holds}` : `${target || "the registry"} has no version of it`;
  return `${at ? at.slice(1) : "this version"} · ${held}`;
}

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

  /**
   * Reloads the person's own workspace, which is what puts a version the fence has not read into service.
   * The popover says the cost plainly: the fence closes for a second, so every open shell session in it
   * ends and this page loses its gateway. It does not go through `run`, because the request that closes the
   * fence answering it is expected to be lost: that is the success, and the page waits for the new
   * workspace rather than reporting a failure. After the deadline it says what to do instead.
   */
  async function reloadMe(anchor) {
    const ok = await confirm(anchor, {
      title: "Reload your workspace?",
      lines: [["package", row.name], ["loaded", `${row.update.installed} in your workspace`], ["on disk", row.update.available]],
      note: "Your workspace closes and opens again on the code on disk, so its services, its provider and the agent itself are the new ones. The fence is gone for a second: every open shell session in it ends, and this page reconnects on its own. Conversations and files are untouched.",
      confirmLabel: "Reload",
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(host, "Reloading your workspace… the page reconnects when it answers.");
    try {
      let services = [];
      try {
        const out = await ext.request("fence-reload");
        services = out?.data?.services ?? [];
      } catch (err) {
        if (!lostGateway(err)) throw err;
        if (!(await settle(ext, row.name))) {
          ext.toast(`Your workspace has not answered for ${SETTLE_MS / 1000} seconds. Reload this page, or ask an admin to reload the workspace.`, { tone: "error" });
          return;
        }
      }
      ext.toast(services.length ? `Your workspace was reloaded: ${services.join(", ")} restarted.` : "Your workspace was reloaded.", { tone: "good" });
      go(row.name);
    } catch (err) {
      ext.toast(err?.message || "That did not work.", { tone: "error" });
    } finally {
      stop();
    }
  }

  /**
   * Goes back to the package this fork was copied from. It is the inverse of forking, and the way out of a
   * fork that has stopped earning its keep: the shipped package goes on being fixed, and a person holding a
   * copy of it sees none of that.
   *
   * It does not go through `run`, for the same reason `reloadMe` does not. The package a person is most
   * likely to have forked is the web gateway, and this page is being served by it, so stopping it is the
   * first thing that happens and the request carrying the click dies with it. That lost answer is the
   * success, not a failure, so the page waits for the package that replaced it to answer instead. When the
   * fork is not a gateway the request simply returns and the wait never begins.
   *
   * The files stay. They are the person's own work and this page will not be the thing that throws them
   * away; Delete, which they can reach once the shipped package is back, is what removes them.
   */
  async function unforkMe(anchor) {
    const origin = row.update?.origin ?? row.fork?.name ?? row.forkedFrom?.name;
    const shipped = row.update?.available ?? row.fork?.shipped ?? "";
    const ok = await confirm(anchor, {
      title: `Go back to ${origin}?`,
      lines: [["fork", `${row.name}@${row.version}`], ["goes back to", `${origin}@${shipped}`], ["your files", "kept where they are"]],
      note: `${row.name} is removed from your setup and ${origin} takes its place, with every change it has had since you forked it.${row.type === "gateway" ? " This page is served by the package being replaced, so it will go quiet for a second and come back on its own." : ""} Your copy stays under packages/; Delete is what removes it.`,
      confirmLabel: `Go back to ${origin}`,
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(host, `Going back to ${origin}…`);
    try {
      let back = null;
      try {
        back = (await ext.request("unfork", { args: { name: row.name } }))?.data ?? null;
      } catch (err) {
        if (!lostGateway(err)) throw err;
        if (!(await settle(ext, origin))) {
          ext.toast(`${origin} has not answered for ${SETTLE_MS / 1000} seconds. Reload this page, or ask an admin to run thetis packages unfork ${row.name}.`, { tone: "error" });
          return;
        }
      }
      ext.toast(`${back?.name ?? origin}${back?.version ? `@${back.version}` : ""} is back in place. Your fork's files are still under packages/.`, { tone: "good" });
      go(back?.name ?? origin);
    } catch (err) {
      ext.toast(err?.message || "That did not work.", { tone: "error" });
    } finally {
      stop();
    }
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
        ext.toast(`${r.name} is installed for everyone (${count(r.userspaces?.length ?? 0)}).${forksNote(r)}`, { tone: r.forks?.length ? "warn" : "good" });
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
        ext.toast(`${r.name} is now the default for everyone (${count(r.userspaces?.length ?? 0)}).${forksNote(r)}`, { tone: r.forks?.length ? "warn" : "good" });
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
  if (row.update?.apply === "unfork") {
    add(`Go back to ${row.update.origin}`, "primary", unforkMe);
    hints.push(
      row.update.identical
        ? `Your fork is the same files as ${row.update.origin}@${row.update.available}, which is shipped here. It is changing nothing and it will never see another fix to ${row.update.origin}. Going back costs you nothing: your files stay where they are.`
        : `You forked ${row.update.origin} at ${row.update.installed}; ${row.update.available} is shipped now, and everything between the two is missing from your copy. Going back keeps your files, so you can fork again from the new one.`
    );
  } else if (row.update?.apply === "reload") {
    add("Reload my workspace", "primary", reloadMe);
    hints.push(`Your workspace loaded ${row.update.installed} when it opened; ${row.update.available} is on disk. The files are installed already, so nothing is fetched or built: reloading the workspace is what puts them into service.`);
  } else if (row.update) {
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

  /**
   * Publishing this package to a registry. Two things have to be settled before anything happens: which
   * target, when more than one is configured, and which version. Neither is a free-text box. The target is
   * a picker over the configured names, the same shape as the person picker above it; the version is a
   * choice between the version already on disk and a patch, minor or major step from it, because a box
   * would ask a person to do semver arithmetic in their head and then trust that they did it right.
   *
   * The confirm popover is filled from a dry run rather than from a guess. `publish_package` with
   * `dryRun` does everything except the commit and the push and reports what would have happened, so the
   * popover shows the target's real `was`, the real `now` and whether this is the first version that
   * target would hold -- and a refusal (a version that does not move past the target, a package that will
   * not build) arrives as a toast before the person has agreed to anything. This is the one action in the
   * product that changes what other installations receive, so it is the one that has earned a round trip.
   */
  async function publishNow(anchor, to, bump, panel) {
    const args = { name: row.name, ...(to ? { to } : {}), ...(bump ? { bump } : {}), ...(panel.chosen().length ? { with: panel.chosen() } : {}) };
    let preview;
    const checking = busy(host, "Checking what would be published…");
    try {
      preview = (await ext.request("publish", { args: { ...args, dryRun: true } }))?.data ?? {};
    } catch (err) {
      panel.clear();
      return ext.toast(err?.message || "That did not work.", { tone: "error" });
    } finally {
      checking();
    }
    const now = preview.now ?? preview.version ?? "";
    const was = preview.was ?? "";
    const target = preview.target ?? to ?? "";
    const first = !!preview.first || !was;
    // A dry run that would not go says so in full, in the page, and the popover does not open. The person
    // ticks what is meant to ride along and presses Publish again; what cannot ride along is a reason, not
    // a choice, and is drawn as one. Nothing is ever ticked on their behalf.
    if (preview.ok === false || preview.blockers?.length) {
      panel.draw(preview.blockers ?? [], target);
      return;
    }
    panel.clear();
    const also = args.with ?? [];
    const ok = await confirm(anchor, {
      title: `Publish ${row.name}?`,
      lines: [
        ["package", `${preview.package ?? row.name}@${now}`],
        ["to", preview.url ? `${target} · ${preview.url}` : target || "the configured registry"],
        ["version", first ? `${now}, the first version ${target || "that registry"} would hold of it` : `${was} → ${now}`],
        preview.branch && ["branch", preview.branch],
        // Never a count. A person agreeing to publish somebody else's work alongside their own reads the
        // names or they have not agreed to anything.
        also.length && ["also publishing", also.join(", ")],
      ].filter(Boolean),
      note: `This pushes to a registry other installations read: everyone mirroring ${target || "it"} gets ${now} on their next refresh, and a version once published is not taken back.${also.length ? ` ${also.length === 1 ? "The package" : "The packages"} above ${also.length === 1 ? "is" : "are"} published in ${also.length === 1 ? "its" : "their"} own right, each one checked the same way.` : " Only this package's own directory is committed."}`,
      confirmLabel: `Publish ${now}`,
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(host, `Publishing to ${target || "the registry"}…`);
    try {
      const out = (await ext.request("publish", { args }))?.data ?? {};
      const at = out.commit ? ` (${String(out.commit).slice(0, 7)})` : "";
      const rode = also.length ? ` ${also.join(", ")} went with it.` : "";
      ext.toast(`${out.package ?? row.name}@${out.now ?? now} is in ${out.target ?? target}${at}.${rode}`, { tone: "good" });
      go(row.name);
    } catch (err) {
      ext.toast(err?.message || "That did not work.", { tone: "error" });
    } finally {
      stop();
    }
  }

  /**
   * The panel under the Publish row: what else is on this branch and would be pushed with the publish.
   * It holds its own ticks between one dry run and the next, so a person who ticks two of three and
   * presses Publish again does not lose the ticks to the redraw. `blocked` is what can never be named;
   * while there is one of those the button is off, because no amount of ticking makes that publish go.
   */
  function publishPanel(button) {
    const node = el("div", { class: "mk-passengers", hidden: true });
    const ticked = new Set();
    let blocked = 0;

    const clear = () => {
      node.hidden = true;
      blocked = 0;
      ext.dom.clear(node);
      button.disabled = false;
    };

    function draw(blockers, target) {
      const rows = passengersOf(blockers);
      const others = blockerLines(blockers);
      ext.dom.clear(node);
      blocked = rows.filter((r) => !canRide(r)).length;
      for (const line of others) node.append(el("p", { class: "mk-passengers-why" }, line));
      for (const r of rows) {
        if (canRide(r)) {
          const box = el("input", { type: "checkbox", class: "mk-passenger-tick" });
          box.checked = ticked.has(r.package);
          box.addEventListener("change", () => (box.checked ? ticked.add(r.package) : ticked.delete(r.package)));
          node.append(el("label", { class: "mk-passenger" }, box, el("code", {}, r.package), el("span", { class: "text-dim" }, ` ${passengerLine(r, target)}`)));
        } else {
          // Named as the reason, not offered as a choice: this one cannot be published as it stands, so
          // the publish cannot go until it is dealt with, and saying so is the only useful thing here.
          node.append(
            el(
              "p",
              { class: "mk-passenger is-blocked" },
              el("code", {}, r.package),
              el("span", {}, ` ${passengerLine(r, target)} — ${blockedWhy(r, target)} It cannot ride along either; take it off this branch, or fix it and publish it in its turn.`)
            )
          );
        }
      }
      // A tick that is no longer offered is a tick nobody meant: drop it rather than send it.
      for (const name of [...ticked]) if (!rows.some((r) => canRide(r) && r.package === name)) ticked.delete(name);
      button.disabled = blocked > 0;
      node.append(
        el(
          "p",
          { class: "panel-hint" },
          blocked > 0
            ? "Publishing is off until those are dealt with. A package that cannot be published cannot be carried along by one that can."
            : rows.length
              ? "Tick what is meant to go out with this publish. Each one is published in its own right and checked the same way; anything left unticked has to come off the branch first."
              : "Deal with the above and press Publish again."
        )
      );
      node.hidden = false;
      node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    return { node, draw, clear, chosen: () => [...ticked] };
  }

  /**
   * The Publish block, or nothing at all. `view.publish` comes from `publish-targets`, which answers
   * `available: false` when @thetis/package-publish is not installed here or has no target configured --
   * which is most installations, for ever. Nothing throws in that case and nothing is drawn: publishing is
   * for whoever maintains the packages, and everybody else only ever installs them.
   */
  let publish = null;
  const offer = view.publish;
  if (row.installed && offer?.available) {
    const targets = Array.isArray(offer.targets) ? offer.targets : [];
    const target = targets.length > 1 ? el("select", { class: "input mk-target", "aria-label": "Registry" }, ...targets.map((t) => el("option", { value: t.name }, t.holds ? `${t.name} · has ${t.holds}` : t.name))) : null;
    const only = targets[0]?.name ?? "";
    // "as it is" first, and chosen by default whenever this copy is already ahead of what is published:
    // the version on disk is the work, and the person bumped it when they did the work.
    const step = el(
      "select",
      { class: "input mk-bump", "aria-label": "Version to publish" },
      el("option", { value: "" }, `as it is — ${row.version}`),
      el("option", { value: "patch" }, "a patch bump"),
      el("option", { value: "minor" }, "a minor bump"),
      el("option", { value: "major" }, "a major bump")
    );
    step.value = row.ahead ? "" : "patch";
    const chosen = () => (target ? target.value : only);
    const b = button(chosen() ? `Publish to ${chosen()}` : "Publish", { tone: "quiet" });
    const panel = publishPanel(b);
    // A different target or a different version is a different question, so the passengers are asked
    // again rather than carried over from the answer to the last one.
    if (target) target.addEventListener("change", () => { b.textContent = `Publish to ${target.value}`; panel.clear(); });
    step.addEventListener("change", () => panel.clear());
    b.addEventListener("click", () => void publishNow(b, chosen(), step.value, panel));
    publish = el("div", { class: "mk-publish-block" }, el("div", { class: "mk-picker mk-publish" }, target, step, b), panel.node);
    hints.push(
      row.ahead?.state === "unpublished"
        ? `No registry lists ${row.name}. Publishing pushes this package's own directory to ${chosen() || "the configured registry"}, where every installation that mirrors it can reach it.`
        : row.ahead
          ? `${row.ahead.version} is here and ${row.ahead.published} is what ${row.ahead.registry} holds. Publishing is what closes that gap; nothing else in the product does.`
          : `Publishing pushes this package's own directory to ${chosen() || "the configured registry"}. The version has to move past what that registry already holds, so pick a bump unless you have already moved it here.`
    );
    if (offer.error) hints.push(`The registries could not be read just now (${offer.error}), so the versions above may be missing. Publish checks again before it asks you to confirm.`);
  }

  return { buttons, hints, picker, publish };
}

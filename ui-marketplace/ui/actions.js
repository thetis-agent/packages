/* The actions an extension's page offers, and the confirm popover in front of each. For anyone: Install and
 * Remove -- one pair, whatever the extension is, with the popover saying what installing *this kind* does.
 * **Update**, one button for every kind of "something newer": it goes through the page's one updater
 * (updates-notice.js), which fetches when a registry holds a newer commit, then applies, waits for the space
 * to come back and refreshes the page. It never asks to cancel a reply: a running reply pauses at a safe point
 * and continues. **Switch back to the official version**, for a person's copy that the official version has
 * caught up with or moved past. Delete, for an extension of one's own, with its files. Publish to a registry
 * -- with the packages already on the branch that a push would carry with it, ticked one by one or named as
 * the reason it cannot go, and, for a fork whose origin the registry already holds, the two publishes it could
 * be -- and Take out of a registry, the one act here that takes something away from everybody else.
 *
 * For an admin, in their own group under the person's actions and visually quieter: Make it the default for
 * everyone and Stop it being the default, which are the two states of one system package; Install for
 * everyone, which turns a registry's offer into a system package; and Install for a person. A host package and
 * a storage driver have no Install at all, and the hint says why. Every popover states the facts a person
 * should read first and one sentence on what happens next; nothing is sent until they confirm. After an action
 * the place is re-opened on the page, or on the store when the extension is gone from here. */

import { isBusy, lostGateway, updater } from "./updates-notice.js";

/**
 * Waits for the space to answer again after the gateway serving this page was replaced (switching the web
 * gateway back to its official version does that). `ext.awaitReturn` is the seam's one implementation; a page
 * from before it asks this page's own command until it answers.
 */
async function settle(ext, name, timeoutMs = 90_000) {
  if (typeof ext.awaitReturn === "function") return (await ext.awaitReturn({ timeoutMs })) === "back";
  const deadline = Date.now() + timeoutMs;
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

/** A system package installs by name, already built; anything else by its registry source. */
const sourceOf = (row) => (row.system ? row.name : row.source);

/**
 * What installing a package of this type does for the person, in one sentence. The flow is the type's:
 * a skill pack is offered to the agent, a tool is offered to the agent, a loader runs in the turn, a
 * service starts at once, a ui package appears on the page. Said in the popover and in the hint under
 * the buttons, so "Install" never has to be taken on faith.
 */
export function whatItBrings(type) {
  switch (type) {
    case "skill":
      return "Its skills are offered to your agent from your next message.";
    case "tool":
      return "Its tools are offered to your agent from your next message.";
    case "loader":
      return "It works in your conversations from your next message.";
    case "provider":
      return "Its models are yours to pick from your next message.";
    case "service":
    case "gateway":
      return "It starts right away.";
    case "ui":
      return "It appears on the page after a refresh.";
    case "skill-type":
      return "It is there for the extensions that need it from your next message.";
    default:
      return "It works from your next message.";
  }
}

/** The types nothing installs for a person, each with why. The page offers no Install for these and says this instead. */
export const NOT_INSTALLABLE = {
  host: "This part runs in the Thetis server itself, so it is never installed for a person.",
  storage: "This storage driver runs in the Thetis server and is chosen by storage.driver in the configuration, so it is never installed for a person.",
};

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
  const buttons = [];
  const adminButtons = [];
  const hints = [];
  const label = row.label ?? row.name;

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

  /**
   * Into the person's own space. The popover says which of the two installs this is, because they cost
   * different things: an extension the installation ships is already here and already built, so the install
   * is over at once; a registry's offer is fetched and built for the person and takes a minute.
   */
  function installMe(anchor) {
    const how = row.system ? "It is already on this installation, so nothing is fetched." : "It is fetched and built for you, which can take a minute.";
    return run(
      anchor,
      { title: `Install ${label}?`, lines: [["extension", `${label} ${row.version}`], ["for", "you"]], note: `${how} ${whatItBrings(row.type)}`, confirmLabel: "Install" },
      row.system ? "Installing…" : "Installing… this can take a minute.",
      () => ext.request("install", { args: { source: sourceOf(row) } }),
      (r) => {
        ext.toast(`${label} is installed.`, { tone: "good" });
        go(r.name);
      }
    );
  }

  /**
   * Switches a person's copy back to the official version, then applies, the same as an update. It is the
   * inverse of making a copy, and the way out of one that has stopped earning its keep: the official version
   * goes on being fixed, and a person holding a copy of it sees none of that.
   *
   * The page's updater does it when there is one, so the card and this button are one act. Without one (an
   * older page) the request is sent here. The copy a person is most likely to hold is the web gateway, which
   * serves this page, so the request carrying the click can die with it: that lost answer is the success, and
   * the page waits for the official version to answer instead.
   *
   * The files stay. They are the person's own work and this page will not be the thing that throws them away;
   * Delete, which they can reach once the official version is back, is what removes them.
   */
  async function unforkMe(anchor) {
    const origin = row.update?.origin ?? row.fork?.name ?? row.forkedFrom?.name;
    const ok = await confirm(anchor, {
      title: "Switch back to the official version?",
      lines: [["your copy", label], ["official version", origin], ["your files", "kept where they are"]],
      note: "The official version takes your copy's place, with every fix it has had since. Your copy's files stay; Delete is what removes them.",
      confirmLabel: "Switch back",
      tone: "warn",
    });
    if (!ok) return;
    const u = updater();
    if (u) return void (await u.switchBack([{ name: row.name, label, origin, state: row.update?.identical ? "identical" : "superseded" }]));
    const stop = busy(host, "Switching back…");
    try {
      let back = null;
      try {
        back = (await ext.request("unfork", { args: { name: row.name } }))?.data ?? null;
      } catch (err) {
        if (!lostGateway(err)) throw err;
        if (!(await settle(ext, origin))) {
          ext.toast("This is taking longer than usual. Refresh the page in a minute.", { tone: "error" });
          return;
        }
      }
      ext.toast("You are on the official version again. Your copy's files are kept.", { tone: "good" });
      go(back?.name ?? origin);
    } catch (err) {
      ext.toast(err?.message || "That did not work.", { tone: "error" });
    } finally {
      stop();
    }
  }

  /**
   * One Update, whatever is behind. The page's updater fetches when a registry holds a newer commit, then
   * applies, waits for the space and refreshes the page; a running reply pauses at a safe point and continues.
   * Terminal sessions close, and the updater asks first when some are open. An older page without an updater
   * sends the fetch here and leaves applying to the card.
   */
  async function updateMe() {
    const u = updater();
    if (u?.busy) return ext.toast("An update is already under way.", { tone: "warn" });
    if (u) {
      try {
        const data = await u.refresh();
        // The person's own extension changed on disk: that is applying their changes, not fetching anything.
        if ((data.own ?? []).some((o) => o.name === row.name)) return void (await u.applyOwn(data, { asked: true }));
        if ((data.items ?? []).some((i) => i.name === row.name)) return void (await u.updateSome([row.name]));
      } catch {
        /* the fallback below still fetches */
      }
    }
    if (row.update?.apply !== "install") return ext.toast("This update is applied from the Updates card.", { tone: "warn" });
    const stop = busy(host, "Updating… this can take a minute.");
    try {
      await ext.request("update", { args: { name: row.name } });
      ext.toast(`${label} is updated. It takes effect when your space next starts.`, { tone: "good" });
      go(row.name);
    } catch (err) {
      ext.toast(isBusy(err) ? "A reply is running; try again when it is done." : err?.message || "That did not work.", { tone: "error" });
    } finally {
      stop();
    }
  }

  function installFor(anchor, who) {
    return run(
      anchor,
      { title: `Install for ${who}?`, lines: [["extension", `${label} ${row.version}`], ["for", who]], note: `${row.system ? "It is already on this installation, so nothing is fetched." : "It is fetched and built for them."} They have it from their next message; a reply of theirs that is running keeps the old one until it ends.`, confirmLabel: "Install" },
      `Installing for ${who}… this can take a minute.`,
      () => ext.request("install-for", { args: { user: who, source: sourceOf(row) } }),
      (r) => {
        ext.toast(`${label} is installed for ${who}.`, { tone: "good" });
        go(row.name);
      }
    );
  }

  /**
   * A system package becomes everyone's default: marked, and linked into every person now. The same verb on
   * a registry's offer first installs it for the admin and then promotes it, which is what makes it a system
   * package; the popover says which of the two is about to happen.
   */
  function installEveryone(anchor) {
    return run(
      anchor,
      row.system
        ? { title: "Make it the default for everyone?", lines: [["extension", `${label} ${row.version}`], ["for", "everyone, now and later"]], note: "Every person has it from their next message, and every new person is set up with it. Anyone can still remove it for themselves.", confirmLabel: "Make it the default" }
        : { title: "Install for everyone?", lines: [["extension", `${label} ${row.version}`], ["from", row.registry || "a source"], ["for", "everyone, now and later"]], note: "It is installed for you, becomes part of this installation, and every person is set up with it now and later.", confirmLabel: "Install for everyone" },
      row.system ? "Making it the default for everyone…" : "Installing for everyone… this can take a minute.",
      () => ext.request("install-everyone", { args: { source: sourceOf(row) } }),
      (r) => {
        ext.toast(`${r.name} is the default for everyone (${count(r.userspaces?.length ?? 0)}).${forksNote(r)}`, { tone: r.forks?.length ? "warn" : "good" });
        go(r.name);
      }
    );
  }

  /** The mark comes off. Nobody loses the package: new people stop being set up with it, and that is all. */
  function unmarkEveryone(anchor) {
    return run(
      anchor,
      { title: "Stop it being the default for everyone?", lines: [["extension", label], ["now", "everyone gets it"], ["after", "each person installs it"]], note: "New people are no longer set up with it. Everyone who has it keeps it; a person removes it from their own page.", confirmLabel: "Stop being the default", tone: "warn" },
      "Taking the mark off…",
      () => ext.request("unmark-everyone", { args: { name: row.name } }),
      () => {
        ext.toast(`${label} is no longer the default for everyone.`, { tone: "good" });
        go(row.name);
      }
    );
  }

  function promote(anchor) {
    const base = row.name.slice(row.name.indexOf("/") + 1);
    return run(
      anchor,
      { title: "Make it the default for everyone?", lines: [["extension", label], ["becomes", `@thetis/${base}`], ["for", "everyone, now and later"]], note: `A copy becomes part of this installation as @thetis/${base}, and every person has it from their next message. Your own copy ${row.name} is removed.`, confirmLabel: "Make it the default" },
      "Making it the default…",
      () => ext.request("promote", { args: { user, name: row.name } }),
      (r) => {
        ext.toast(`${r.name} is now the default for everyone (${count(r.userspaces?.length ?? 0)}).${forksNote(r)}`, { tone: r.forks?.length ? "warn" : "good" });
        go(r.name);
      }
    );
  }

  /**
   * Out of the person's own space, and nothing more. A system package is the installation's, so it stays
   * on disk and Install puts it back; one that is everyone's default stays everyone's, and the popover says
   * so, because "remove" on a package marked for everyone reads as though it might undo the mark.
   */
  function remove(anchor) {
    const stops = "What it brings stops from your next message.";
    const note = row.replaced
      ? `Its files stay in place. ${row.replaced} comes back in its place.`
      : row.system
        ? `The installation keeps its copy, and Install puts it back. ${stops}${row.everyone ? " It stays the default for everyone else, and a new person still gets it." : ""}`
        : `Its files stay in place. ${stops}`;
    return run(
      anchor,
      { title: `Remove ${label}?`, lines: [["extension", label], ["for", "you"]], note, confirmLabel: "Remove", tone: "warn" },
      "Removing…",
      () => ext.request("remove", { args: { name: row.name } }),
      () => {
        ext.toast(`${label} is removed.`, { tone: "good" });
        go(row.available || row.system ? row.name : row.replaced || null);
      }
    );
  }

  function del(anchor) {
    return run(
      anchor,
      { title: `Delete ${label}?`, lines: [["extension", row.name], row.forkedFrom && ["copy of", row.forkedFrom.name], ["comes back", row.replaced || "nothing"]].filter(Boolean), note: "This deletes its files under packages/ too. What it brings stops from your next message.", confirmLabel: "Delete", tone: "warn" },
      "Deleting…",
      () => ext.request("delete", { args: { name: row.name } }),
      (r) => {
        ext.toast(r.restored ? `${r.name} was deleted. ${r.restored} is back in place.` : `${r.name} was deleted.`, { tone: "good" });
        go(r.restored || null);
      }
    );
  }

  const add = (text, tone, handler, into = buttons) => {
    const b = button(text, { tone });
    b.addEventListener("click", () => void handler(b));
    into.push(b);
    return b;
  };
  const addAdmin = (text, handler) => add(text, "quiet", handler, adminButtons);

  // One Install, whatever the extension is, and none at all for the two types nothing installs for a person.
  // The hint says what the extension's type brings.
  const notInstallable = NOT_INSTALLABLE[row.type];
  if (!row.installed && notInstallable) hints.push(notInstallable);
  else if (!row.installed) {
    add("Install", "primary", installMe);
    hints.push(`${row.system ? "Part of this installation already, so installing it is instant." : "Fetched and built for you."} ${whatItBrings(row.type)}`);
  }
  if (row.update?.apply === "unfork" || view.superseded) {
    add("Switch back to the official version", "primary", unforkMe);
    hints.push(
      view.superseded
        ? "Everything your copy changed is in the official version now. Switching back gets you its fixes; your files stay where they are."
        : row.update?.identical
          ? "Your copy is the same as the official version, so it misses every fix. Switching back costs nothing: your files stay where they are."
          : "The official version is newer than what your copy was made from. Switching back keeps your files, so you can make a new copy from it."
    );
  } else if (row.update) {
    add("Update", "primary", updateMe);
    hints.push("Update fetches what is needed and applies it. A reply that is running pauses at a safe point and continues afterwards.");
  }
  if (row.installed) add("Remove", "warn", remove);
  // Delete goes by where the files are, not by the name: a copy under this person's home is theirs to delete, whatever scope it was given.
  if (row.local) {
    add("Delete", "warn", del);
    hints.push(row.replaced ? `Remove or Delete puts ${row.replaced} back in place.` : "Delete removes the extension and its files under packages/.");
  }

  // The admin's actions come after the person's own, in their own quieter group, and they are about everyone,
  // never about this person: Install and Remove above already are that. A system package is either
  // everyone's default or not, and the one button here flips it -- when it can. `everyoneBy` says who made
  // it everyone's, and a mark the configuration or a promotion made is not this page's to undo, so the hint
  // says where that is undone rather than drawing a button that would refuse.
  const adminHints = [];
  if (admin && row.system && !notInstallable) {
    if (!row.everyone) {
      addAdmin("Make it the default for everyone", installEveryone);
      adminHints.push("Every person gets it now, and every new person is set up with it.");
    } else if (row.everyoneBy === "marked") {
      addAdmin("Stop it being the default", unmarkEveryone);
      adminHints.push("It is everyone's default by an admin's mark. Taking the mark off stops new people being set up with it; everyone who has it keeps it.");
    } else if (row.everyoneBy === "promoted") adminHints.push("It is everyone's default because it was made so from a person's copy. Removing that copy from the host is what undoes it.");
    else adminHints.push('It is everyone\'s default by the installation\'s configuration (systemPackages "*"), which the control panel edits.');
  }
  if (admin && !row.system && !row.installed && row.source && !notInstallable) {
    addAdmin("Install for everyone", installEveryone);
    adminHints.push("It is installed for you, becomes part of this installation, and every person gets it now and later.");
  }
  // Any copy of the admin's own that is not the installation's can be made the default, whatever its scope is called.
  if (admin && row.installed && !row.system) {
    addAdmin("Make it the default for everyone", promote);
    adminHints.push("This copies the extension into the installation as @thetis, adds it for every person, and removes your own copy.");
  }

  // An admin installs for one person from a picker: the people, then a button naming the chosen one.
  let picker = null;
  const others = (people || []).filter((p) => p.id !== user);
  if (admin && others.length && !row.everyone && !notInstallable && (row.source || row.system)) {
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
   *
   * `choice` is `{ to, bump, as }`: which registry, which version step, and -- only ever for a fork whose
   * origin the target already holds -- which of the two publishes this one is. `as` is never guessed at
   * and never held on to: each press carries its own, and the dry run is run again for it, because the two
   * are measured against different versions and only the publishing package knows which.
   */
  async function publishNow(anchor, choice, panel, fork) {
    const { to, bump, as } = choice;
    const args = { name: row.name, ...(to ? { to } : {}), ...(bump ? { bump } : {}), ...(as ? { as } : {}), ...(panel.chosen().length ? { with: panel.chosen() } : {}) };
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
      // One of them is not something to go away and fix. A fork whose origin the registry already holds
      // could be two publishes, and the refusal exists to ask which -- so it is drawn as the two acts it
      // is choosing between, each with the version control that belongs to it, and the rest ride under it
      // as sentences until an answer is given and the dry run is run again.
      const asking = (preview.blockers ?? []).find((b) => b.code === "ambiguous-fork");
      if (asking) {
        panel.clear();
        return fork.ask(asking, target, blockerLines((preview.blockers ?? []).filter((b) => b !== asking)));
      }
      panel.draw(preview.blockers ?? [], target);
      return;
    }
    panel.clear();
    const also = args.with ?? [];
    // A fork going out as its origin publishes the origin: the origin's name, the origin's next version,
    // no fork mark on what lands. The person's own copy is not rewritten and stays a fork, which is the
    // one thing somebody would reasonably assume otherwise -- so it is said before they agree and again
    // after it is done.
    const copy = preview.as === "origin" ? preview.fork : null;
    const ok = await confirm(anchor, {
      title: copy ? `Publish ${copy.name} as ${preview.package}?` : `Publish ${row.name}?`,
      lines: [
        ["package", `${preview.package ?? row.name}@${now}`],
        ["to", preview.url ? `${target} · ${preview.url}` : target || "the configured registry"],
        ["version", first ? `${now}, the first version ${target || "that registry"} would hold of it` : `${was} → ${now}`],
        preview.branch && ["branch", preview.branch],
        copy && ["your copy", `${copy.name}@${copy.version}, still a fork`],
        // Never a count. A person agreeing to publish somebody else's work alongside their own reads the
        // names or they have not agreed to anything.
        also.length && ["also publishing", also.join(", ")],
      ].filter(Boolean),
      note: `${copy ? `What lands in ${target || "the registry"} is ${preview.package} itself, under its own name; ${copy.name} stays here exactly as it is, a fork at ${copy.version}. ` : ""}This pushes to a registry other installations read: everyone mirroring ${target || "it"} gets ${now} on their next refresh, and a version once published is not taken back.${also.length ? ` ${also.length === 1 ? "The package" : "The packages"} above ${also.length === 1 ? "is" : "are"} published in ${also.length === 1 ? "its" : "their"} own right, each one checked the same way.` : " Only this package's own directory is committed."}`,
      confirmLabel: `Publish ${now}`,
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(host, `Publishing to ${target || "the registry"}…`);
    try {
      const out = (await ext.request("publish", { args }))?.data ?? {};
      const at = out.commit ? ` (${String(out.commit).slice(0, 7)})` : "";
      const rode = also.length ? ` ${also.join(", ")} went with it.` : "";
      // Beside the result, because believing this wrongly means believing your own workspace moved when it
      // did not. `fork` is set by the publishing package only when the origin is what was published.
      const mine = out.fork ? ` Your copy is still ${out.fork.name} ${out.fork.version}, a fork.` : "";
      ext.toast(`${out.package ?? row.name}@${out.now ?? now} is in ${out.target ?? target}${at}.${rode}${mine}`, { tone: "good" });
      go(row.name);
    } catch (err) {
      ext.toast(err?.message || "That did not work.", { tone: "error" });
    } finally {
      stop();
    }
  }

  /**
   * Taking this package back out of a registry, which is the other half of publishing and the only act in
   * the product that takes something away from everybody else. It is reached the same way a publish is,
   * from the page of the package it is about, and it runs the same dry run first: the confirm has to name
   * the version the registry is actually holding, and a removal of something no registry holds should be a
   * sentence read before anything is agreed rather than after.
   *
   * The confirm says what the answer says, and it does not paraphrase the second half away. A removal is
   * not a recall: the package leaves the index, so nobody installs it again, and every installation that
   * already has it keeps it, goes on running it, and is never told. That is the part people get wrong, and
   * from inside the product there is nothing that undoes it.
   */
  async function removeFromRegistry(anchor, to, panel) {
    let preview;
    const checking = busy(host, "Checking what would be taken out…");
    try {
      preview = (await ext.request("unpublish", { args: { name: row.name, ...(to ? { to } : {}), dryRun: true } }))?.data ?? {};
    } catch (err) {
      return ext.toast(err?.message || "That did not work.", { tone: "error" });
    } finally {
      checking();
    }
    const target = preview.target ?? to ?? "";
    // A removal pushes a branch too, so it meets the same gates about what else that branch is carrying.
    // They are reasons and not choices here: nothing rides along with a removal from this page.
    if (preview.ok === false || preview.blockers?.length) return panel.reason(preview.blockers ?? []);
    const held = preview.held ?? "";
    const gone = `${preview.directory ?? ""}/`;
    const ok = await confirm(anchor, {
      title: `Take ${preview.package ?? row.name} out of ${target}?`,
      lines: [
        ["package", held ? `${preview.package ?? row.name}@${held}` : (preview.package ?? row.name)],
        ["out of", preview.url ? `${target} · ${preview.url}` : target || "the configured registry"],
        ["deletes", `${gone} · ${preview.files?.length ?? 0} file(s)`],
        preview.branch && ["branch", preview.branch],
      ].filter(Boolean),
      note: `It leaves the marketplace index at the next refresh, so nobody installs it again. Every installation that already has it keeps it, goes on running it, and is not told.${preview.mode === "checkout" ? ` ${gone} goes from ${preview.repo} as well, because that checkout is the registry; git has the history.` : ""} Nothing in the product puts it back.`,
      confirmLabel: `Take it out of ${target}`,
      tone: "warn",
    });
    if (!ok) return;
    const stop = busy(host, `Taking ${row.name} out of ${target || "the registry"}…`);
    try {
      const out = (await ext.request("unpublish", { args: { name: row.name, ...(to ? { to } : {}) } }))?.data ?? {};
      const at = out.commit ? ` (${String(out.commit).slice(0, 7)})` : "";
      // Warn and not good: it worked, and the sentence it worked into is one that has to be read.
      ext.toast(`${out.package ?? row.name} ${out.held ?? held} is out of ${out.target ?? target}${at}. Every installation that already has it keeps it, goes on running it, and is not told.`, { tone: "warn" });
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
   * while there is one of those the publish is off, because no amount of ticking makes that publish go.
   * `gate` is how it says so, because by then there may be more than one button that would publish.
   */
  function publishPanel(gate) {
    const node = el("div", { class: "mk-passengers", hidden: true });
    const ticked = new Set();

    const clear = () => {
      node.hidden = true;
      ext.dom.clear(node);
      gate(false);
    };

    function draw(blockers, target) {
      const rows = passengersOf(blockers);
      const others = blockerLines(blockers);
      ext.dom.clear(node);
      const blocked = rows.filter((r) => !canRide(r)).length;
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
      gate(blocked > 0);
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

    /**
     * The same rows with nothing to tick: what a removal's dry run reported. Nothing rides along with a
     * removal from this page, so every row here is a reason, and a tick beside one would be an offer to
     * publish somebody's work under a button that says it takes a package away.
     */
    function reason(blockers) {
      ext.dom.clear(node);
      for (const line of blockerLines(blockers)) node.append(el("p", { class: "mk-passengers-why" }, line));
      for (const r of passengersOf(blockers)) node.append(el("p", { class: "mk-passenger is-blocked" }, el("code", {}, r.package), el("span", {}, ` ${r.version ?? ""}`)));
      node.append(el("p", { class: "panel-hint" }, "The branch has to be dealt with first: a removal commits one directory and pushes the branch, exactly as a publish does."));
      node.hidden = false;
      node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    return { node, draw, reason, clear, chosen: () => [...ticked] };
  }

  /**
   * The question a fork's publish raises, and the two answers to it.
   *
   * `fork_package` writes `thetis.forkedFrom` into a copy, so "publish my change" over a fork is two
   * entirely different acts wearing one set of words: the change becomes the next version of the package
   * it came from, or this becomes a package of its own, apart from that one from here on. Both are
   * legitimate, so nothing here picks one. The publishing package refuses with `ambiguous-fork` and its
   * `details` carry `{ origin, fork }` -- the origin's directory, name and the version the target holds
   * for it, and the fork's own name and version -- so the two acts can be drawn without reading the prose.
   *
   * Each is an action worded as what it does, not as the flag it sends, and each carries its own version
   * control, because the versions are not the same question: as its origin, the version is the origin's
   * next one, measured against what the target holds for the origin, and the fork's own `0.1.0-fork.1` is
   * never a candidate; as itself, the version is the fork's own line, the one on disk included. The
   * numbers are never worked out here -- a step is asked for and the dry run comes back with the versions.
   *
   * It is asked once. The gate fires while the target holds the origin and not this fork, so the registry
   * is what remembers the answer; nothing is kept here, and the panel goes when the page is redrawn.
   */
  function forkPanel(run, changed) {
    const node = el("div", { class: "mk-fork", hidden: true });
    let asked = null;

    const clear = () => {
      asked = null;
      node.hidden = true;
      ext.dom.clear(node);
      changed();
    };

    const steps = (...first) =>
      el(
        "select",
        { class: "input mk-bump", "aria-label": "Version to publish" },
        ...first,
        el("option", { value: "patch" }, "a patch bump"),
        el("option", { value: "minor" }, "a minor bump"),
        el("option", { value: "major" }, "a major bump")
      );

    /** One of the two acts: a sentence about what it does, the version control it owns, and the button. */
    function act(label, note, select, as) {
      const b = button(label, { tone: "quiet" });
      b.addEventListener("click", () => void run(b, { bump: select.value, as }));
      asked.buttons.push(b);
      return el("div", { class: "mk-fork-act" }, el("p", { class: "mk-fork-note" }, note), el("div", { class: "mk-fork-row" }, select, b));
    }

    function ask(blocker, target, others) {
      const origin = blocker.details?.origin ?? {};
      const fork = blocker.details?.fork ?? { name: row.name, version: row.version };
      const where = target || "the registry";
      asked = { buttons: [] };
      ext.dom.clear(node);
      // The refusal's own sentence first, whole: it is one paragraph and it says the thing both buttons
      // are answers to. The other blockers stand under it; they are about the branch and come back when
      // the question has been answered and the dry run is run again.
      node.append(el("p", { class: "mk-fork-why" }, blocker.message));
      for (const line of others ?? []) node.append(el("p", { class: "mk-passengers-why" }, line));
      node.append(
        act(
          `Make it the next version of ${origin.name ?? "its origin"}`,
          `${where} holds ${origin.name ?? "the origin"} ${origin.version ?? ""} in ${origin.dir ?? ""}/. The change goes out as the next version of it, under its own name, and your copy stays ${fork.name} ${fork.version} here, a fork. The version is a step from ${origin.version ?? "what the registry holds"}, never from ${fork.version}.`,
          steps(),
          "origin"
        ),
        act(
          "Make it a package of its own",
          `${fork.name} goes into ${where} under its own name, at its own version, apart from ${origin.name ?? "the origin"} from here on. Once ${where} holds it there is only one reading of a publish left, and this is not asked again.`,
          steps(el("option", { value: "" }, `as it is — ${row.version}`)),
          "itself"
        )
      );
      node.hidden = false;
      node.scrollIntoView({ behavior: "smooth", block: "nearest" });
      // The plain Publish row above is not the question any more: the version belongs to whichever of the
      // two is chosen, so it stands down until one of them is pressed or the target changes.
      changed();
    }

    return { node, ask, clear, open: () => !!asked, disable: (off) => (asked?.buttons ?? []).forEach((b) => (b.disabled = off)) };
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
    // The other act against the same registry, kept off the publish row: it is destructive, it is not
    // undoable from in here, and it must not sit one button-width from the thing it is the opposite of by
    // accident. `canRemove` is read off the publishing package's manifest, so an older one draws nothing.
    const takeOut = offer.canRemove ? button(`Take out of ${chosen()}`, { tone: "warn" }) : null;
    // While the fork question is up, the version above is not the question: each answer carries its own,
    // and pressing the plain Publish would be pressing it without having answered.
    const fork = forkPanel((anchor, choice) => publishNow(anchor, { ...choice, to: chosen() }, panel, fork), () => gate(false));
    const gate = (blocked) => {
      b.disabled = blocked || fork.open();
      step.disabled = fork.open();
      fork.disable(blocked);
    };
    const panel = publishPanel(gate);
    const clearAll = () => {
      fork.clear();
      panel.clear();
    };
    // A different target or a different version is a different question, so the passengers and the fork
    // choice are both asked again rather than carried over from the answer to the last one.
    if (target) target.addEventListener("change", () => { b.textContent = `Publish to ${target.value}`; if (takeOut) takeOut.textContent = `Take out of ${target.value}`; clearAll(); });
    step.addEventListener("change", () => clearAll());
    b.addEventListener("click", () => void publishNow(b, { to: chosen(), bump: step.value }, panel, fork));
    if (takeOut) takeOut.addEventListener("click", () => void removeFromRegistry(takeOut, chosen(), panel));
    publish = el(
      "div",
      { class: "mk-publish-block" },
      el("div", { class: "mk-picker mk-publish" }, target, step, b),
      fork.node,
      panel.node,
      takeOut ? el("div", { class: "mk-picker mk-unpublish" }, takeOut) : null
    );
    hints.push(
      row.ahead?.state === "unpublished"
        ? `No registry here lists ${row.name}. Publishing pushes this package's own directory to ${chosen() || "the configured registry"}, where every installation that mirrors it can reach it.`
        : row.ahead
          ? `${row.ahead.version} is here and ${row.ahead.published} is what ${row.ahead.registry} holds. Publishing is what closes that gap; nothing else in the product does.`
          : `Publishing pushes this package's own directory to ${chosen() || "the configured registry"}. The version has to move past what that registry already holds, so pick a bump unless you have already moved it here.`
    );
    if (takeOut) hints.push(`Take out of ${chosen() || "the registry"} deletes this package's directory from it and pushes that. The package leaves the marketplace index at the next refresh, and every installation that already has it keeps it, goes on running it, and is not told: it is not a recall, and nothing in the product puts it back.`);
    if (offer.error) hints.push(`The registries could not be read just now (${offer.error}), so the versions above may be missing. Publish checks again before it asks you to confirm.`);
  }

  return { buttons, adminButtons, adminHints, hints, picker, publish };
}

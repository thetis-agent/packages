/* The actions an extension's page offers, and the confirm popover in front of each, in the words of the
 * contract every screen shares (state.js):
 *
 * - For anyone: **Install**, or **Installed ✓ ▾** once it is theirs, whose menu holds **Remove for me** (its
 *   confirm offers "Also delete my saved settings") and, for a copy, **Use Thetis's version**. **Remove for me**
 *   is a button beside it as well, and **Set up** is there while something is missing (**Settings** once
 *   nothing is). **Update** when
 *   a newer version of what they run is ready: it goes through the page's one updater (updates-notice.js),
 *   which fetches, applies, waits for the space to come back and refreshes; a running reply pauses at a safe
 *   point and continues. **Use Thetis's version** leads for a copy the official version has moved past, and the
 *   page says what it replaces. An extension Thetis requires has no Remove of any kind: the button area says
 *   "Required by Thetis". One only an admin may have, one that runs inside Thetis itself, and -- for a person
 *   who is not an admin -- one of Thetis's own parts they do not have, have no Install.
 * - Behind **⋯**: **Delete files…** for a copy under the person's home, **Publish…** for extensions whose files
 *   are theirs, and **Copy technical id (<id>)**.
 * - For an admin, in the side panel's **For everyone**: what state.js's `everyoneActions` answers -- **Turn on
 *   for everyone…**, **Turn off for everyone…**, **Share with everyone…**, **Remove for everyone…** (naming the
 *   people who lose it) -- each with its one-line hint, the table's lines ("Already shared with everyone as
 *   Notion." with **Open it**), and a person picker: "sam (has it)" gives **Remove for sam…**, anyone else
 *   **Install for sam**. For an extension only admins may have, the picker lists admins only.
 *
 * Publishing -- with the packages already on the branch that a push would carry with it, ticked one by one or
 * named as the reason it cannot go, and, for a fork whose origin the registry already holds, the two
 * publishes it could be -- and Take out of a registry live on the Details tab.
 *
 * Every popover states the facts a person should read first and one sentence on what happens next; nothing is
 * sent until they confirm. After an action the place is re-opened on the page, or on the store when the
 * extension is gone from here. A failure is said in plain words -- "Exa Web Search is no longer installed for
 * you." when somebody else removed it meanwhile -- and the page is read again, so what it shows is true.
 *
 * A person's own copy of somebody else's extension stays theirs: an admin is not offered to install it for
 * someone else, and reads instead "This is your own copy. To give sam this extension, use Thetis's version:"
 * with **Open** of the official one. A copy's page offers **Show changes** beside what it changed. */

import { ADMIN_ONLY, WORDS, baseOf, everyoneActions, isAdminOnly, isCopy, isPromoted, isRequired, kindsOf, listOf, needText, needsOf, originNameOf, ownerWord, publisherShort, runsInsideThetis, scopeOf, sharedCopyOf, switchTitle, titleCase, useOriginLabel } from "./state.js";
import { isBusy, lostGateway, updater } from "./updates-notice.js";
import { expectChange, unexpectChange } from "./watch.js";

/**
 * A failure in plain words. The extension is read again first, because a failure is very often somebody else's
 * change: an admin removed it for the person meanwhile ("Exa Web Search is no longer installed for you."), or
 * installed it ("… is already installed for you."). `installed` is whether the act took it to be installed.
 * Answers the sentence; the raw text is kept only when nothing plainer is known.
 */
export async function plainFailure(ext, err, { name, label, installed = true }) {
  if (isBusy(err)) return "A reply is running; try again when it is done.";
  const raw = String(err?.message ?? "").replace(/^Error:\s*/, "");
  let now;
  try {
    now = (await ext.request("show", { args: { name } }))?.data?.row ?? null;
  } catch {
    now = undefined;
  }
  if (now === undefined && /is not installed here, not shipped here/.test(raw)) return `${label} is no longer here.`;
  if (now && installed && !now.installed) return `${label} is no longer installed for you.`;
  if (now && !installed && now.installed) return `${label} is already installed for you.`;
  return raw ? `That did not work: ${raw.charAt(0).toLowerCase()}${raw.slice(1)}${/[.!?]$/.test(raw) ? "" : "."}` : "That did not work.";
}

/** Says a failure plainly, then reads the page again (it may no longer be true), saying what changed under it. */
async function failed(ext, err, { name, label, installed = true, reopen = name }) {
  const text = await plainFailure(ext, err, { name, label, installed });
  ext.toast(text, { tone: "error" });
  unexpectChange();
  ext.open.place("marketplace", reopen ? { name: reopen } : {});
}

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

/** A system package installs by name, already built; a copy in the person's folder by its path; anything else by its registry source. */
const sourceOf = (row) => (row.system ? row.name : row.folder && !row.installed ? row.folder.dir : row.source);

/** One sentence per kind an extension brings, the first two. */
const BRINGS = {
  Tools: "Its tools are offered to your assistant from your next message.",
  Skills: "Its skills are offered to your assistant from your next message.",
  Page: "It appears on the page after a refresh.",
  Models: "Its models are yours to pick from your next message.",
  Background: "It starts working from your next message.",
};

/**
 * What installing an extension does for the person: said from what it brings rather than from its type, so an
 * extension with no tools never promises tools. Takes a row, or a bare type for an older caller.
 */
export function whatItBrings(row) {
  const r = typeof row === "string" ? { type: row } : (row ?? {});
  const kinds = kindsOf(r).slice(0, 2);
  if (!kinds.length) return "It works from your next message.";
  return kinds.map((k) => BRINGS[k]).join(" ");
}

/** How an install gets its files, in one sentence: nothing to download for what is already here. */
export const howItInstalls = (row, whom = "you") => (row.system ? "Nothing to download." : row.folder && !row.installed ? "It is built from your folder, which can take a minute." : `It is downloaded and built for ${whom}, which can take a minute.`);

/**
 * Installs `row` in place of `inUse`, the member of the same family the person uses now: the confirm says
 * "<X> replaces <Y> for you. Everyone else keeps <Y>.", then X is installed and Y removed for them. With no
 * `inUse` it is a plain Install. `x`/`y` are the two labels, told apart by how each stands to the person when
 * they are the same word. Shared by the page's own button and the Other versions rows.
 */
export async function useInstead(ext, anchor, { row, label, relation = "", inUse = null, inUseLabel = "", inUseRelation = "the one you use" }) {
  const use = !!inUse && inUse.name !== row.name;
  const x = use && label === inUseLabel ? `${label} (${relation.split(" · ")[0]})` : label;
  const y = use && label === inUseLabel ? `${inUseLabel} (${inUseRelation || "the one you use"})` : inUseLabel;
  const source = row.system ? row.name : row.folder && !row.installed ? row.folder.dir : row.source;
  const how = howItInstalls(row);
  const ok = await ext.ui.confirm(anchor, {
    title: use ? switchTitle(label, relation) : `Install ${label}?`,
    lines: [["extension", `${label} ${row.version}`], ["for", "you"]],
    note: use ? `${x} replaces ${y} for you. Everyone else keeps ${y}. ${how}` : `${how} ${whatItBrings(row)}`,
    confirmLabel: use ? "Switch" : "Install",
  });
  if (!ok) return;
  expectChange();
  try {
    const out = await ext.request("install", { args: { source } });
    const now = out?.data?.name ?? row.name;
    if (use && inUse.name !== now) await ext.request("remove", { args: { name: inUse.name } }).catch(() => null);
    ext.toast(use ? `You use ${label} now. Everyone else keeps ${inUseLabel}.` : `${label} is installed.`, { tone: "good" });
    ext.open.place("marketplace", { name: now });
  } catch (err) {
    await failed(ext, err, { name: row.name, label, installed: false });
  }
}

/** The types nothing installs for a person, each with why. The page offers no Install for these and says this instead. */
export const NOT_INSTALLABLE = {
  host: `${WORDS.inside}.`,
  storage: `${WORDS.inside}.`,
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

/** The button words of the admin's acts for everyone, and each one's tone: the destructive one last and amber. */
const EVERYONE_ACTS = {
  turnOn: { text: "Turn on for everyone…", tone: "quiet" },
  turnOff: { text: "Turn off for everyone…", tone: "quiet" },
  share: { text: "Share with everyone…", tone: "quiet" },
  removeEveryone: { text: "Remove for everyone…", tone: "warn" },
};

/**
 * The page's actions for one extension. `view` is `{ row, family, user, role, people, holders, publish, state,
 * label, origin, publisher, config }`. Answers the nodes the page places: `primary` (the leading buttons),
 * `required` (the "Required by Thetis" line, or null), `more` (the ⋯ button), for the side panel's For everyone
 * `adminActs` (`[{ button, hint }]`), `adminLines`, `openShared` (Open it, for the original of a shared copy)
 * and `picker`, `hints` (the sentences under the buttons), and the Publish block with its own hints for the
 * Details tab. `onPublish` is how ⋯ → Publish… shows that tab.
 */
export function actionsFor(ext, view, host, { onPublish = null, onSettings = null } = {}) {
  const { el } = ext.dom;
  const { button, busy, confirm } = ext.ui;
  const { row, user, role, people } = view;
  const admin = role !== "user";
  const primary = [];
  const adminActs = [];
  const adminLines = [];
  const hints = [];
  const publishHints = [];
  const label = view.label ?? titleCase(row.label ?? row.name);
  const family = view.family ?? [];
  const required = isRequired(row);
  const inside = runsInsideThetis(row);
  const needs = needsOf(row);
  const holders = Array.isArray(view.holders) ? view.holders : null;

  const go = (name, extra = {}) => ext.open.place("marketplace", name ? { name, ...extra } : {});

  /**
   * Runs one command behind its popover. A failure is said plainly and the page is read again. Whatever the act
   * changes for the reader is their own doing, so the place does not announce it back to them. `installed` is
   * whether the act took the extension to be theirs already.
   */
  async function run(anchor, popover, busyText, send, after, { installed = !!row.installed } = {}) {
    const ok = await confirm(anchor, popover);
    if (!ok) return;
    expectChange();
    const stop = busy(host, busyText);
    try {
      const out = await send();
      await after(out?.data ?? {});
    } catch (err) {
      stop();
      await failed(ext, err, { name: row.name, label, installed });
    } finally {
      stop();
    }
  }

  /**
   * Into the person's own space. The popover says which of the installs this is, because they cost different
   * things: one that is already here needs nothing downloaded, a copy in the person's folder is built from
   * there, and a registry's offer is downloaded and built. Something with required keys says it is set up
   * next, and the page opens on its Settings once it is in.
   */
  function installMe(anchor) {
    const next = needs.length ? ` You'll set it up next: ${listOf(needs.map(needText))}.` : "";
    return run(
      anchor,
      { title: `Install ${label}?`, lines: [["extension", `${label} ${row.version}`], ["from", publisherShort(row, { user, family: [row, ...family] })], ["for", "you"]].filter(([, v]) => v), note: `${howItInstalls(row)} ${whatItBrings(row)}${next}`, confirmLabel: "Install" },
      row.system ? "Installing…" : "Installing… this can take a minute.",
      () => ext.request("install", { args: { source: sourceOf(row) } }),
      (r) => {
        ext.toast(`${label} is installed.${needs.length ? " Set it up next." : ""}`, { tone: "good" });
        go(r.name ?? row.name, needs.length ? { tab: "settings" } : {});
      },
      { installed: false }
    );
  }

  /** What going back to the official version does to this copy, in the words the page and the confirm share. */
  const official = originNameOf(row);
  const whose = ownerWord(official, user);
  const officialVersion = view.state?.behind?.to ?? row.fork?.shipped ?? null;
  const officialWords = whose === "your" ? "your original" : `${whose}${officialVersion ? ` ${officialVersion}` : " version"}`;
  const replaceLine = `${useOriginLabel(row, user)} replaces your changes with ${officialWords}. Your copy's files stay in your folder.`;

  /**
   * Puts a person's copy back on the extension it was copied from, then applies, the same as an update. The
   * page's updater does it when there is one, so the card and this button are one act. The copy a person is
   * most likely to hold is the web gateway, which serves this page, so the request carrying the click can die
   * with it: that lost answer is the success, and the page waits for the official version to answer instead.
   * The copy's files stay in the person's folder; Delete files… is what removes them.
   */
  async function unforkMe(anchor) {
    const origin = row.update?.origin ?? official;
    const act = useOriginLabel(row, user);
    const changed = Array.isArray(row.changed) && row.changed.length ? ` Your changes to ${row.changed.length === 1 ? row.changed[0] : `${row.changed.length} files`} stop being used.` : "";
    const ok = await confirm(anchor, {
      title: `${act}?`,
      lines: [["your copy", label], ["goes back to", officialWords], ["your files", "kept in your folder"]],
      note: `${replaceLine}${changed} Delete files… is what removes them.`,
      confirmLabel: act,
      tone: "warn",
    });
    if (!ok) return;
    expectChange();
    const u = updater();
    if (u) return void (await u.switchBack([{ name: row.name, label, origin, state: row.update?.identical ? "identical" : "superseded" }]));
    const stop = busy(host, "Going back to the official version…");
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
      stop();
      await failed(ext, err, { name: row.name, label });
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
      stop();
      await failed(ext, err, { name: row.name, label });
    } finally {
      stop();
    }
  }

  /**
   * Out of the person's own space. The files stay; the saved settings stay unless the person ticks "Also
   * delete my saved settings", which clears each key of their own layer after the extension is gone.
   */
  async function removeMe(anchor) {
    const back = row.replaced ? ` ${row.replaced} comes back in its place.` : "";
    const others = row.everyone ? " Everyone else keeps it." : "";
    const tick = el("input", { type: "checkbox", class: "mk-tick" });
    const note = el("span", { class: "mk-confirm-note" }, `What it brings stops from your next message. Install puts it back.${others}${back}`, el("label", { class: "mk-confirm-tick" }, tick, " Also delete my saved settings"));
    const ok = await confirm(anchor, { title: `Remove ${label} for you?`, lines: [["extension", label], ["for", "you"]], note, confirmLabel: "Remove for me", tone: "warn" });
    if (!ok) return;
    const wipe = tick.checked;
    // Removing what is already gone succeeds without a word from the kernel; say plainly that it had gone.
    const now = await ext.request("show", { args: { name: row.name } }).then((o) => o?.data?.row ?? null, () => null);
    if (now && !now.installed) {
      ext.toast(`${label} is no longer installed for you.`, { tone: "error" });
      unexpectChange();
      return void go(row.name);
    }
    expectChange();
    const stop = busy(host, "Removing…");
    try {
      let cleared = 0;
      if (wipe) {
        // Read before the removal: the report of a package that is gone may not be given.
        const report = (await ext.request("config-show", { args: { name: row.name } }).catch(() => null))?.data;
        const mine = (report?.keys ?? []).filter((k) => k.source === "user" && !k.inheritedFrom);
        for (const k of mine) {
          await ext.request("config-unset", { args: { name: row.name, key: k.key } });
          cleared += 1;
        }
      }
      await ext.request("remove", { args: { name: row.name } });
      ext.toast(`${label} is removed for you. ${wipe ? (cleared ? "Your saved settings are deleted." : "You had no saved settings.") : "Your settings are kept."}`, { tone: "good" });
      go(row.available || row.system || row.folder ? row.name : row.replaced || null);
    } catch (err) {
      stop();
      await failed(ext, err, { name: row.name, label });
    } finally {
      stop();
    }
  }

  function del(anchor) {
    return run(
      anchor,
      { title: `Delete the files of ${label}?`, lines: [["extension", row.name], originNameOf(row) && ["copy of", originNameOf(row)], ["comes back", row.replaced || "nothing"]].filter(Boolean), note: "This deletes its folder under packages/ in your home, and takes it out of your space. It cannot be undone from here.", confirmLabel: "Delete files", tone: "warn" },
      "Deleting…",
      () => ext.request("delete", { args: { name: row.name } }),
      (r) => {
        ext.toast(r.restored ? `${label} was deleted. ${r.restored} is back in place.` : `${label} was deleted.`, { tone: "good" });
        go(r.restored || null);
      }
    );
  }

  function installFor(anchor, who) {
    return run(
      anchor,
      { title: `Install ${label} for ${who}?`, lines: [["extension", `${label} ${row.version}`], ["for", who]], note: `${howItInstalls(row, "them")} They have it from their next message; a reply of theirs that is running keeps going without it until it ends.`, confirmLabel: `Install for ${who}` },
      `Installing for ${who}… this can take a minute.`,
      () => ext.request("install-for", { args: { user: who, source: sourceOf(row) } }),
      () => {
        ext.toast(`${label} is installed for ${who}.`, { tone: "good" });
        go(row.name);
      }
    );
  }

  function removeFor(anchor, who) {
    return run(
      anchor,
      { title: `Remove ${label} for ${who}?`, lines: [["extension", label], ["for", who]], note: WORDS.removeForNote, confirmLabel: `Remove for ${who}`, tone: "warn" },
      `Removing for ${who}…`,
      () => ext.request("remove-for", { args: { user: who, name: row.name } }),
      () => {
        ext.toast(`${label} is removed for ${who}. Their settings are kept.`, { tone: "good" });
        go(row.name);
      }
    );
  }

  /** The keys it needs that nobody has set for everyone, from the admin's own report when there is one. */
  const unsetForEveryone = () => needs.filter((n) => {
    const k = (view.config?.keys ?? []).find((x) => x.key === n.key);
    return !k || !(k.state === "set" && (k.source === "system" || k.source === "file"));
  });

  /**
   * Every person gets it, now and later. On an extension by Thetis the extension is marked and linked into
   * every person; on a registry's offer it is first installed for the admin and made part of Thetis. When it
   * needs a key nobody has set for everyone, the confirm says so and what to do about it.
   */
  function turnOn(anchor) {
    const missing = unsetForEveryone();
    const key = missing.length ? ` It needs ${listOf(missing.map(needText))}. Nobody has one yet: set one for everyone first, or each person sets their own.` : "";
    return run(
      anchor,
      row.system
        ? { title: `Turn on ${label} for everyone?`, lines: [["extension", `${label} ${row.version}`], ["for", "everyone, now and later"]], note: `Every person has it from their next message, and every new person starts with it. Anyone can still remove it for themselves.${key}`, confirmLabel: "Turn on for everyone" }
        : { title: `Turn on ${label} for everyone?`, lines: [["extension", `${label} ${row.version}`], ["from", row.registry || "a source"], ["for", "everyone, now and later"]], note: `It is downloaded, becomes part of Thetis, and every person has it now and later.${key}`, confirmLabel: "Turn on for everyone" },
      row.system ? "Turning it on for everyone…" : "Turning it on for everyone… this can take a minute.",
      () => ext.request("install-everyone", { args: { source: sourceOf(row) } }),
      (r) => {
        ext.toast(`${label} is on for everyone (${count(r.userspaces?.length ?? 0)}).${forksNote(r)}`, { tone: r.forks?.length ? "warn" : "good" });
        go(r.name ?? row.name);
      }
    );
  }

  /** The mark comes off. Nobody loses the extension: new people stop getting it, and that is all. */
  function turnOff(anchor) {
    return run(
      anchor,
      { title: `Turn off ${label} for everyone?`, lines: [["extension", label]], note: WORDS.turnOffHint, confirmLabel: "Turn off for everyone", tone: "warn" },
      "Turning it off for everyone…",
      () => ext.request("unmark-everyone", { args: { name: row.name } }),
      () => {
        ext.toast(`${label} is off for everyone. People who have it keep it.`, { tone: "good" });
        go(row.name);
      }
    );
  }

  /** The admin's own extension becomes a shared copy under @thetis that everyone gets. */
  function share(anchor) {
    const shared = `@thetis/${baseOf(row.name)}`;
    return run(
      anchor,
      { title: `Share ${label} with everyone?`, lines: [["extension", label], ["for", "everyone, now and later"]], note: `Everyone gets a shared copy named ${label}. Your own stays yours.`, confirmLabel: "Share with everyone" },
      "Sharing with everyone…",
      () => ext.request("promote", { args: { user, name: row.name } }),
      (r) => {
        ext.toast(`${label} is shared with everyone (${count(r.userspaces?.length ?? 0)}).${forksNote(r)}`, { tone: r.forks?.length ? "warn" : "good" });
        go(r.name ?? shared);
      }
    );
  }

  /**
   * Out of every person's space. The confirm names who loses it, read again before the popover opens; nothing
   * is removed until the admin agrees. What decides whether new people still get it is said too, plainly,
   * because removing is not the same as turning off -- and a shared copy cannot be stopped from here.
   */
  async function removeEveryone(anchor) {
    let users = holders ?? [];
    const reading = busy(host, "Finding who has it…");
    try {
      users = (await ext.request("holders", { args: { name: row.name } }))?.data?.users ?? users;
    } catch (err) {
      return ext.toast(err?.message || "That did not work.", { tone: "error" });
    } finally {
      reading();
    }
    if (!users.length && !(row.everyone && row.everyoneBy === "marked")) return ext.toast(`Nobody has ${label}.`, { tone: "warn" });
    const still = row.everyone && row.everyoneBy === "config"
      ? " New people still get it: the server's settings give it to everyone."
      : isPromoted(row)
        ? ` It stays shared: every new person still gets it. ${WORDS.cantStopSharing.split(";")[0]}.`
        : row.everyone
          ? " It is turned off for everyone too, so new people stop getting it."
          : "";
    // "you", never the reader's own id.
    const names = (list) => listOf(list.map((u) => (u === user ? "you" : u)));
    return run(
      anchor,
      { title: `Remove ${label} for everyone?`, lines: [["extension", label], ["people who lose it", users.length ? names(users) : "nobody has it now"]], note: `It is taken away from ${users.length ? names(users) : "nobody"} now, from their next message. Their saved settings are kept.${still}`, confirmLabel: "Remove for everyone", tone: "warn" },
      "Removing for everyone…",
      () => ext.request("remove-everyone", { args: { name: row.name } }),
      (r) => {
        const notFor = r.failed?.length ? ` Not for ${names(r.failed.map((f) => f.user))}: ${r.failed[0].error}` : "";
        ext.toast(`${label} is removed for ${r.removed?.length ? names(r.removed) : "nobody"}.${notFor}`, { tone: notFor ? "warn" : "good" });
        go(row.name);
      }
    );
  }

  const make = (text, tone, handler, title = null) => {
    const b = button(text, { tone, title });
    b.addEventListener("click", () => void handler(b));
    return b;
  };

  // ---- the person's own ----

  let installedBtn = null;
  let settingsBtn = null;
  let offersInstall = false; // whether this page offers the person to take it, which is when its Needs line says anything
  const behind = !!view.state?.behind || !!view.superseded;
  // Somebody else's original of a copy everyone already has: nothing to take here, only the way to the shared one.
  const sharedCopy = sharedCopyOf(row, family);
  if (!row.installed) {
    if (inside) hints.push(`${WORDS.inside}.`);
    else if (!admin && isAdminOnly(row)) hints.push(ADMIN_ONLY.line);
    else if (!admin && row.component) hints.push("Part of Thetis. Your admin decides who has it.");
    else if (!admin && sharedCopy && scopeOf(row.name) !== user) {
      hints.push(`This is ${scopeOf(row.name)}'s original. Everyone gets the shared copy, ${titleCase(sharedCopy.label ?? baseOf(sharedCopy.name))}.`);
      primary.push(make("Open the shared copy", "quiet", () => go(sharedCopy.name)));
    } else if (view.inUse && view.inUse.name !== row.name) primary.push(make("Use instead", "primary", (b) => useInstead(ext, b, { row, label, relation: view.relation ?? "", inUse: view.inUse, inUseLabel: view.inUseLabel ?? "", inUseRelation: view.inUseRelation || "the one you use" })));
    else primary.push(make("Install", "primary", installMe));
    offersInstall = primary.some((b) => b.textContent === "Install" || b.textContent === "Use instead");
  } else {
    if (view.state?.update) primary.push(make("Update", "primary", updateMe));
    else if (behind && official) primary.push(make(useOriginLabel(row, user), "quiet", unforkMe));
    const menuItems = [
      official && !(behind && !view.state?.update) ? { label: useOriginLabel(row, user), run: () => void unforkMe(installedBtn) } : null,
      required ? null : { label: "Remove for me", hint: "Your saved settings are kept unless you say so", danger: true, run: () => void removeMe(installedBtn) },
    ].filter(Boolean);
    // "Installed ✓" is the state, drawn as the button that holds what can be done to it; a required extension has nothing to hold.
    installedBtn = button(menuItems.length ? "Installed ✓ ▾" : "Installed ✓", { tone: "quiet", title: menuItems.length ? "What you can do with it" : null });
    installedBtn.classList.add("mk-installed");
    if (menuItems.length) {
      installedBtn.setAttribute("aria-haspopup", "menu");
      installedBtn.addEventListener("click", () => ext.ui.menu?.(installedBtn, menuItems));
    } else installedBtn.disabled = true;
    primary.push(installedBtn);
    // A copy the official version moved past: what using it does.
    if (behind && official) hints.push(replaceLine);
  }
  // Set up while something is missing, Settings once nothing is; the page hides it while its Settings tab is shown.
  if (row.installed && onSettings && view.hasSettings) {
    const missing = !!view.state?.setup?.chip;
    settingsBtn = make(missing ? "Set up" : "Settings", !admin && missing ? "primary" : "quiet", () => onSettings(), missing ? "Set what it needs before it works" : "Your own values for this extension");
    primary.push(settingsBtn);
  }
  // Remove for me in plain sight, not only in the menu; last, so it is never the first thing a thumb meets.
  if (row.installed && !required) primary.push(make("Remove for me", "quiet", removeMe));
  // What a copy changed, with the way to see it.
  const changes = row.installed && isCopy(row) && Array.isArray(row.changed) && row.changed.length ? changesBlock() : null;
  if (changes) hints.push(changes);

  // ⋯: the files, publishing, and the id -- the technical things, out of the way of the person's own act.
  const mine = row.local || row.own || scopeOf(row.name) === user;
  const canPublish = row.installed && view.publish?.available && (mine || (admin && row.system && !isPromoted(row)));
  const moreItems = [
    row.local && row.installed ? { label: "Delete files…", danger: true, run: () => void del(more) } : null,
    canPublish && onPublish ? { label: "Publish…", run: () => onPublish() } : null,
    { label: `Copy technical id (${row.name})`, run: () => { navigator.clipboard?.writeText(row.name).then(() => ext.toast(`Copied ${row.name}.`, { tone: "good" }), () => ext.toast(row.name)); } },
  ].filter(Boolean);
  const more = button("⋯", { tone: "quiet", title: "More" });
  more.classList.add("mk-more");
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-label", "More");
  more.addEventListener("click", () => ext.ui.menu?.(more, moreItems));

  // ---- for everyone: an admin's acts, about every person and never about this one ----

  let openShared = null;
  if (admin) {
    const table = everyoneActions(row, { family: [row, ...family], user, holders, origin: view.origin ?? null, label });
    // What runs inside Thetis says so once, under the buttons, and not again here.
    if (!inside) adminLines.push(...table.lines);
    const handlers = { turnOn, turnOff, share, removeEveryone };
    // The destructive one last, whatever order the table gave.
    const order = ["turnOn", "turnOff", "share", "removeEveryone"];
    for (const id of order.filter((a) => table.acts.includes(a))) adminActs.push({ button: make(EVERYONE_ACTS[id].text, EVERYONE_ACTS[id].tone, handlers[id]), hint: table.hints[id] ?? null });
    if (table.open) openShared = button("Open it", { tone: "quiet", onClick: () => go(table.open) });
  }

  // An admin installs for one person, or removes it for one who has it, from a picker: the people -- only the
  // admins for what only admins may have -- each marked when they have it, then a button naming the act.
  let picker = null;
  const mineRow = row.local || row.own || scopeOf(row.name) === user;
  // A person's own changed copy of somebody else's extension is theirs alone: the picker says where the shareable one is.
  const privateCopy = admin && row.installed && isCopy(row) && mineRow && !isPromoted(row) && !required && !inside && ownerWord(official, user) !== "your";
  const pickable = admin && !required && !inside && !openShared && !privateCopy && !!(row.source || row.system) && !(row.folder && !row.available);
  const others = (people || []).filter((p) => p.id !== user && (!isAdminOnly(row) || p.role === "admin"));
  if (privateCopy && others.length) {
    const select = el("select", { class: "input mk-person", "aria-label": "Person" }, ...others.map((p) => el("option", { value: p.id }, p.id)));
    const line = el("span", {}, WORDS.privateCopy(select.value, whose));
    select.addEventListener("change", () => {
      line.textContent = WORDS.privateCopy(select.value, whose);
    });
    const openIt = button(`Open ${label}`, { tone: "quiet", onClick: () => go(official) });
    picker = el("div", { class: "mk-private" }, select, el("p", { class: "panel-hint mk-private-line" }, line, " ", openIt));
  } else if (pickable && others.length) {
    const has = (id) => !!holders?.includes(id);
    const select = el("select", { class: "input mk-person", "aria-label": "Person" }, ...others.map((p) => el("option", { value: p.id }, has(p.id) ? `${p.id} (has it)` : p.id)));
    const b = button("", { tone: "quiet" });
    const name = () => (has(select.value) ? `Remove for ${select.value}…` : `Install for ${select.value}`);
    b.textContent = name();
    select.addEventListener("change", () => {
      b.textContent = name();
    });
    b.addEventListener("click", () => void (has(select.value) ? removeFor(b, select.value) : installFor(b, select.value)));
    picker = el("div", { class: "mk-picker" }, select, b);
  }

  const requiredLine = required && row.installed ? el("span", { class: "mk-required", title: "Nothing removes it, for anyone" }, WORDS.required) : null;

  /**
   * "You changed 1 file since 0.3.3: dist/src/index.js." with **Show changes**, which asks `changes` for the
   * whole list and, where the original file is still as it was copied, the lines themselves.
   */
  function changesBlock() {
    const files = row.changed;
    const base = row.fork?.version ?? row.forkedFrom?.version ?? null;
    const text = `You changed ${files.length === 1 ? "1 file" : `${files.length} files`}${base ? ` since ${base}` : ""}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}.`;
    const panel = el("div", { class: "mk-changes-body", hidden: true });
    const toggle = button("Show changes", { tone: "quiet" });
    let loaded = false;
    toggle.addEventListener("click", async () => {
      if (!panel.hidden) {
        panel.hidden = true;
        toggle.textContent = "Show changes";
        return;
      }
      if (!loaded) {
        toggle.disabled = true;
        try {
          const d = (await ext.request("changes", { args: { name: row.name } }))?.data ?? {};
          const list = Array.isArray(d.files) ? d.files : files;
          ext.dom.clear(panel);
          const parts = [
            el("ul", { class: "mk-changes-files" }, ...list.map((f) => el("li", {}, el("code", {}, f)))),
            d.diff
              ? el("pre", { class: "mk-diff", "aria-label": "What changed, line by line" }, ...d.diff.split("\n").map((l) => el("span", { class: l.startsWith("+") && !l.startsWith("+++") ? "is-add" : l.startsWith("-") && !l.startsWith("---") ? "is-del" : l.startsWith("@@") ? "is-hunk" : null }, `${l}\n`)))
              : el("p", { class: "panel-hint" }, `No line-by-line view: ${whose} version of ${list.length === 1 ? "this file" : "these files"} changed since your copy was made, or ${list.length === 1 ? "it is" : "they are"} not text.`),
            d.cut ? el("p", { class: "panel-hint" }, "Only the first 200 lines are shown.") : null,
          ];
          panel.append(...parts.filter(Boolean));
          loaded = true;
        } catch (err) {
          toggle.disabled = false;
          return void ext.toast(await plainFailure(ext, err, { name: row.name, label }), { tone: "error" });
        }
        toggle.disabled = false;
      }
      panel.hidden = false;
      toggle.textContent = "Hide changes";
    });
    return el("div", { class: "mk-changes" }, el("p", { class: "panel-hint mk-hint-line" }, text, " ", toggle), panel);
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
    // A registry of one scope publishes a person's own package under that scope, and a copy from their own
    // folder is then replaced here by what they published: sharing it is what they meant, and running the
    // version everybody else gets is the rest of that. Both are said before they agree.
    const renamed = preview.renamedFrom ? preview.package : null;
    const published = preview.package ?? row.name;
    const switching = !copy && row.installed && row.local;
    // This installation's promoted copy of the name being published: a second @thetis package of that name
    // with no pin, which everyone on it would never move off. An admin's publish retires it.
    const promotedCopy = admin ? [row, ...family].find((m) => m.name === published && m.everyoneBy === "promoted") : null;
    const ok = await confirm(anchor, {
      title: copy || renamed ? `Publish ${(copy ?? row).name} as ${published}?` : `Publish ${row.name}?`,
      lines: [
        ["package", `${preview.package ?? row.name}@${now}`],
        ["to", preview.url ? `${target} · ${preview.url}` : target || "the configured registry"],
        ["version", first ? `${now}, the first version ${target || "that registry"} would hold of it` : `${was} → ${now}`],
        preview.branch && ["branch", preview.branch],
        copy && ["your copy", `${copy.name}@${copy.version}, still a fork`],
        renamed && ["name", `${published}: ${target || "that registry"} takes ${published.split("/")[0]} packages only`],
        promotedCopy && ["for everyone", `the promoted ${published} here is retired: everyone on it moves to ${published}@${now}, and new people install it from ${target || "the registry"} until this installation ships it`],
        switching && ["then", renamed ? `your space runs ${published}@${now} with your settings, in place of ${row.name}; its files stay in your folder` : `your space runs ${published}@${now} from ${target || "the registry"}; your folder copy stays on disk`],
        // Never a count. A person agreeing to publish somebody else's work alongside their own reads the
        // names or they have not agreed to anything.
        also.length && ["also publishing", also.join(", ")],
      ].filter(Boolean),
      note: `${renamed ? `${target || "The registry"} gets it as ${published}; your folder copy keeps the name ${row.name}. ` : ""}${copy ? `What lands in ${target || "the registry"} is ${preview.package} itself, under its own name; ${copy.name} stays here exactly as it is, a fork at ${copy.version}. ` : ""}This pushes to a registry other installations read: everyone mirroring ${target || "it"} gets ${now} on their next refresh, and a version once published is not taken back.${also.length ? ` ${also.length === 1 ? "The package" : "The packages"} above ${also.length === 1 ? "is" : "are"} published in ${also.length === 1 ? "its" : "their"} own right, each one checked the same way.` : " Only this package's own directory is committed."}`,
      confirmLabel: `Publish ${now}`,
      tone: "warn",
    });
    if (!ok) return;
    const publishing = busy(host, `Publishing to ${target || "the registry"}…`);
    let done = false;
    // Once only: the switch that follows a publish ends this busy line itself, and so does the finally.
    const stop = () => done || ((done = true), publishing());
    try {
      const out = (await ext.request("publish", { args }))?.data ?? {};
      const at = out.commit ? ` (${String(out.commit).slice(0, 7)})` : "";
      const rode = also.length ? ` ${also.join(", ")} went with it.` : "";
      // Beside the result, because believing this wrongly means believing your own workspace moved when it
      // did not. `fork` is set by the publishing package only when the origin is what was published.
      const mine = out.fork ? ` Your copy is still ${out.fork.name} ${out.fork.version}, a fork.` : "";
      const said = [`${out.package ?? row.name}@${out.now ?? now} is in ${out.target ?? target}${at}.${rode}${mine}`];
      if ((!switching && !promotedCopy) || !out.commit) {
        ext.toast(said[0], { tone: "good" });
        return go(row.name);
      }
      // What follows a publish, each said once in one toast. The publish stands whatever happens after it.
      stop();
      const pinned = { url: out.url, directory: out.directory, commit: out.commit };
      let tone = "good";
      let landed = row.name;
      if (switching) {
        const moving = busy(host, `Switching your space to ${out.package ?? row.name}…`);
        try {
          const used = (await ext.request("use-published", { args: { name: row.name, package: out.package ?? row.name, ...pinned } }))?.data ?? {};
          said.push(`Your space now runs it.${used.settings?.length ? ` Your settings came with it (${used.settings.length}).` : ""}`);
          landed = out.package ?? row.name;
        } catch (err) {
          tone = "warn";
          said.push(`Switching your space to it did not work: ${err?.message || "no answer"}. ${row.name} is still installed.`);
        } finally {
          moving();
        }
      }
      if (promotedCopy) {
        const retiring = busy(host, `Moving everyone off the promoted ${published}…`);
        try {
          const r = (await ext.request("retire-promoted", { args: { name: published, ...pinned } }))?.data ?? {};
          const who = r.moved?.length ? `${r.moved.join(", ")} moved to it` : "nobody else was on it";
          if (r.retired) said.push(`The promoted copy is retired: ${who}.`);
          else {
            tone = "warn";
            said.push(`The promoted copy stays, because ${(r.failed ?? []).map((f) => `${f.user} (${f.error})`).join(", ")} could not be moved; ${who}.`);
          }
        } catch (err) {
          tone = "warn";
          said.push(`Retiring the promoted copy did not work: ${err?.message || "no answer"}.`);
        } finally {
          retiring();
        }
      }
      ext.toast(said.join(" "), { tone });
      go(landed);
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
  if (canPublish && offer?.available) {
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
    publishHints.push(
      row.ahead?.state === "unpublished"
        ? `No registry here lists ${row.name}. Publishing pushes this package's own directory to ${chosen() || "the configured registry"}, where every installation that mirrors it can reach it.`
        : row.ahead
          ? `${row.ahead.version} is here and ${row.ahead.published} is what ${row.ahead.registry} holds. Publishing is what closes that gap; nothing else in the product does.`
          : `Publishing pushes this package's own directory to ${chosen() || "the configured registry"}. The version has to move past what that registry already holds, so pick a bump unless you have already moved it here.`
    );
    if (takeOut) publishHints.push(`Take out of ${chosen() || "the registry"} deletes this package's directory from it and pushes that. The package leaves the marketplace index at the next refresh, and every installation that already has it keeps it, goes on running it, and is not told: it is not a recall, and nothing in the product puts it back.`);
    if (offer.error) publishHints.push(`The registries could not be read just now (${offer.error}), so the versions above may be missing. Publish checks again before it asks you to confirm.`);
  }


  return { primary, more, required: requiredLine, adminActs, adminLines, openShared, hints, picker, publish, publishHints, settingsBtn, offersInstall };
}

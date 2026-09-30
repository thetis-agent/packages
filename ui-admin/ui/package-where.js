/* Who has an extension, and where it runs. The Overview's card is a list of people, one line each: the person
 * and their state in a few words ("bitmuse (you) · needs setup", "sam · has it", "carl · doesn't have it"), and
 * the one action that fits: Remove for <person>… (Remove for me… on the reader's own line) for someone who has it
 * (never on an extension Required by Thetis), Install for <person> for someone who does not (only admins, for an
 * extension only admins can have; nobody, for one that runs inside Thetis itself; nobody, for a customized copy,
 * which is its owner's alone: "This is your own copy. To give sam this extension, use Thetis's version: [Open
 * Tool Exec]"; nobody, for the original of a shared copy, whose shared copy is what people get), and a ⋯ with
 * their settings and their activity. The footer counts ("2 of 3 have it", "1 person
 * is waiting for a reload") and holds what is done about everybody (the page's `everyoneTail`: Remove for
 * everyone…, or why there is none). The Advanced tab's Where it runs shows the same list at full width and,
 * under it, a table of everyone with what their workspace runs. There is no restart button here: applying
 * updates is one action for everyone, on the extensions pages. All of it is `package-where`'s answer; a person
 * the answer does not know is not shown. */

import { stateBadge } from "./words.js";
import { agentName, labelOf, scopeOf, titleCase, WORDS } from "./state.js";

/** The Remove-for-one-person confirm, the same words in the Extensions place (`WORDS.removeForNote`): `{ title, note }`. */
export function removeForWords(label, who, me) {
  if (who === me) return { title: `Remove ${label} for you?`, note: "Your settings are kept. It stops for you from your next message. Everyone else keeps it." };
  return { title: `Remove ${label} for ${who}?`, note: WORDS.removeForNote };
}

/** "1 person is waiting for a reload", or null. */
const waitingLine = (n) => (n ? `${n} ${n === 1 ? "person is" : "people are"} waiting for a reload` : null);

/** The few words beside a person's name: what is worth knowing about theirs. */
export function personSummary(p) {
  if (!p.installed) return "doesn't have it";
  if (p.config?.broken) return "needs setup";
  if (p.forkedFrom) return "uses a customized copy";
  if (p.loaded?.state === "update") return "waiting for a reload";
  return "has it";
}

/** The person list. `full` widens it for the Advanced tab. */
export function whereCard(ext, ctx, { alive, full = false } = {}) {
  const { el, clear } = ext.dom;
  const { button, card, put } = ext.ui;
  const where = ctx.where;
  const body = el("div", { class: "ua-where-body" });
  const head = el("span", { class: "ua-card-title" }, "Who has it", ctx.tag("admin"));
  const node = card(head, body);
  node.classList.add("ua-where");
  if (full) node.classList.add("is-full");
  if (!where || !Array.isArray(where.people) || !where.people.length) {
    put(body, el("p", { class: "text-faint" }, where ? "Nobody has been added yet." : "Who has this extension could not be read."));
    return node;
  }
  const people = where.people;
  const counts = where.counts ?? {};
  const label = ctx.label ?? ctx.name;
  const info = ctx.info;
  // A customized copy is its owner's alone: nobody is offered it for another person.
  const privateCopy = Boolean(info?.forkedFrom) && scopeOf(ctx.name) !== "thetis";
  // The place's sentence for the reader's own copy; another person's copy is said as theirs.
  const privateLine = (person, whose) => (scopeOf(ctx.name) === ctx.user ? WORDS.privateCopy(person, whose) : `This is ${scopeOf(ctx.name)}'s own copy. To give ${person} this extension, use ${whose} version:`);

  function actionsFor(p) {
    const out = [];
    if (ctx.inside) return out;
    if (p.installed) {
      // Thetis cannot work without a Required extension: there is no Remove of any kind for it.
      if (!ctx.required) {
        const words = removeForWords(label, p.user, ctx.user);
        const mine = p.user === ctx.user;
        const remove = button(mine ? "Remove for me…" : `Remove for ${p.user}…`, { tone: "warn", onClick: () => void ctx.act(remove, { verb: "package-remove", args: { user: p.user }, title: words.title, lines: [], note: words.note, confirmLabel: mine ? "Remove for me" : `Remove for ${p.user}`, tone: "warn" }) });
        out.push(remove);
      }
      const more = button("⋯", { title: `${p.user}'s settings and activity` });
      more.setAttribute("aria-label", `More for ${p.user}`);
      more.addEventListener("click", () => ext.ui.menu?.(more, [
        { label: `${p.user === ctx.user ? "Your" : `${p.user}'s`} settings`, run: () => ctx.show("configuration", { layer: p.user }) },
        { label: `${p.user === ctx.user ? "Your" : `${p.user}'s`} activity`, run: () => ctx.show("activity", { actor: p.user }) },
      ]));
      out.push(more);
    } else if (!privateCopy && !info?.sharedAs && (!ctx.adminOnly || p.role === "admin")) {
      const install = button(`Install for ${p.user}`, { onClick: () => void ctx.act(install, { verb: "package-install-for", args: { user: p.user }, title: `Install ${label} for ${p.user}?`, lines: [], note: "It is theirs from their next message.", confirmLabel: `Install for ${p.user}` }) });
      out.push(install);
    }
    for (const b of out) b.classList.add("is-sm");
    return out;
  }

  function draw() {
    clear(body);
    const rows = people.map((p) =>
      el(
        "li",
        { class: `ua-person-line${p.installed ? " is-on" : ""}`, "data-user": p.user },
        el("span", { class: "ua-person-who" }, el("b", {}, p.user === ctx.user ? `${p.user} (you)` : p.user), el("span", { class: p.config?.broken ? "ua-err" : "text-faint" }, ` · ${personSummary(p)}`)),
        el("span", { class: "ua-person-acts" }, ...actionsFor(p))
      )
    );
    const waiting = counts.waiting ?? people.filter((x) => x.installed && x.loaded?.state === "update").length;
    const nobodyElse = ctx.adminOnly && people.some((p) => !p.installed && p.role !== "admin");
    const others = people.filter((p) => !p.installed && p.user !== ctx.user);
    // The official version a private copy was made from, which is what to give anyone else.
    const official = privateCopy ? info.forkedFrom.name : null;
    const officialLabel = official ? titleCase(info.origin?.label ?? labelOf({ name: official })) : "";
    const openOfficial = official && ctx.open ? button(`Open ${officialLabel}`, { onClick: () => ctx.open(official) }) : null;
    openOfficial?.classList.add("is-sm");
    const tail = ctx.everyoneTail?.() ?? [];
    put(
      body,
      el("ul", { class: "ua-person-list" }, ...rows),
      ctx.inside ? el("p", { class: "text-faint" }, `Runs inside ${agentName()} itself: nobody installs or removes it.`) : nobodyElse ? el("p", { class: "text-faint" }, "Only admins can have this.") : null,
      privateCopy && others.length ? el("p", { class: "text-faint ua-where-private" }, `${privateLine(others.length === 1 ? others[0].user : "someone else", official.startsWith("@thetis/") ? `${agentName()}'s` : "the original")} `, openOfficial) : null,
      el(
        "div",
        { class: "ua-where-foot" },
        el("span", {}, el("b", {}, String(counts.installed ?? people.filter((x) => x.installed).length)), ` of ${counts.people ?? people.length} have it`),
        waiting ? el("span", { class: "ua-warn" }, waitingLine(waiting)) : null,
        counts.forks ? el("span", {}, el("b", {}, String(counts.forks)), ` customized ${counts.forks === 1 ? "copy" : "copies"}`) : null,
        counts.broken ? el("span", {}, el("b", { class: "ua-err" }, String(counts.broken)), ` ${counts.broken === 1 ? "needs" : "need"} setup`) : null
      ),
      tail.length ? el("div", { class: "ua-where-everyone" }, ...tail) : null
    );
  }

  draw();
  return node;
}

/** The tab: the card at full width, then everyone in a table. */
export function mountWhere(ext, host, ctx) {
  const { el } = ext.dom;
  const { badge, table } = ext.ui;
  let alive = true;
  host.append(whereCard(ext, ctx, { alive: () => alive, full: true }));
  const people = ctx.where?.people ?? [];
  if (people.length) {
    host.append(
      el(
        "div",
        { class: "card ua-where-table" },
        el("div", { class: "card-head" }, "Everyone"),
        table(
          [
            { key: "user", label: "Person", render: (p) => el("span", {}, el("b", {}, p.user), " ", el("span", { class: "text-faint" }, p.role)) },
            { key: "version", label: "Version", render: (p) => (p.installed ? el("span", {}, el("code", {}, p.version ?? "?"), p.forkedFrom ? [" ", badge("customized copy", "dim")] : null) : el("span", { class: "text-faint" }, "doesn't have it")) },
            { key: "loaded", label: "In service", render: (p) => (p.installed && p.loaded?.openedAt ? stateBadge(ext, p.loaded.state) : el("span", { class: "text-faint" }, p.installed ? "not open" : "—")) },
            { key: "service", label: "Service", render: (p) => (Array.isArray(p.services) && p.services.includes(ctx.name) ? "running" : el("span", { class: "text-faint" }, "—")) },
            { key: "config", label: "Setup", render: (p) => (!p.installed ? el("span", { class: "text-faint" }, "—") : p.config ? (p.config.broken ? el("span", { class: "ua-err" }, "needs setup") : el("span", { class: "ua-ok" }, "nothing missing")) : el("span", { class: "text-faint" }, "not read")) },
          ],
          people,
          { rowKey: (p) => p.user }
        )
      )
    );
  }
  return () => {
    alive = false;
  };
}

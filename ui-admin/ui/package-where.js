/* Who has an extension, and where it runs. The Overview's card is a list of people, one line each: the person
 * and their state in a few words ("bitmuse · needs setup", "sam · has it", "carl · doesn't have it"), and the one
 * action that fits: Remove for <person>… for someone who has it (never on an extension Required by Thetis), Install
 * for <person> for someone who does not (only admins, for an extension only admins can have; nobody, for one that
 * runs inside Thetis itself), and a ⋯ with their settings and their activity. The footer counts ("2 of 3 have
 * it", "1 person hasn't applied it yet"). The Advanced tab's Where it runs shows the same list at full width and,
 * under it, a table of everyone with what their workspace runs. There is no restart button here: applying
 * updates is one action for everyone, on the extensions pages. All of it is `package-where`'s answer; a person
 * the answer does not know is not shown. */

import { stateBadge, waitingSentence } from "./words.js";

/** The few words beside a person's name: what is worth knowing about theirs. */
export function personSummary(p) {
  if (!p.installed) return "doesn't have it";
  if (p.config?.broken) return "needs setup";
  if (p.forkedFrom) return "uses a customised copy";
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

  function actionsFor(p) {
    const out = [];
    if (ctx.inside) return out;
    if (p.installed) {
      // Thetis cannot work without a Required extension: there is no Remove of any kind for it.
      if (!ctx.required) {
        const remove = button(`Remove for ${p.user}…`, { tone: "warn", onClick: () => void ctx.act(remove, { verb: "package-remove", args: { user: p.user }, title: `Remove ${label} for ${p.user}?`, lines: [], note: "Their settings are kept. What it adds stops from their next message.", confirmLabel: `Remove for ${p.user}`, tone: "warn" }) });
        out.push(remove);
      }
      const more = button("⋯", { title: `${p.user}'s settings and activity` });
      more.setAttribute("aria-label", `More for ${p.user}`);
      more.addEventListener("click", () => ext.ui.menu?.(more, [
        { label: `${p.user === ctx.user ? "Your" : `${p.user}'s`} settings`, run: () => ctx.show("configuration", { layer: p.user }) },
        { label: `${p.user === ctx.user ? "Your" : `${p.user}'s`} activity`, run: () => ctx.show("activity", { actor: p.user }) },
      ]));
      out.push(more);
    } else if (!ctx.adminOnly || p.role === "admin") {
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
        el("span", { class: "ua-person-who" }, el("b", {}, p.user), el("span", { class: p.config?.broken ? "ua-err" : "text-faint" }, ` · ${personSummary(p)}`)),
        el("span", { class: "ua-person-acts" }, ...actionsFor(p))
      )
    );
    const waiting = counts.waiting ?? people.filter((x) => x.installed && x.loaded?.state === "update").length;
    const nobodyElse = ctx.adminOnly && people.some((p) => !p.installed && p.role !== "admin");
    put(
      body,
      el("ul", { class: "ua-person-list" }, ...rows),
      ctx.inside ? el("p", { class: "text-faint" }, "Runs inside Thetis itself: nobody installs or removes it.") : nobodyElse ? el("p", { class: "text-faint" }, "Only admins can have this.") : null,
      el(
        "div",
        { class: "ua-where-foot" },
        el("span", {}, el("b", {}, String(counts.installed ?? people.filter((x) => x.installed).length)), ` of ${counts.people ?? people.length} have it`),
        waiting ? el("span", { class: "ua-warn" }, waitingSentence(waiting)) : null,
        counts.forks ? el("span", {}, el("b", {}, String(counts.forks)), ` customised ${counts.forks === 1 ? "copy" : "copies"}`) : null,
        counts.broken ? el("span", {}, el("b", { class: "ua-err" }, String(counts.broken)), ` ${counts.broken === 1 ? "needs" : "need"} setup`) : null
      )
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
            { key: "version", label: "Version", render: (p) => (p.installed ? el("span", {}, el("code", {}, p.version ?? "?"), p.forkedFrom ? [" ", badge("customised copy", "dim")] : null) : el("span", { class: "text-faint" }, "doesn't have it")) },
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

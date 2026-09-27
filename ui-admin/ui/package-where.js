/* Where an extension runs. The card holds a person picker instead of a row per person, so it is the same
 * size with fifty people as with three: a select whose options each say the person's state in a few
 * words, previous and next, the facts for the chosen person (their copy, when their workspace opened and
 * whether it applied the copy on disk, the service, the settings), the buttons that act on that person,
 * and a footer with the counts ("3 people haven't applied it yet"). There is no restart button here:
 * applying updates is one action for everyone, on the extensions pages, and restarting one workspace is
 * Advanced → Workspaces. The tab shows the same card at full width and, under it, a table of everyone. All
 * of it is `package-where`'s answer; a person the answer does not know is not shown. */

import { stateBadge, stateWord, waitingSentence } from "./state.js";

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};

/** The few words beside a person's name in the picker: what is worth knowing before choosing them. */
export function personSummary(p) {
  if (!p.installed) return "not installed";
  const bits = [];
  if (p.forkedFrom) bits.push("own copy");
  if (p.loaded?.state === "update") bits.push(stateWord("update").toLowerCase());
  if (p.config?.broken) bits.push("needs setup");
  return bits.length ? bits.join(", ") : stateWord("current").toLowerCase();
}

/** The person card. `full` widens it for the tab. */
export function whereCard(ext, ctx, { alive, full = false } = {}) {
  const { el, clear } = ext.dom;
  const { badge, button, card, put } = ext.ui;
  const where = ctx.where;
  const name = ctx.name;
  const body = el("div", { class: "ua-where-body" });
  const head = el("span", { class: "ua-card-title" }, "Where it runs", ctx.tag("admin"));
  const node = card(head, body);
  node.classList.add("ua-where");
  if (full) node.classList.add("is-full");
  if (!where || !Array.isArray(where.people) || !where.people.length) {
    put(body, el("p", { class: "text-faint" }, where ? "Nobody has been added yet." : "Who has this extension could not be read."));
    return node;
  }
  const people = where.people;
  const counts = where.counts ?? {};
  let at = Math.max(0, people.findIndex((p) => p.installed));

  function draw() {
    clear(body);
    const p = people[at];
    const select = el("select", { class: "input ua-person", "aria-label": "Person", onChange: () => { at = Number(select.value); draw(); } }, ...people.map((x, i) => el("option", { value: String(i), selected: i === at || null }, `${x.user} · ${personSummary(x)}`)));
    const prev = button("‹", { title: "Previous person", onClick: () => { at = (at + people.length - 1) % people.length; draw(); } });
    const next = button("›", { title: "Next person", onClick: () => { at = (at + 1) % people.length; draw(); } });
    prev.setAttribute("aria-label", "Previous person");
    next.setAttribute("aria-label", "Next person");
    prev.classList.add("is-sm");
    next.classList.add("is-sm");
    const facts = [[el("dt", {}, "who"), el("dd", {}, p.user, el("span", { class: "text-faint" }, ` · ${p.role}${p.status && p.status !== "active" ? ` · ${p.status}` : ""}`))]];
    if (p.installed) {
      facts.push([el("dt", {}, "has it as"), el("dd", {}, el("code", {}, p.version ?? "?"), p.forkedFrom ? [" ", badge(`own copy of ${p.forkedFrom.name} ${p.forkedFrom.version}`, "warn")] : null, p.replaced ? el("span", { class: "text-faint" }, ` instead of ${p.replaced}`) : null)]);
      const l = p.loaded;
      const loaded = l?.openedAt ? [stateBadge(ext, l.state), el("span", { class: "text-faint" }, ` workspace opened ${when(l.openedAt)}`)] : [el("span", { class: "ua-dot is-dim" }), " workspace not open"];
      facts.push([el("dt", {}, "in service"), el("dd", {}, ...loaded)]);
      facts.push([el("dt", {}, "service"), el("dd", {}, Array.isArray(p.services) && p.services.includes(name) ? "running in their workspace" : el("span", { class: "text-faint" }, "none from this extension"))]);
      facts.push([el("dt", {}, "setup"), el("dd", {}, p.config ? (p.config.broken ? el("span", { class: "ua-err" }, p.config.summary || "needs setup") : el("span", { class: "ua-ok" }, "set up")) : el("span", { class: "text-faint" }, "not read"))]);
    } else facts.push([el("dt", {}, "has it"), el("dd", { class: "text-faint" }, "not installed for them")]);
    const actions = [];
    if (p.installed) {
      const layer = button("Their settings", { onClick: () => ctx.show("configuration", { layer: p.user }) });
      const activity = button("Their activity", { onClick: () => ctx.show("activity", { actor: p.user }) });
      const remove = button("Remove for them", { tone: "warn", onClick: () => void ctx.act(remove, { verb: "package-remove", args: { user: p.user }, title: `Remove for ${p.user}?`, lines: [["workspace", p.user]], note: "Only their link is removed; the files stay. Its tools stop on their next reply.", confirmLabel: "Remove", tone: "warn" }) });
      actions.push(layer, activity, remove);
    } else {
      const install = button("Install for them", { tone: "primary", onClick: () => void ctx.act(install, { verb: "package-install-for", args: { user: p.user }, title: `Install for ${p.user}?`, lines: [["workspace", p.user]], note: "Their workspace gets the extension on its next reply.", confirmLabel: "Install" }) });
      actions.push(install);
    }
    for (const b of actions) b.classList.add("is-sm");
    const waiting = counts.waiting ?? people.filter((x) => x.installed && x.loaded?.state === "update").length;
    put(
      body,
      el("div", { class: "ua-person-row" }, el("span", { class: "text-faint" }, "Person"), select, prev, next),
      el("dl", { class: "kv ua-person-facts" }, ...facts.flat()),
      el("div", { class: "ua-person-actions" }, ...actions),
      el(
        "div",
        { class: "ua-where-foot" },
        el("span", {}, el("b", {}, String(counts.installed ?? people.filter((x) => x.installed).length)), ` of ${counts.people ?? people.length} have it`),
        waiting ? el("span", { class: "ua-warn" }, waitingSentence(waiting)) : null,
        counts.forks ? el("span", {}, el("b", { class: "ua-warn" }, String(counts.forks)), ` own ${counts.forks === 1 ? "copy" : "copies"}`) : null,
        counts.broken ? el("span", {}, el("b", { class: "ua-err" }, String(counts.broken)), " need setup") : null
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
            { key: "version", label: "Version", render: (p) => (p.installed ? el("span", {}, el("code", {}, p.version ?? "?"), p.forkedFrom ? [" ", badge("own copy", "warn")] : null) : el("span", { class: "text-faint" }, "not installed")) },
            { key: "loaded", label: "In service", render: (p) => (p.installed && p.loaded?.openedAt ? stateBadge(ext, p.loaded.state) : el("span", { class: "text-faint" }, p.installed ? "not open" : "—")) },
            { key: "service", label: "Service", render: (p) => (Array.isArray(p.services) && p.services.includes(ctx.name) ? "running" : el("span", { class: "text-faint" }, "—")) },
            { key: "config", label: "Setup", render: (p) => (!p.installed ? el("span", { class: "text-faint" }, "—") : p.config ? (p.config.broken ? el("span", { class: "ua-err" }, p.config.summary || "needs setup") : el("span", { class: "ua-ok" }, "set up")) : el("span", { class: "text-faint" }, "not read")) },
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

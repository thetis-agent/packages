/* The Activity tab: the journal entries about one package, from `package-activity`, in a table of when,
 * kind, who, what and detail. Kind chips narrow to one kind, range chips to the last 14 or 30 days, and
 * a person chip appears when the tab was opened from "Their activity". The sentence in the What column
 * is written from the kind and the entry's data; the Detail column shows the rest of the data plainly. */

const RANGES = [
  ["14", "14 d", 14],
  ["30", "30 d", 30],
  ["all", "all", 0],
];

/**
 * The people a fleet-wide install left alone, because they hold a fork of the package. "installed for
 * everyone" is read as everyone, and an admin who never learns otherwise goes on believing a package is
 * everywhere while somebody is still running their own copy of it. The names are what makes it actionable:
 * whoever reads this row later can go and ask them.
 */
const kept = (d) => (Array.isArray(d.forks) && d.forks.length ? `, except ${d.forks.map((f) => f.user).join(", ")}, who ${d.forks.length === 1 ? "holds" : "hold"} a fork of it` : "");

/** One sentence for an entry, from its kind and data. Unknown kinds show the kind and the target. */
export function sentence(entry, name) {
  const d = entry.data ?? {};
  const t = entry.target ?? "";
  switch (entry.kind) {
    case "package.install":
      return `installed ${d.name ?? name}${d.version ? ` ${d.version}` : ""} for ${t}`;
    case "package.uninstall":
      return `removed ${d.name ?? name} for ${t}`;
    case "package.promote":
      return `promoted ${d.name ?? name} to ${d.promoted ?? "a system package"}${Array.isArray(d.userspaces) ? ` for ${d.userspaces.length} workspace${d.userspaces.length === 1 ? "" : "s"}` : ""}${kept(d)}`;
    case "package.everyone":
      return d.on === false ? `${t} is no longer the default for everyone` : `made ${t} the default for everyone${kept(d)}`;
    case "update.start":
      return `update of the installation started${d.from ? ` from runtime ${d.from.runtime}, packages ${d.from.packages}` : ""}`;
    case "update.done":
      return `installation updated${d.to ? ` to runtime ${d.to.runtime}, packages ${d.to.packages}` : ""}`;
    case "update.fail":
      return `update of the installation failed${d.error ? `: ${d.error}` : ""}`;
    case "service.start":
      return `service started for ${t}`;
    case "service.stop":
      return `service stopped for ${t}`;
    case "config.set":
      return `${d.key ?? "a key"} set${d.user ? ` for ${d.user}` : " for everyone"}`;
    case "config.unset":
      return `${d.key ?? "a key"} cleared${d.user ? ` for ${d.user}` : " for everyone"}`;
    case "config.reload":
      return "the configuration file was read again";
    case "fence.reload":
      return `${t}'s workspace reloaded`;
    default:
      return `${entry.kind}${t ? ` · ${t}` : ""}`;
  }
}

function toneOf(kind) {
  if (/error|fail/.test(kind)) return "err";
  if (/config|fork|promote|uninstall/.test(kind)) return "warn";
  if (/bench/.test(kind)) return "ok";
  return "dim";
}

/** The data a sentence did not use, as `key: value` pairs. */
function detail(entry) {
  const used = new Set(["name", "version", "key", "user", "promoted", "userspaces", "forks"]);
  const rest = Object.entries(entry.data ?? {}).filter(([k]) => !used.has(k));
  return rest.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
}

const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso ?? "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export function mountActivity(ext, host, ctx) {
  const { el, clear } = ext.dom;
  const { badge, busy, put, table } = ext.ui;
  let alive = true;
  let entries = [];
  let kind = null;
  let range = "14";
  let actor = ctx.actor ?? null;
  const wrap = el("div", { class: "card ua-activity" });
  const head = el("div", { class: "card-head ua-activity-head" });
  const body = el("div", { class: "ua-activity-body" });
  put(wrap, head, body);
  host.append(wrap);

  const chip = (label, on, onClick) => el("button", { type: "button", class: `ua-chip${on ? " is-on" : ""}`, onClick }, label);

  function shown() {
    const days = RANGES.find((r) => r[0] === range)?.[2] ?? 0;
    const since = days ? Date.now() - days * 86_400_000 : 0;
    return entries.filter((e) => (!kind || e.kind === kind) && (!actor || e.actor === actor) && (!since || Date.parse(e.at) >= since));
  }

  function draw() {
    clear(head);
    clear(body);
    const kinds = [...new Set(entries.map((e) => e.kind))].sort();
    put(
      head,
      el("span", { class: "ua-card-title" }, "Activity", el("span", { class: "text-faint" }, `everything about this package · ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`)),
      el(
        "span",
        { class: "ua-chips" },
        chip("all kinds", !kind, () => { kind = null; draw(); }),
        ...kinds.map((k) => chip(k.replace(/^package\./, ""), kind === k, () => { kind = kind === k ? null : k; draw(); })),
        actor ? chip(`${actor} ×`, true, () => { actor = null; draw(); }) : null,
        el("span", { class: "ua-sep" }, "·"),
        ...RANGES.map(([id, label]) => chip(label, range === id, () => { range = id; draw(); }))
      )
    );
    const rows = shown();
    put(
      body,
      table(
        [
          { key: "at", label: "When", render: (e) => el("code", { class: "text-faint" }, when(e.at)) },
          { key: "kind", label: "Kind", render: (e) => badge(e.kind, toneOf(e.kind)) },
          { key: "actor", label: "Who", render: (e) => e.actor ?? el("span", { class: "text-faint" }, "kernel") },
          { key: "what", label: "What", render: (e) => sentence(e, ctx.name) },
          { key: "detail", label: "Detail", render: (e) => el("span", { class: "text-faint ua-detail" }, detail(e)) },
        ],
        rows,
        { rowKey: (e) => `${e.at}-${e.kind}`, empty: entries.length ? "Nothing in this range." : "Nothing in the journal about this package." }
      )
    );
  }

  void (async () => {
    const stop = busy(wrap, "Reading the journal…");
    try {
      const out = await ext.request("package-activity", { args: { name: ctx.name, limit: 500 } });
      if (!alive) return;
      entries = Array.isArray(out?.data?.entries) ? out.data.entries : [];
    } catch (err) {
      if (!alive) return;
      ext.toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    if (alive) draw();
  })();
  draw();
  return () => {
    alive = false;
  };
}

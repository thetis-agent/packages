/* The package card at the top of a package's settings page: what this copy is and where it stands, from
 * `package-info`. Every line is a fact the kernel, the marketplace index or git reported, said in words:
 * the version and type; whether it is a system package and whether every person gets it by default; where the copy came from (shipped
 * with Thetis, a path in the home, or a registry repository with the commit it is pinned to); what it was
 * forked from and what it replaces; the version the workspace loaded when its fence opened, said only
 * when the files on disk have moved past it, because then a reload is what puts the new one into service;
 * the version the registry holds and whether this copy is behind it;
 * and the checkout its files live in, with the branch, how far ahead of or behind the upstream it is, and
 * how many of this package's files are changed and not committed. The pure `packageFacts` is exported so
 * a test can check the words without a DOM. */

const short = (commit) => (typeof commit === "string" ? commit.slice(0, 7) : "");

/** `<url>#<dir>@<commit>` taken apart, the way the install source is written. */
function splitSource(ref) {
  const pin = /@([0-9a-f]{7,40})$/.exec(ref);
  const rest = pin ? ref.slice(0, -pin[0].length) : ref;
  const hash = rest.indexOf("#");
  return { url: hash < 0 ? rest : rest.slice(0, hash), dir: hash < 0 ? null : rest.slice(hash + 1), pin: pin?.[1] ?? null };
}

/** The lines of the card: `[label, text, tone?]`, in order. `tone` marks a line worth a glance: warn or err. */
export function packageFacts(info) {
  const facts = [];
  facts.push(["version", `${info.version} · ${info.type}`]);
  // A system package is the installation's whether or not it is everyone's default; the default is the second fact, with whose word made it so.
  const by = info.everyoneBy === "config" ? " by the configuration" : info.everyoneBy === "promoted" ? " by promotion" : info.everyoneBy === "marked" ? " by an admin's mark" : "";
  facts.push(["default", info.everyone ? `everyone gets it${by}` : info.source?.kind === "system" ? "optional: each person installs it" : "only the people it was installed for"]);
  const src = info.source;
  if (!src) facts.push(["source", "unknown"]);
  else if (src.kind === "system") facts.push(["source", "shipped with Thetis"]);
  else if (src.kind === "local") facts.push(["source", `a directory: ${src.ref}`]);
  else {
    const { url, dir, pin } = splitSource(src.ref);
    facts.push(["source", `${url}${dir ? ` · ${dir}` : ""}${pin ? ` · pinned to ${short(pin)}` : ""}`]);
  }
  if (info.forkedFrom) facts.push(["fork", `forked from ${info.forkedFrom.name} ${info.forkedFrom.version}${info.replaced ? `, replacing ${info.replaced}` : ""}`, "warn"]);
  else if (info.replaced) facts.push(["replaces", info.replaced]);
  // The files are installed the moment they land; what is in service is what the fence read when it opened.
  if (info.loaded?.behindDisk) facts.push(["workspace", `loaded ${info.loaded.version} in ${info.loaded.user}'s workspace, ${info.version} on disk: a reload applies it`, "warn"]);
  const reg = info.registry;
  // A reload is not an offer from a registry: the files here are already the new ones, and nothing installs.
  if (reg?.update?.apply === "reload") facts.push(["registry", `${reg.registry} holds ${reg.version}; the copy here is ${info.version} and is installed already: a workspace reload puts it into service`, "warn"]);
  else if (reg?.update) facts.push(["registry", `${reg.registry} holds ${reg.update.version} (${short(reg.update.available)}); this copy is ${short(reg.update.installed)}: an update is on offer in the marketplace`, "warn"]);
  else if (reg) facts.push(["registry", `${reg.registry} holds ${reg.version} (${short(reg.commit)})${info.source?.kind === "git" ? ": this copy is current" : ""}`]);
  else facts.push(["registry", "not in the marketplace index"]);
  const git = info.git;
  if (!git) facts.push(["checkout", "not in a git checkout"]);
  else {
    const parts = [git.branch ? `on ${git.branch}` : "detached", git.commit ? `at ${git.commit}` : null];
    if (git.upstream) {
      const sync = [];
      if (git.ahead) sync.push(`${git.ahead} commit${git.ahead === 1 ? "" : "s"} not pushed`);
      if (git.behind) sync.push(`${git.behind} behind ${git.upstream}`);
      parts.push(sync.length ? sync.join(", ") : `in step with ${git.upstream}`);
    } else parts.push("no upstream branch tracked");
    parts.push(git.changed ? `${git.changed} file${git.changed === 1 ? "" : "s"} of this package changed and not committed` : "nothing uncommitted here");
    facts.push(["checkout", parts.filter(Boolean).join(" · "), git.ahead || git.changed ? "warn" : undefined]);
  }
  facts.push(["files", info.root]);
  return facts;
}

/** The badge for what is behind: a registry's newer commit is an update, a version nobody loaded is a reload. */
export function updateBadge(badge, info) {
  if (info.loaded?.behindDisk) return badge(`reload to ${info.version}`, "warn");
  if (info.registry?.update) return badge(`${info.registry.update.apply === "reload" ? "reload" : "update"} to ${info.registry.update.version}`, "warn");
  return null;
}

export function packageCard(ext, info) {
  const { el } = ext.dom;
  const { badge, button, card, confirm } = ext.ui;
  const lines = packageFacts(info);
  const marks = [info.source?.kind === "system" ? badge(info.everyone ? "System · everyone" : "System", "accent") : badge(info.everyone ? "Everyone" : "Some people", "dim"), info.forkedFrom ? badge("fork", "warn") : null, updateBadge(badge, info), info.git?.ahead ? badge("not pushed", "warn") : null, info.git?.changed ? badge("uncommitted", "warn") : null].filter(Boolean);

  /**
   * Reload that workspace: the only thing that puts a version the fence has not read into service. Behind a
   * confirm, because the fence closes and every open shell session in it stops, and shown only when there is
   * something to apply, so a button that could do nothing is never offered.
   */
  let reload = null;
  if (info.loaded?.behindDisk) {
    const who = info.loaded.user;
    reload = button(`Reload ${who}'s workspace`, { tone: "warn" });
    reload.addEventListener("click", async () => {
      const ok = await confirm(reload, {
        title: "Reload this workspace?",
        lines: [["workspace", who], ["applies", `${info.name} ${info.loaded.version} → ${info.version}`], ["keeps", "conversations and files"]],
        note: "The fence closes and opens again on the code on disk now, so its services, its provider and the agent itself are the new ones. Every open shell session in it stops; conversations and files are untouched.",
        confirmLabel: "Reload",
        tone: "warn",
      });
      if (!ok) return;
      reload.disabled = true;
      try {
        const out = await ext.request("fence-reload", { args: { user: who } });
        const services = out?.data?.services ?? [];
        ext.toast(services.length ? `${who}'s workspace was reloaded: ${services.join(", ")} restarted.` : `${who}'s workspace was reloaded.`, { tone: "good" });
      } catch (err) {
        ext.toast(err?.message || "That did not work.", { tone: "error" });
      } finally {
        reload.disabled = false;
      }
    });
  }
  const node = card(el("span", { class: "ua-pkg-head" }, el("code", {}, info.name), ...marks), el("dl", { class: "kv ua-pkg-facts" }, ...lines.flatMap(([k, v, tone]) => [el("dt", {}, k), el("dd", { class: tone ? `is-${tone}` : null }, k === "files" ? el("code", {}, v) : v)])), reload ? el("div", { class: "card-actions" }, reload) : null);
  node.classList.add("ua-pkg-card");
  return node;
}

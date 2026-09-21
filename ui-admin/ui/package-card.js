/* The package card at the top of a package's settings page: what this copy is and where it stands, from
 * `package-info`. Every line is a fact the kernel, the marketplace index or git reported, said in words:
 * the version and type; whether everyone has it or only this person; where the copy came from (shipped
 * with Thetis, a path in the home, or a registry repository with the commit it is pinned to); what it was
 * forked from and what it replaces; the version the registry holds and whether this copy is behind it;
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
  facts.push(["scope", info.everyone ? "everyone has it" : "only you"]);
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
  const reg = info.registry;
  if (reg?.update) facts.push(["registry", `${reg.registry} holds ${reg.update.version} (${short(reg.update.available)}); this copy is ${short(reg.update.installed)}: an update is on offer in the marketplace`, "warn"]);
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

export function packageCard(ext, info) {
  const { el } = ext.dom;
  const { badge, card } = ext.ui;
  const lines = packageFacts(info);
  const marks = [info.everyone ? badge("Everyone", "accent") : badge("Only me", "dim"), info.forkedFrom ? badge("fork", "warn") : null, info.registry?.update ? badge(`update to ${info.registry.update.version}`, "warn") : null, info.git?.ahead ? badge("not pushed", "warn") : null, info.git?.changed ? badge("uncommitted", "warn") : null].filter(Boolean);
  const node = card(el("span", { class: "ua-pkg-head" }, el("code", {}, info.name), ...marks), el("dl", { class: "kv ua-pkg-facts" }, ...lines.flatMap(([k, v, tone]) => [el("dt", {}, k), el("dd", { class: tone ? `is-${tone}` : null }, k === "files" ? el("code", {}, v) : v)])));
  node.classList.add("ua-pkg-card");
  return node;
}

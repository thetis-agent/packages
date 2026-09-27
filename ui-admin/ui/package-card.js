/* The extension card: what this copy is and where it stands, from `package-info`. Every line is a fact the
 * kernel, the marketplace index or git reported, said in words: the version and type; whether everyone gets
 * it by default; where the copy came from (shipped with Thetis, shared with everyone from a person's
 * extension -- whose, and when, from the journal -- a directory in the home, or a registry repository with the
 * commit it is pinned to); whether it is someone's own copy of another extension; whether
 * the workspace it was read from has applied the copy on disk (Update ready when not: applying updates puts
 * it into service); the version the registry holds and whether this copy is behind it; and the checkout its
 * files live in. There is no restart button here: applying updates is one action for everyone, on the
 * extensions pages. The pure `packageFacts` is exported so a test can check the words without a DOM. */

import { stateBadge, stateWord } from "./state.js";

const short = (commit) => (typeof commit === "string" ? commit.slice(0, 7) : "");

/** `<url>#<dir>@<commit>` taken apart, the way the install source is written. */
function splitSource(ref) {
  const pin = /@([0-9a-f]{7,40})$/.exec(ref);
  const rest = pin ? ref.slice(0, -pin[0].length) : ref;
  const hash = rest.indexOf("#");
  return { url: hash < 0 ? rest : rest.slice(0, hash), dir: hash < 0 ? null : rest.slice(hash + 1), pin: pin?.[1] ?? null };
}

/** The day of an ISO time, as the page prints it: `2026-09-24`. */
const day = (iso) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

/**
 * Where a shared copy came from, in one sentence: "Shared with everyone from @bitmuse/notion by bitmuse on
 * 2026-09-24". What the journal does not say is left out rather than guessed.
 */
export function sharedSentence(from) {
  if (!from?.name) return "Shared with everyone from a person's extension";
  const on = day(from.at);
  return `Shared with everyone from ${from.name}${from.by ? ` by ${from.by}` : ""}${on ? ` on ${on}` : ""}`;
}

/** The lines of the card: `[label, text, tone?]`, in order. `tone` marks a line worth a glance: warn or err. */
export function packageFacts(info) {
  const facts = [];
  facts.push(["version", `${info.version} · ${info.type}`]);
  // A system package is the installation's whether or not it is everyone's default; the default is the second fact, with whose word made it so.
  const by = info.everyoneBy === "config" ? " by the server's settings file" : info.everyoneBy === "promoted" ? ": shared with everyone from a person's extension" : info.everyoneBy === "marked" ? " by an admin's choice" : "";
  facts.push(["default", info.everyone ? `everyone gets it${by}` : info.source?.kind === "system" ? "optional: each person installs it" : "only the people it was installed for"]);
  const src = info.source;
  if (!src) facts.push(["source", "unknown"]);
  // A shared copy lives beside the extensions Thetis ships, but it was not shipped: it is a person's extension.
  else if (info.everyoneBy === "promoted") facts.push(["source", sharedSentence(info.promotedFrom)]);
  else if (src.kind === "system") facts.push(["source", "shipped with Thetis"]);
  else if (src.kind === "local") facts.push(["source", `a directory: ${src.ref}`]);
  else {
    const { url, dir, pin } = splitSource(src.ref);
    facts.push(["source", `${url}${dir ? ` · ${dir}` : ""}${pin ? ` · pinned to ${short(pin)}` : ""}`]);
  }
  if (info.forkedFrom) facts.push(["own copy", `a copy of ${info.forkedFrom.name} ${info.forkedFrom.version}${info.replaced ? `, used instead of it` : ""}`, "warn"]);
  else if (info.replaced) facts.push(["replaces", info.replaced]);
  // The files are installed the moment they land; what is in service is what the workspace read when it opened.
  if (info.loaded?.behindDisk) facts.push(["workspace", `${stateWord("update")}: ${info.loaded.user}'s workspace runs ${info.loaded.version}; ${info.version} is on disk and goes live when updates are applied`, "warn"]);
  const reg = info.registry;
  // Applying is not an offer from a registry: the files here are already the new ones, and nothing installs.
  if (reg?.update?.apply === "reload") facts.push(["registry", `${reg.registry} holds ${reg.version}; the copy here is ${info.version} and is installed already: applying updates puts it into service`, "warn"]);
  else if (reg?.update) facts.push(["registry", `${reg.registry} holds ${reg.update.version} (${short(reg.update.available)}); this copy is ${short(reg.update.installed)}: ${stateWord("update")}`, "warn"]);
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
    parts.push(git.changed ? `${git.changed} file${git.changed === 1 ? "" : "s"} of this extension changed and not committed` : "nothing uncommitted here");
    facts.push(["checkout", parts.filter(Boolean).join(" · "), git.ahead || git.changed ? "warn" : undefined]);
  }
  facts.push(["files", info.root]);
  return facts;
}

/** The one state of this copy: Update ready when a registry holds newer or the workspace has not applied it. */
export function copyState(info) {
  return info?.loaded?.behindDisk || info?.registry?.update ? "update" : "current";
}

export function packageCard(ext, info) {
  const { el } = ext.dom;
  const { badge, card } = ext.ui;
  const lines = packageFacts(info);
  const marks = [info.everyone ? badge("For everyone", "accent") : null, info.forkedFrom ? badge("Customized", "dim") : null, stateBadge(ext, copyState(info)), info.git?.ahead ? badge("not pushed", "warn") : null, info.git?.changed ? badge("uncommitted", "warn") : null].filter(Boolean);
  const node = card(el("span", { class: "ua-pkg-head" }, el("code", {}, info.name), ...marks), el("dl", { class: "kv ua-pkg-facts" }, ...lines.flatMap(([k, v, tone]) => [el("dt", {}, k), el("dd", { class: tone ? `is-${tone}` : null }, k === "files" ? el("code", {}, v) : v)])));
  node.classList.add("ua-pkg-card");
  return node;
}

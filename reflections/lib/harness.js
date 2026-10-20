// What the harness was when a conversation ran, read from the stamps @thetis/harness-core writes per turn,
// and what it is today, read from the installed packages. The first is evidence a reflection reads under
// `context/harness/`; the second is what a proposal is checked and versioned against.
//
//   <home>/harness-core/turns/<s>.jsonl              one line per turn: model, versions, system and tools hashes,
//                                                    skills, groups, project
//   <home>/harness-core/snapshots/<s>/<sha>.md        the system text a turn ran with
//   <home>/harness-core/snapshots/<s>/<sha>.json      its tools, [{ name, package, description, parameters }]
//
// Every read is defensive: a conversation from before the stamps has none, and a malformed line is skipped.
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readText } from "./files.js";

export const NONE_TEXT = "This conversation ran before turns were recorded. The harness below is today's, not the one it ran with.";

/** The stamps of one conversation, in turn order; none when it has none. */
export async function readStamps(home, s) {
  const text = await readText(home, `harness-core/turns/${s}.jsonl`);
  return parseStamps(text);
}

/** The stamps in a jsonl text; a line that does not parse is skipped. */
export function parseStamps(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch {
      /* a torn line: the turn is missing, not the file */
    }
  }
  return out;
}

/** A snapshot's text, or null. `dir` is relative to `home`. */
export async function readSnapshot(home, dir, sha, ext) {
  if (typeof sha !== "string" || !/^[a-f0-9]{6,64}$/.test(sha)) return null;
  return readText(home, `${dir}/${sha}.${ext}`);
}

const versionsOf = (stamp) => (stamp?.versions && typeof stamp.versions === "object" && !Array.isArray(stamp.versions) ? stamp.versions : {});

/** Every package any of the stamps names, with the version of the latest stamp (by `at`) that names it. */
export function stampedVersions(stamps) {
  const out = {};
  const ordered = [...stamps].sort((a, b) => String(a?.at ?? "").localeCompare(String(b?.at ?? "")));
  for (const s of ordered) for (const [name, v] of Object.entries(versionsOf(s))) if (typeof v === "string") out[name] = v;
  return out;
}

/**
 * The packages installed today: `[{ name, version, root?, thetis? }]`. From `kernel.packages.list()` when the
 * kernel has it, else from the `package.json` files under the userspace's `store/node_modules` (the home's
 * sibling), which misses the shipped ones but is better than nothing.
 */
export async function installedPackages({ home, kernel }) {
  try {
    const list = await kernel?.packages?.list?.();
    if (Array.isArray(list)) return list.filter((p) => p && typeof p.name === "string");
  } catch {
    /* fall through to the files */
  }
  const store = resolve(home, "..", "store", "node_modules");
  const out = [];
  const read = async (dir) => {
    try {
      const pkg = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8"));
      if (typeof pkg?.name === "string") out.push({ name: pkg.name, version: String(pkg.version ?? ""), root: dir, thetis: pkg.thetis ?? {} });
    } catch {
      /* not a package */
    }
  };
  let names = [];
  try {
    names = await readdir(store);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n.startsWith(".")) continue;
    if (n.startsWith("@")) {
      let inner = [];
      try {
        inner = await readdir(resolve(store, n));
      } catch {
        continue;
      }
      for (const m of inner) await read(resolve(store, n, m));
    } else await read(resolve(store, n));
  }
  return out;
}

/** `{ name: version }` of a package list. */
export const versionMap = (packages) => Object.fromEntries(packages.map((p) => [p.name, p.version]));

const sortedEntries = (o) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b));

function versionChanges(prev, next) {
  const lines = [];
  for (const [name, v] of sortedEntries(next)) {
    if (!(name in prev)) lines.push(`- added ${name} ${v}`);
    else if (prev[name] !== v) lines.push(`- ${name} ${prev[name]} → ${v}`);
  }
  for (const name of Object.keys(prev).sort()) if (!(name in next)) lines.push(`- removed ${name}`);
  return lines;
}

function skillsLine(skills) {
  if (!skills || typeof skills !== "object") return "skills: none recorded";
  const ids = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === "string" ? x : x?.id)).filter((x) => typeof x === "string") : []);
  const parts = [`loader ${typeof skills.loader === "string" ? skills.loader : "unknown"}`];
  const pinned = ids(skills.pinned);
  const universal = ids(skills.universal);
  parts.push(`pinned: ${pinned.length ? pinned.join(", ") : "none"}`);
  parts.push(`universal: ${universal.length ? universal.join(", ") : "none"}`);
  return `skills: ${parts.join("; ")}`;
}

function toolsText(json, n) {
  let tools;
  try {
    tools = JSON.parse(json);
  } catch {
    return `# Tools ${n}\n\n(the snapshot does not parse)\n`;
  }
  if (!Array.isArray(tools)) return `# Tools ${n}\n\n(the snapshot is not a list)\n`;
  const lines = tools.map((t) => `## ${t?.name ?? "?"} · ${t?.package ?? "?"}\n\n${String(t?.description ?? "").trim() || "(no description)"}`);
  return `# Tools ${n}\n\n${tools.length} tools, as name and package, then the description the model read. Parameters are left out.\n\n${lines.join("\n\n")}\n`;
}

/**
 * The `harness/` files of one conversation and its subagents.
 *
 * @param conversations `[{ id, label, stamps, dir }]`, the conversation first; `dir` is its snapshot
 *                      directory relative to `home`.
 * @param today         `{ name: version }` installed today, for the NONE case.
 * @returns `{ files: { "turns.md", "system-<n>.md", "tools-<n>.md" } | { "NONE.md" }, stamped: boolean,
 *          versions: { name: version } }`, `versions` being what the conversation ran with, or today's.
 */
export async function harnessFiles(home, conversations, today) {
  const root = conversations[0];
  if (!root?.stamps?.length) {
    const lines = sortedEntries(today).map(([name, v]) => `- ${name} ${v}`);
    const text = `# No harness record\n\n${NONE_TEXT}\n\n## Installed today\n\n${lines.length ? lines.join("\n") : "(the installed packages could not be read)"}\n\nThere is no system text: what the assistant was told is not known.\n`;
    return { files: { "NONE.md": text }, stamped: false, versions: { ...today } };
  }
  const files = {};
  const systems = new Map();
  const tools = new Map();
  const number = async (map, sha, dir, ext, prefix, render) => {
    if (typeof sha !== "string" || !sha) return null;
    if (map.has(sha)) return map.get(sha);
    const text = await readSnapshot(home, dir, sha, ext);
    const n = map.size + 1;
    const name = `${prefix}-${n}.md`;
    map.set(sha, name);
    files[name] = text === null ? `# ${prefix === "system" ? "System" : "Tools"} ${n}\n\n(the snapshot ${sha} is missing)\n` : render(text, n);
    return name;
  };
  const out = ["# What each turn ran with", "", "From the stamps harness-core wrote before each turn's first request. Versions are the installed versions on disk at that turn.", ""];
  const all = [];
  for (const c of conversations) {
    if (!c.stamps?.length) continue;
    all.push(...c.stamps);
    out.push(c === root ? `## The conversation ${c.id}` : `## Subagent ${c.id}${c.label ? ` (${c.label})` : ""}`, "");
    let prev = null;
    for (const s of c.stamps) {
      const sys = await number(systems, s.system, c.dir, "md", "system", (t, n) => `# System ${n}\n\nThe system text exactly as the model read it.\n\n~~~\n${t}\n~~~\n`);
      const tl = await number(tools, s.tools, c.dir, "json", "tools", toolsText);
      out.push(`### Turn ${s.turn ?? "?"}${s.at ? ` · ${s.at}` : ""}`, "");
      out.push(`model: ${s.model ?? "unknown"}`);
      out.push(`system: ${sys ?? "not recorded"} · tools: ${tl ?? "not recorded"}`);
      const v = versionsOf(s);
      if (!prev) {
        out.push("versions:", ...sortedEntries(v).map(([name, ver]) => `- ${name} ${ver}`));
      } else {
        const changes = versionChanges(prev, v);
        out.push(changes.length ? "versions changed:" : "versions: unchanged", ...changes);
      }
      prev = v;
      out.push(skillsLine(s.skills));
      out.push(`groups: ${Array.isArray(s.groups) && s.groups.length ? s.groups.join(", ") : s.groups === null || s.groups === undefined ? "not recorded" : "none"}`);
      out.push(`project: ${typeof s.project === "string" && s.project ? s.project : "none"}`, "");
    }
  }
  files["turns.md"] = `${out.join("\n").trimEnd()}\n`;
  return { files, stamped: true, versions: stampedVersions(all) };
}

/** The first turn's model, from the stamps, or null. */
export const firstModel = (stamps) => (typeof stamps?.[0]?.model === "string" && stamps[0].model ? stamps[0].model : null);

#!/usr/bin/env node
// Converts skill trees of the legacy Thetis (TOML frontmatter, `[text](skill:<id>)` links) into the format of
// @thetis/skills: YAML frontmatter the library's parser reads, ids as directory paths, links as plain ids.
//
//   node packages/skills/scripts/convert-legacy.mjs <legacy skill dir>... --out <skills dir> [--force]
//
// Each legacy directory `<parent>/<id>` becomes `<out>/<id>`, its nested skills beneath it. The set of every
// skill given in one run is the "converted set": a link or a related id that names a skill outside it is
// dropped with a warning. `--force` replaces an existing `<out>/<id>`. The summary goes to stdout, every
// warning to stderr. Importable: `convertLegacy({ inputs, out, force })` returns the same summary.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { yamlString } from "../lib/frontmatter.js";
import { LIMITS, NAME_RE, RESERVED } from "../lib/skill.js";

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SKILL_LINK = /\[([^\]]*)\]\(skill:([^)\s]+)\)/g;

// ---- the legacy frontmatter: TOML, one `key = value` per line ----

/** Reads the TOML subset the legacy trees use: strings, booleans, integers, and flat arrays of those. */
export function parseToml(text) {
  const data = {};
  for (const [n, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!m) throw new Error(`frontmatter line ${n + 1}: expected key = value, got ${JSON.stringify(line.slice(0, 60))}`);
    data[m[1]] = tomlValue(m[2].trim(), n + 1);
  }
  return data;
}

function tomlValue(raw, n) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"""') || raw.startsWith("'''")) throw new Error(`frontmatter line ${n}: multi-line strings are not supported`);
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) throw new Error(`frontmatter line ${n}: unterminated string`);
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`frontmatter line ${n}: string escape not understood`);
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) throw new Error(`frontmatter line ${n}: unterminated string`);
    return raw.slice(1, -1);
  }
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) throw new Error(`frontmatter line ${n}: an array must close on the same line`);
    const inner = raw.slice(1, -1).trim();
    return inner ? splitCommas(inner).map((p) => tomlValue(p.trim(), n)) : [];
  }
  throw new Error(`frontmatter line ${n}: value not understood: ${raw.slice(0, 40)}`);
}

function splitCommas(text) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Splits a legacy SKILL.md into its TOML text and its body. */
export function splitLegacy(text) {
  const src = String(text).replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) throw new Error("no frontmatter: the file must start with ---");
  const end = src.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("the frontmatter never closes");
  return { frontmatter: src.slice(4, end), body: src.slice(end + 5) };
}

// ---- the pieces of the new frontmatter ----

/** `brief` and `when_to_use` joined and, when over the limit, cut at the last sentence end that fits. */
export function describe(brief, whenToUse, limit = LIMITS.description) {
  const text = [brief, whenToUse].map((s) => String(s ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, cut: false };
  let s = text;
  while (Buffer.byteLength(s, "utf8") > limit) s = s.slice(0, -1);
  let at = -1;
  for (const m of s.matchAll(/[.!?](?=\s)/g)) at = m.index;
  if (at < 0) at = s.lastIndexOf(" ") - 1;
  return { text: s.slice(0, at + 1).trim(), cut: true };
}

/** A legacy tag as the format wants it: lowercase, spaces and underscores as hyphens, nothing else. */
export function normalizeTag(tag) {
  return String(tag)
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Rewrites `[text](skill:<id>)` links to plain ids. Returns the text and what it did. */
export function rewriteLinks(body, ids, warn) {
  let rewritten = 0;
  const text = body.replace(SKILL_LINK, (_, label, id) => {
    if (!ids.has(id)) {
      warn(`link to "${id}" names no skill in the converted set; left as plain text "${label}"`);
      return label;
    }
    rewritten++;
    const last = id.split("/").pop();
    return label === id || label === last ? `\`${id}\`` : `${label} (\`${id}\`)`;
  });
  return { text, rewritten };
}

function frontmatterOf({ name, description, title, tags, related, universal, version }) {
  const lines = ["---", `name: ${yamlString(name)}`, `description: ${yamlString(description)}`, "metadata:"];
  if (title) lines.push(`  title: ${yamlString(title)}`);
  if (tags.length) lines.push(`  tags: [${tags.map(yamlString).join(", ")}]`);
  if (related.length) lines.push(`  related: [${related.map(yamlString).join(", ")}]`);
  if (universal) lines.push(`  universal: "true"`);
  if (version !== undefined) lines.push(`  version: ${version}`);
  lines.push("---");
  return lines.join("\n");
}

// ---- the walk ----

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Every skill directory under `dir`, itself included, with the id it will have. */
function findSkills(dir, id, into) {
  if (!existsSync(resolve(dir, "SKILL.md"))) throw new Error(`${dir} has no SKILL.md`);
  into.push({ dir, id });
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || RESERVED.has(entry.name)) continue;
    const sub = resolve(dir, entry.name);
    if (existsSync(resolve(sub, "SKILL.md"))) findSkills(sub, `${id}/${skillName(sub)}`, into);
  }
  return into;
}

function skillName(dir) {
  const name = basename(dir).toLowerCase();
  if (!NAME_RE.test(name)) throw new Error(`${dir}: the directory name "${basename(dir)}" is not a skill name (${NAME_RE})`);
  if (RESERVED.has(name)) throw new Error(`${dir}: a skill may not be named ${name}`);
  return name;
}

/**
 * Converts `inputs` (legacy skill directories) into `out`. Returns `{ skills, resources, links, warnings }`;
 * `warnings` is the list of messages, also handed to `onWarning` as they happen.
 */
export function convertLegacy({ inputs, out, force = false, onWarning = () => {} }) {
  const warnings = [];
  const warn = (id, message) => {
    const line = `${id}: ${message}`;
    warnings.push(line);
    onWarning(line);
  };
  const found = [];
  for (const input of inputs) {
    const dir = resolve(input);
    if (!isDir(dir)) throw new Error(`${input} is not a directory`);
    findSkills(dir, skillName(dir), found);
  }
  const ids = new Set(found.map((s) => s.id));
  if (ids.size !== found.length) throw new Error("two inputs produce the same skill id");

  for (const top of found.filter((s) => !s.id.includes("/"))) {
    const target = resolve(out, top.id);
    if (existsSync(target)) {
      if (!force) throw new Error(`${target} exists; pass --force to replace it`);
      rmSync(target, { recursive: true, force: true });
    }
  }

  let resources = 0;
  let links = 0;
  for (const { dir, id } of found) {
    const target = resolve(out, id);
    mkdirSync(target, { recursive: true });
    if (id.split("/").length > LIMITS.depth) warn(id, `nested deeper than ${LIMITS.depth} levels; the library will refuse it`);

    let legacy;
    let body;
    try {
      const parts = splitLegacy(readFileSync(resolve(dir, "SKILL.md"), "utf8"));
      legacy = parseToml(parts.frontmatter);
      body = parts.body;
    } catch (e) {
      throw new Error(`${relative(process.cwd(), dir)}/SKILL.md: ${e.message}`);
    }

    const name = id.split("/").pop();
    const { text: description, cut } = describe(legacy.brief, legacy.when_to_use);
    if (!description) warn(id, "the legacy skill has neither brief nor when_to_use; the description is empty");
    if (cut) warn(id, `description cut to ${Buffer.byteLength(description, "utf8")} bytes at a sentence end (was ${Buffer.byteLength(`${legacy.brief} ${legacy.when_to_use}`, "utf8")})`);

    const tags = [];
    for (const raw of Array.isArray(legacy.tags) ? legacy.tags : []) {
      const tag = normalizeTag(raw);
      if (!TAG_RE.test(tag)) warn(id, `tag ${JSON.stringify(raw)} cannot be made a lowercase word; dropped`);
      else if (!tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > LIMITS.tags) warn(id, `${tags.length} tags; the first ${LIMITS.tags} are kept`);
    tags.splice(LIMITS.tags);

    const related = [];
    for (const r of Array.isArray(legacy.related) ? legacy.related : []) {
      if (ids.has(r)) related.push(r);
      else warn(id, `related id "${r}" is not in the converted set; dropped`);
    }

    let version;
    if (legacy.version !== undefined) {
      if (Number.isInteger(legacy.version) && legacy.version >= 0) version = legacy.version;
      else warn(id, `version ${JSON.stringify(legacy.version)} is not an integer; dropped`);
    }

    const known = new Set(["name", "brief", "when_to_use", "universal", "tags", "related", "children", "status", "superseded_by", "version"]);
    for (const key of Object.keys(legacy)) if (!known.has(key)) warn(id, `legacy key "${key}" has no place in the format; dropped`);

    const rewritten = rewriteLinks(body, ids, (m) => warn(id, m));
    links += rewritten.rewritten;
    let text = rewritten.text;
    if (legacy.status && legacy.status !== "active") {
      const by = legacy.superseded_by ? (ids.has(legacy.superseded_by) ? ` Superseded by \`${legacy.superseded_by}\`.` : ` Superseded by ${legacy.superseded_by}.`) : "";
      warn(id, `status ${legacy.status}${legacy.superseded_by ? `, superseded by ${legacy.superseded_by}` : ""}; noted as the first body line`);
      text = `**Status: ${legacy.status}.**${by}\n\n${text.replace(/^\n+/, "")}`;
    }

    const fm = frontmatterOf({ name, description, title: typeof legacy.name === "string" ? legacy.name.trim() : "", tags, related, universal: legacy.universal === true, version });
    const file = `${fm}\n${text}`;
    if (Buffer.byteLength(text, "utf8") > LIMITS.body) warn(id, `body is over ${LIMITS.body} bytes; the library will refuse it`);
    writeFileSync(resolve(target, "SKILL.md"), file);

    // Everything beside SKILL.md that is not a nested skill is a resource, copied as it is.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "SKILL.md" || entry.name.startsWith(".")) continue;
      const src = resolve(dir, entry.name);
      if (entry.isDirectory() && !RESERVED.has(entry.name) && existsSync(resolve(src, "SKILL.md"))) continue;
      cpSync(src, resolve(target, entry.name), { recursive: true });
      const files = entry.isDirectory() ? listFiles(src) : [src];
      resources += files.length;
      for (const f of files) {
        const n = (readFileSync(f, "utf8").match(SKILL_LINK) ?? []).length;
        if (n) warn(id, `resource ${relative(dir, f)} holds ${n} skill: link${n === 1 ? "" : "s"}, copied as it is`);
      }
    }
  }
  return { skills: found.length, resources, links, warnings };
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// ---- the command ----

function main(argv) {
  const inputs = [];
  let out;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a.startsWith("--out=")) out = a.slice(6);
    else if (a === "--force") force = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: convert-legacy.mjs <legacy skill dir>... --out <skills dir> [--force]");
      return 0;
    } else inputs.push(a);
  }
  if (!inputs.length || !out) {
    console.error("usage: convert-legacy.mjs <legacy skill dir>... --out <skills dir> [--force]");
    return 2;
  }
  try {
    const summary = convertLegacy({ inputs, out: resolve(out), force, onWarning: (line) => console.error(`warning: ${line}`) });
    console.log(`${summary.skills} skills, ${summary.resources} resources, ${summary.links} links rewritten, ${summary.warnings.length} warnings -> ${resolve(out)}`);
    return 0;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

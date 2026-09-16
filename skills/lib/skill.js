// One skill: the frontmatter rules of the format, the body, and the three texts a loader shows the model.
// `parseSkill` is pure, so a test can hand it a string; the filesystem walk is in load.js.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parseFrontmatter, splitDocument } from "./frontmatter.js";

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const RESERVED = new Set(["references", "scripts", "assets"]);
export const LIMITS = Object.freeze({ description: 1024, body: 64 * 1024, tags: 32, depth: 3, universal: 8, brief: 160 });

const TOP_KEYS = new Set(["name", "description", "metadata"]);
const META_KEYS = new Set(["title", "tags", "universal", "related", "version"]);

/** True when `id` is a well-formed skill id: 1 to 3 name segments joined by `/`. */
export function isSkillId(id) {
  if (typeof id !== "string" || !id) return false;
  const parts = id.split("/");
  return parts.length <= LIMITS.depth && parts.every((p) => NAME_RE.test(p));
}

export const parentOf = (id) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : null);

/** sha256 over what retrieval sees: name, description and tags. A body edit does not move it. */
export function contentHashOf(name, description, tags) {
  return createHash("sha256").update(JSON.stringify([name, description, tags])).digest("hex");
}

/**
 * Frontmatter and body to a skill record. `problems` holds every rule the text breaks; a loader leaves out a
 * skill with an `error` and keeps one with only warnings.
 */
export function parseSkill(text, { id } = {}) {
  const problems = [];
  const error = (message) => problems.push({ id, level: "error", message });
  const warning = (message) => problems.push({ id, level: "warning", message });

  if (!isSkillId(id)) error(`the id ${JSON.stringify(id)} is not 1 to 3 segments of ${NAME_RE}`);
  for (const part of String(id ?? "").split("/")) if (RESERVED.has(part)) error(`a skill may not be named ${part}`);

  const { frontmatter, body } = splitDocument(text);
  const skill = { id, name: "", description: "", title: "", tags: [], universal: false, related: [], version: undefined, body, contentHash: "", problems };
  if (frontmatter === null) {
    error("no frontmatter: SKILL.md must start with a --- block");
    return skill;
  }
  const { data, errors } = parseFrontmatter(frontmatter);
  for (const e of errors) error(e);

  for (const key of Object.keys(data)) if (!TOP_KEYS.has(key)) warning(`unknown frontmatter key "${key}" is ignored`);

  const dirName = String(id ?? "").split("/").pop();
  if (typeof data.name !== "string" || !data.name) error("name is required");
  else if (!NAME_RE.test(data.name)) error(`name ${JSON.stringify(data.name)} must match ${NAME_RE}`);
  else if (data.name !== dirName) error(`name "${data.name}" must equal the directory name "${dirName}"`);
  else skill.name = data.name;

  if (typeof data.description !== "string" || !data.description.trim()) error("description is required");
  else if (Buffer.byteLength(data.description, "utf8") > LIMITS.description) error(`description is over ${LIMITS.description} bytes`);
  else skill.description = data.description.trim();

  const meta = data.metadata;
  if (meta !== undefined) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) error("metadata must be a block of key: value lines");
    else {
      for (const key of Object.keys(meta)) if (!META_KEYS.has(key)) warning(`unknown metadata key "${key}" is ignored`);
      if (meta.title !== undefined) {
        if (typeof meta.title === "string") skill.title = meta.title.trim();
        else warning("metadata.title must be a string; ignored");
      }
      if (meta.tags !== undefined) {
        const list = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === "string" && meta.tags ? [meta.tags] : null;
        if (!list) warning("metadata.tags must be a list; ignored");
        else {
          const good = [];
          for (const t of list) {
            if (typeof t === "string" && TAG_RE.test(t)) good.push(t);
            else warning(`tag ${JSON.stringify(t)} is not a lowercase word; dropped`);
          }
          if (good.length > LIMITS.tags) warning(`more than ${LIMITS.tags} tags; the rest are dropped`);
          skill.tags = [...new Set(good)].slice(0, LIMITS.tags);
        }
      }
      if (meta.universal !== undefined) {
        const v = typeof meta.universal === "string" ? meta.universal.trim().toLowerCase() : meta.universal;
        if (v === "true" || v === true) skill.universal = true;
        else if (v !== "false" && v !== false && v !== "") warning(`metadata.universal must be "true" or "false"; read as false`);
      }
      if (meta.related !== undefined) {
        const list = Array.isArray(meta.related) ? meta.related : typeof meta.related === "string" && meta.related ? [meta.related] : null;
        if (!list) warning("metadata.related must be a list of ids; ignored");
        else {
          for (const r of list) {
            if (isSkillId(r)) skill.related.push(r);
            else warning(`related id ${JSON.stringify(r)} is not a skill id; dropped`);
          }
          skill.related = [...new Set(skill.related)];
        }
      }
      if (meta.version !== undefined) {
        if (typeof meta.version === "string" && /^\d{1,9}$/.test(meta.version.trim())) skill.version = Number(meta.version.trim());
        else warning("metadata.version must be an integer; ignored");
      }
    }
  }

  if (Buffer.byteLength(body, "utf8") > LIMITS.body) error(`body is over ${LIMITS.body} bytes`);
  for (const link of relativeLinks(body)) {
    if (!linkInsidePack(id, link)) warning(`the link "${link}" leaves the skills directory`);
  }

  skill.contentHash = contentHashOf(skill.name, skill.description, skill.tags);
  return skill;
}

/** Relative link targets in markdown links and images: no scheme, no leading `/`, no `#` anchor-only. */
function relativeLinks(body) {
  const out = [];
  const re = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(body))) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("#")) continue;
    out.push(target.split("#")[0]);
  }
  return out;
}

/** A relative link resolves inside the pack when, from `<root>/<id>/`, it does not climb above `<root>`. */
function linkInsidePack(id, link) {
  if (!link) return true;
  const from = `/root/${id}`;
  const target = posix.normalize(posix.join(from, link));
  return target === "/root" || target.startsWith("/root/");
}

/**
 * The rules over a set: the per-skill problems, the universal cap, related ids that name nothing, and a
 * child whose parent is missing. Each entry is `{ id, level, message }`.
 */
export function lint(skills) {
  const out = [];
  const ids = new Set(skills.map((s) => s.id));
  for (const s of skills) out.push(...(s.problems ?? []));
  let universal = 0;
  for (const s of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!s.universal) continue;
    universal++;
    if (universal > LIMITS.universal) out.push({ id: s.id, level: "warning", message: `more than ${LIMITS.universal} universal skills; this one is treated as ordinary` });
  }
  for (const s of skills) {
    for (const r of s.related ?? []) if (!ids.has(r)) out.push({ id: s.id, level: "warning", message: `related id "${r}" names no skill` });
    const parent = parentOf(s.id);
    if (parent && !ids.has(parent)) out.push({ id: s.id, level: "warning", message: `the parent skill "${parent}" has no SKILL.md` });
  }
  return out;
}

/** The first sentence of a description, cut to `LIMITS.brief` characters. */
export function firstSentence(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.*?[.!?])(?:\s|$)/.exec(s);
  const sentence = m ? m[1] : s;
  return sentence.length > LIMITS.brief ? `${sentence.slice(0, LIMITS.brief - 1).trimEnd()}…` : sentence;
}

/** The rest of the description after its first sentence, or an empty string. */
export function restOfDescription(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.*?[.!?])(?:\s+|$)/.exec(s);
  return m ? s.slice(m[0].length).trim() : "";
}

/** The one-line L0/L1 short: the id, the title when there is one, and the first sentence. */
export function brief(skill) {
  const title = skill.title ? ` (${skill.title})` : "";
  return `\`${skill.id}\`${title} — ${firstSentence(skill.description)}`;
}

/** The L1 card: the brief, then when to use it, what is nested under it and what is related. */
export function card(skill) {
  const lines = [brief(skill)];
  const rest = restOfDescription(skill.description);
  if (rest) lines.push(`Use when: ${rest}`);
  if (skill.children?.length) lines.push(`Nested: ${skill.children.map((c) => `\`${c}\``).join(", ")}`);
  if (skill.related?.length) lines.push(`Related: ${skill.related.map((r) => `\`${r}\``).join(", ")}`);
  return lines.join("\n");
}

/** The L2 text: the body, then where the skill lives and the files beside it. */
export function renderBody(skill) {
  const lines = [skill.body.trimEnd()];
  const where = skill.source?.dir ?? `skills/${skill.id}`;
  lines.push("", `Skill directory: ${where}`);
  if (skill.resources?.length) lines.push(`Files beside SKILL.md (skill_fetch with file): ${skill.resources.join(", ")}`);
  return lines.join("\n");
}

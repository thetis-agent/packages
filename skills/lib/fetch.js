// The `skill_fetch` tool, the L2 every loader shares: a body or a file beside it, by id, in slices. A tool
// has no `ctx.packages`, so the installed set comes from the kernel client; the same load and the same
// project switch apply as in the prompt, so the model cannot fetch what the project turned off.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectSkills } from "./load.js";
import { closest } from "./rank.js";
import { renderBody } from "./skill.js";

export const SLICE = 24000;

/** The installed packages as a tool sees them, or none when the kernel client is not there (tests). */
export async function packagesOf(env) {
  try {
    const list = await env?.kernel?.packages?.list?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Cuts `text` at `offset` into one slice and says how much is left. */
export function slice(text, offset = 0) {
  const total = text.length;
  const start = Math.min(Math.max(0, Math.floor(Number(offset) || 0)), total);
  const end = Math.min(start + SLICE, total);
  const truncated = end < total;
  let out = text.slice(start, end);
  if (truncated) out += `\n[characters ${start + 1}-${end} of ${total}; read on with offset ${end}]`;
  else if (start > 0) out += `\n[characters ${start + 1}-${total} of ${total}]`;
  return { text: out, offset: start, end, total, truncated };
}

/** `{ id, file?, offset? }` to the body of a skill, or one of the files beside it. */
export async function fetchSkill(args, env) {
  const id = String(args?.id ?? "").trim();
  if (!id) throw new Error("id is required: the id of a skill as it appears in the prompt");
  const { skills } = await selectSkills(env, await packagesOf(env), env.session);
  const skill = skills.find((s) => s.id === id);
  if (!skill) {
    const near = closest(skills, id, 5);
    throw new Error(`no skill with the id ${id}${near.length ? `; closest: ${near.join(", ")}` : ""}`);
  }
  const file = args?.file === undefined || args?.file === null ? "" : String(args.file).trim();
  let text;
  if (!file) text = renderBody(skill);
  else {
    if (!skill.resources.includes(file)) {
      throw new Error(`${id} has no file ${JSON.stringify(file)}${skill.resources.length ? `; it has: ${skill.resources.join(", ")}` : ""}`);
    }
    text = readFileSync(resolve(skill.source.dir, file), "utf8");
  }
  return slice(text, args?.offset).text;
}

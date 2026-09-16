// The two commands of @thetis/ui-skills. `skills` answers what the dock draws: the state the loader in
// force wrote for the open conversation under `harness["@thetis/skills"]` (docs/23-skills.md section 5),
// the ids the conversation's project switched off, and the catalogue every loader works from, read with
// the library's own `loadSkills` over `env.kernel.packages.list()`, so the dock never disagrees with the
// prompt. `skill` answers the rendered text of one skill so a row can open it. The exclusion comes from
// `excludedFor`, not from the harness state, so a switch flipped in the project place shows here at once,
// before the next turn. No package configuration is available to a UI command (docs/15-web-gateway.md
// section 11.4); these need none.
import { brief, excludedFor, firstSentence, lint, loadSkills, renderBody, STATE } from "@thetis/skills";

/** The loader packages the dock knows to name, for the hint when none is installed. */
export const LOADERS = ["@thetis/skills-hybrid", "@thetis/skills-l1", "@thetis/skills-all"];

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);

/** The loader's state for the turn, every field present, or the empty shape when no loader has written one. */
export function stateOf(harness) {
  const own = isRecord(harness) ? harness[STATE] : null;
  const s = isRecord(own) ? own : {};
  const pinned = Array.isArray(s.pinned) ? s.pinned.filter((p) => isRecord(p) && typeof p.id === "string") : [];
  return {
    loader: typeof s.loader === "string" && s.loader ? s.loader : null,
    universal: strings(s.universal),
    pinned: pinned.map((p) => ({ id: p.id, contentHash: typeof p.contentHash === "string" ? p.contentHash : "", score: Number.isFinite(p.score) ? p.score : null, how: typeof p.how === "string" ? p.how : "" })),
    loaded: strings(s.loaded),
    catalogue: strings(s.catalogue),
    dropped: strings(s.dropped),
    notes: strings(s.notes),
  };
}

const underAny = (id, set) => {
  for (const x of set) if (id === x || id.startsWith(`${x}/`)) return true;
  return false;
};

function row(skill, errors) {
  return {
    id: skill.id,
    name: skill.name,
    title: skill.title ?? "",
    brief: brief(skill),
    short: firstSentence(skill.description),
    description: skill.description,
    tags: skill.tags ?? [],
    universal: Boolean(skill.universal),
    package: skill.source?.package ?? null,
    contentHash: skill.contentHash,
    children: skill.children ?? [],
    error: errors.get(skill.id) ?? null,
  };
}

/**
 * `skills`: `{ data: { loader, loaders, universal, pinned, loaded, catalogue, dropped, notes, excluded, skills } }`.
 * With `env.session`, the state is the loader's for that conversation and `excluded` is what its project
 * switched off (a switched-off parent takes its nested skills with it); without one, the catalogue alone.
 */
export async function uiSkills(_args, env) {
  const packages = await env.kernel.packages.list();
  const all = loadSkills(env, packages);
  const errors = new Map();
  for (const p of lint(all)) if (p.level === "error" && !errors.has(p.id)) errors.set(p.id, p.message);
  const record = env.session ? await env.kernel.sessions.inspect(env.session) : null;
  const state = stateOf(record?.harness);
  const off = env.session ? await excludedFor(env, env.session) : new Set();
  const excluded = all.filter((s) => underAny(s.id, off)).map((s) => s.id);
  const loaders = packages.map((p) => p?.name).filter((name) => LOADERS.includes(name));
  return { data: { ...state, loaders, excluded, skills: all.map((s) => row(s, errors)) } };
}

/** `skill { id }`: the text `renderBody` makes of one skill, with the facts a header shows. */
export async function uiSkill(args, env) {
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  if (!id) throw new Error("skill needs an id.");
  const packages = await env.kernel.packages.list();
  const skill = loadSkills(env, packages).find((s) => s.id === id);
  if (!skill) throw new Error(`No skill named ${id}.`);
  const off = env.session ? await excludedFor(env, env.session) : new Set();
  return {
    data: {
      id: skill.id,
      title: skill.title ?? "",
      brief: brief(skill),
      package: skill.source?.package ?? null,
      contentHash: skill.contentHash,
      universal: Boolean(skill.universal),
      excluded: underAny(skill.id, off),
      children: skill.children ?? [],
      resources: skill.resources ?? [],
      text: renderBody(skill),
    },
  };
}

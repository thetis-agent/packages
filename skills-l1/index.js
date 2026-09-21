// Briefs in the prompt, bodies behind a tool. Nothing is in hand until the model asks for it, so this loader
// trades a round trip for a prompt that grows by one line per skill however large the packs get. A body the
// model loaded goes into the prefix on later turns and stays there, so the prefix is stable from then on.
import { selectSkills, brief, renderBody, closest, packagesOf, STATE, importCorpus as importShared, claim, readMap, corpusIds } from "@thetis/skills";
import { readLoaded, writeLoaded } from "./lib/loaded.js";

export const SELF = "@thetis/skills-l1";

/** bench: the shared importer, writing the corpus as ordinary skills under the home. */
export async function importCorpus(ctx) {
  return importShared(ctx, SELF);
}

const section = (heading, skills) => `${heading}\n\n${skills.map((s) => `## ${s.id}\n${s.body.trimEnd()}\n`).join("\n")}`;

/** prompt: the catalogue of briefs, then the universal bodies, then the bodies loaded earlier in this conversation. */
export async function catalogue(ctx) {
  const { skills, universal, excluded, notes } = await selectSkills(ctx.env, ctx.packages, ctx.session);
  const prev = ctx.harness?.[STATE];
  if (prev && typeof prev === "object" && prev.loader && prev.loader !== SELF) notes.push(`another skills loader is installed: ${prev.loader}; both run until one is removed`);
  const top = skills.filter((s) => !s.id.includes("/"));
  const universalIds = new Set(universal.map((s) => s.id));
  const byId = new Map(skills.map((s) => [s.id, s]));
  const loaded = (await readLoaded(ctx.env, ctx.session)).map((l) => byId.get(l.id)).filter((s) => s && !universalIds.has(s.id));

  const state = {
    loader: SELF,
    universal: [...universalIds],
    pinned: [],
    loaded: loaded.map((s) => s.id),
    catalogue: top.map((s) => s.id),
    dropped: [],
    excluded,
    notes,
  };
  const harness = { ...ctx.harness, [STATE]: state };
  if (!skills.length) return { harness };

  const blocks = [];
  if (top.length) {
    blocks.push(
      `# Skills you can load\nOne line per skill. load_skill with the name reads one; skill_fetch reads a nested skill or a file beside one.\n\n${top.map(brief).join("\n")}`,
    );
  }
  if (universal.length) blocks.push(section("# Skills always in force", universal));
  if (loaded.length) blocks.push(section("# Skills loaded in this conversation", loaded));
  const system = [ctx.call.system, ...blocks].filter(Boolean).join("\n\n");
  return { call: { ...ctx.call, system }, harness };
}

/** `load_skill({ name })`: the body once per conversation; a second call says it is already loaded. */
export async function loadSkill(args, env) {
  const name = String(args?.name ?? "").trim();
  if (!name) throw new Error("name is required: a skill id from the catalogue in your prompt");
  const { skills, universal } = await selectSkills(env, await packagesOf(env), env.session);
  const skill = skills.find((s) => s.id === name);
  if (!skill) {
    const near = closest(skills, name, 5);
    throw new Error(`no skill named ${name}${near.length ? `; closest: ${near.join(", ")}` : ""}`);
  }
  if (universal.some((s) => s.id === skill.id)) return `${skill.id} is always in force: its full text is already in your prompt.`;
  const loaded = await readLoaded(env, env.session);
  if (loaded.some((l) => l.id === skill.id)) {
    return `already loaded: ${skill.id} is in your prompt since an earlier turn of this conversation. Use skill_fetch to read it again or to read a file beside it.`;
  }
  await writeLoaded(env, env.session, [...loaded, { id: skill.id, contentHash: skill.contentHash, at: new Date().toISOString() }]);
  return renderBody(skill);
}

/** bench: universal and loaded bodies are in hand; every catalogue entry is one call away. */
export async function benchReport(ctx) {
  const state = ctx.harness?.[STATE] && typeof ctx.harness[STATE] === "object" ? ctx.harness[STATE] : {};
  const map = readMap(ctx.env);
  const direct = corpusIds(map, [...(state.universal ?? []), ...(state.loaded ?? [])]);
  const inHand = new Set(direct);
  return claim(ctx, SELF, undefined, {
    direct,
    offered: corpusIds(map, state.catalogue ?? []).filter((id) => !inHand.has(id)),
    reach: "catalogue",
  });
}

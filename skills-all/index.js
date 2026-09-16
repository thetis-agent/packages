// Every body in the prompt until the budget runs out. The simplest loader there is, and the one the others
// have to beat: it never chooses wrongly because it never chooses, and it pays for that in bytes on every turn.
import { selectSkills, STATE, importCorpus as importShared, claim, readMap, corpusIds } from "@thetis/skills";

export const SELF = "@thetis/skills-all";
export const DEFAULT_BUDGET = 96 * 1024;

/** bench: the shared importer, writing the corpus as ordinary skills under the home. */
export async function importCorpus(ctx) {
  return importShared(ctx, SELF);
}

/** The order bodies go in: universal first, then every other usable skill by id. */
export function orderOf(skills, universal) {
  const u = new Set(universal.map((s) => s.id));
  return [...universal, ...skills.filter((s) => !u.has(s.id)).sort((a, b) => a.id.localeCompare(b.id))];
}

/** Whole skills only, in order, until the budget is spent; the first that does not fit ends the fill. */
export function fill(order, budget) {
  const blocks = [];
  const injected = [];
  const dropped = [];
  let used = 0;
  let stopped = false;
  for (const s of order) {
    const block = `## ${s.id}\n${s.body.trimEnd()}\n`;
    const bytes = Buffer.byteLength(block, "utf8");
    if (stopped || used + bytes > budget) {
      stopped = true;
      dropped.push(s.id);
      continue;
    }
    used += bytes;
    blocks.push(block);
    injected.push(s.id);
  }
  return { blocks, injected, dropped, used };
}

/** prompt: `# Skills` with one `## <id>` section per skill, and the turn's state under `harness["@thetis/skills"]`. */
export async function inject(ctx) {
  const budget = Number(ctx.config?.budget) > 0 ? Math.floor(Number(ctx.config.budget)) : DEFAULT_BUDGET;
  const { skills, universal, excluded, notes } = await selectSkills(ctx.env, ctx.packages, ctx.session);
  const prev = ctx.harness?.[STATE];
  if (prev && typeof prev === "object" && prev.loader && prev.loader !== SELF) notes.push(`another skills loader is installed: ${prev.loader}; both run until one is removed`);
  const { blocks, injected, dropped, used } = fill(orderOf(skills, universal), budget);
  const state = {
    loader: SELF,
    universal: universal.map((s) => s.id),
    pinned: [],
    loaded: [],
    catalogue: injected,
    injected,
    dropped,
    excluded,
    budget,
    used,
    notes,
  };
  const harness = { ...ctx.harness, [STATE]: state };
  if (!blocks.length) return { harness };
  const block = `# Skills\nEach section below is one skill in full. Apply a skill when the request matches its description.\n\n${blocks.join("\n")}`;
  const system = [ctx.call.system, block].filter(Boolean).join("\n\n");
  return { call: { ...ctx.call, system }, harness };
}

/** bench: what is in the prompt, in corpus ids. Nothing is offered: this loader has no second level. */
export async function benchReport(ctx) {
  const state = ctx.harness?.[STATE] && typeof ctx.harness[STATE] === "object" ? ctx.harness[STATE] : {};
  const map = readMap(ctx.env);
  return claim(ctx, SELF, undefined, {
    direct: corpusIds(map, state.injected ?? []),
    offered: [],
    reach: "direct",
    budgetBytes: state.budget ?? DEFAULT_BUDGET,
    droppedForBudget: corpusIds(map, state.dropped ?? []),
  });
}

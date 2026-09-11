/** Attach the installed corpus whole, every turn; the budget is the only thing that cuts it.
 *
 * It declares an empty settings schema on purpose. A fixed order and a budget are the whole
 * behaviour, so a knob here could only make the answer stop being a pure function of the files
 * on disk, which is the one property this stage is worth measuring for. */
import type { LoadedSkill } from '@/lib/skills/index.ts';
import { uniqueSkills, loadInstalled } from '@/lib/skills/index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import type { RetrieveRequest, RetrieveAnswer } from '@/contracts/skills/types.ts';
import type { Content } from '@/contracts/turn-events/types.ts';

const schemas = new Schemas();
let corpus: ReturnType<typeof everything> | undefined;

interface Context { emit: (notice: { content: Content[] }) => void }

/** The corpus is read once, at registration, for the same reason `retriever-local` reads it once:
 * a turn never pays for disk, and every turn of a conversation attaches the same bytes. A pack that
 * changes is picked up at the next generation, the only moment the profile may move (ADR 0012). */
export const stages = {
  async init(_profile: unknown, context: Context): Promise<void> {
    await schemas.load();
    const loaded = await loadInstalled(schemas);
    // A pack that could not load is worth saying out loud: this stage's whole claim is that the
    // corpus is complete, so a silently missing pack turns the claim into a lie.
    for (const warning of loaded.warnings) context.emit({ content: [{ type: 'text', text: warning }] });
    corpus = everything(loaded.skills);
  },
  retrieve(request: RetrieveRequest): Promise<RetrieveAnswer> {
    return corpus?.retrieve(request) ?? Promise.resolve({ entries: [], dropped: [] });
  }
};

/** `query` and `k` are read by no line below, which is the package: there is nothing to rank, so
 * the order is fixed once here. Universal skills lead because they are the ones a person declared
 * belong in every prompt, and losing one to a budget the rest of the corpus spent would defeat the
 * declaration; the remainder follows by id, compared as code units rather than by `localeCompare`,
 * so the order is a pure function of the ids and not of the collation the host happens to carry. */
export function everything(skills: readonly LoadedSkill[]) {
  const unique = uniqueSkills(skills);
  if (!unique.ok) throw new Error(unique.error.message);
  const ordered = [...skills].sort((one, other) =>
    Number(other.card.universal) - Number(one.card.universal) || (one.card.id < other.card.id ? -1 : one.card.id > other.card.id ? 1 : 0));
  return {
    source: 'skills-all@1.0.0',
    retrieve(request: RetrieveRequest): Promise<RetrieveAnswer> {
      const forced = new Set(request.activate ?? []);
      const entries: RetrieveAnswer['entries'] = []; const dropped: string[] = [];
      let used = 0;
      for (const { card, body } of ordered) {
        // Whole skills only: a half-attached body is a skill that reads as if it ended mid-sentence,
        // which is worse for the model than the skill being absent and named in `dropped`.
        const tokens = Math.ceil(Buffer.byteLength(body) / 4);
        const fits = used + tokens <= request.budget;
        if (!fits && !forced.has(card.id)) { dropped.push(card.id); continue; }
        if (fits) used += tokens;
        // No `score`: nothing was ranked, and the schema will not take a number without a `how` that
        // explains it. Every entry is here for one reason — the corpus is here — bar the universal ones.
        entries.push({ id: card.id, pack: card.pack, version: card.version, path: card.path, contentHash: card.contentHash,
          universal: card.universal, how: card.universal ? 'universal' : 'whole-corpus',
          ...(fits ? { body } : { description: card.description }) });
      }
      return Promise.resolve({ entries, dropped });
    }
  };
}

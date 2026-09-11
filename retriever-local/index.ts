/** Port Legacy's ranker while returning bodies within the explicit retrieval budget; TE-005–008. */
import { rank } from '@/lib/bm25/index.ts';
import type { LoadedSkill } from '@/lib/skills/index.ts';
import { uniqueSkills, loadInstalled } from '@/lib/skills/index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import type { RetrieveRequest, RetrieveAnswer } from '@/contracts/skills/types.ts';
import type { Content } from '@/contracts/turn-events/types.ts';

export const settings = { fusionWeight: 0.7, absorb: true };
const schemas = new Schemas();
let corpus: ReturnType<typeof retriever> | undefined;

interface Context { emit: (notice: { content: Content[] }) => void }

/** The corpus is read once, at registration, so a turn never pays for disk and every turn of a
 * conversation ranks the same bytes. A pack that changes is picked up at the next generation,
 * which is the only moment the profile is allowed to move (ADR 0012). */
export const stages = {
  async init(_profile: unknown, context: Context): Promise<void> {
    // Dropped before the first await, not after the last: an init that fails partway leaves the
    // stage answering nothing, which is the inert package ADR 0016 asks for. Keeping the previous
    // corpus would be worse than empty, because `renderPrefix` pins each entry's `contentHash`
    // into the immutable prompt head and those bytes may no longer be installed.
    corpus = undefined;
    await schemas.load();
    const loaded = await loadInstalled(schemas);
    // A pack that could not load is worth saying out loud: silently retrieving from a smaller
    // corpus looks like a bad ranker rather than a broken pack.
    for (const warning of loaded.warnings) context.emit({ content: [{ type: 'text', text: warning }] });
    corpus = retriever(loaded.skills);
  },
  retrieve(request: RetrieveRequest): Promise<RetrieveAnswer> {
    return corpus?.retrieve(request) ?? Promise.resolve({ entries: [], dropped: [] });
  }
};
export function retriever(skills: readonly LoadedSkill[], vectors: ReadonlyMap<string, readonly number[]> = new Map(), fusionWeight = settings.fusionWeight) {
  const unique = uniqueSkills(skills);
  if (!unique.ok) throw new Error(unique.error.message);
  const byId = new Map(skills.map(skill => [skill.card.id, skill]));
  const corpus = skills.map(({ card }) => {
    const vector = vectors.get(card.id);
    return { id: card.id, text: `${card.name} ${card.description} ${card.tags.join(' ')}`, ...(vector === undefined ? {} : { vector }) };
  });
  return {
    source: 'retriever-local@1.0.0',
    retrieve(request: RetrieveRequest, vector?: readonly number[]): Promise<RetrieveAnswer> {
      const forced = [...skills.filter(skill => skill.card.universal).map(skill => skill.card.id), ...request.activate ?? []];
      const ranked = rank(corpus, request.query, request.k, vector, fusionWeight, settings.absorb);
      const scores = new Map(ranked.map(item => [item.id, item.score]));
      // `rank` scores every document 1 when the corpus fits the limit, so a bar drawn from those
      // numbers would be flat and meaningless; the reading below says so instead of showing it.
      const ranking = corpus.length <= request.k ? 'whole-corpus' : vector === undefined ? 'lexical' : 'fusion';
      const ids = [...new Set([...forced, ...ranked.map(item => item.id)])];
      const entries: RetrieveAnswer['entries'] = []; const dropped: string[] = [];
      let used = 0;
      for (const id of ids) {
        const skill = byId.get(id); if (!skill) continue;
        const tokens = Math.ceil(Buffer.byteLength(skill.body) / 4);
        const fits = used + tokens <= request.budget;
        if (!fits && !forced.includes(id)) { dropped.push(id); continue; }
        if (fits) used += tokens;
        const how = skill.card.universal ? 'universal' : request.activate?.includes(id) === true ? 'activated' : ranking;
        const score = scores.get(id);
        entries.push({ id, pack: skill.card.pack, version: skill.card.version, path: skill.card.path, contentHash: skill.card.contentHash, universal: skill.card.universal, how,
          ...(score === undefined || ranking === 'whole-corpus' ? {} : { score }), ...(fits ? { body: skill.body } : { description: skill.card.description }) });
      }
      return Promise.resolve({ entries, dropped });
    }
  };
}

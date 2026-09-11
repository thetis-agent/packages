/** Disclose skills the way the Agent Skills standard does — every name and description in the prompt,
 * a body only once the model asks for one; docs/design/skills-l1.md, TE-005–008, TE-018–020. */
import { dirname } from 'node:path';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import type { LoadedSkill } from '@/lib/skills/index.ts';
import { loadInstalled } from '@/lib/skills/index.ts';
import type { RetrieveRequest, RetrieveAnswer } from '@/contracts/skills/types.ts';
import type { CallAnswer, CallRequest, Content, Envelope, OfferRequest, ToolDef } from '@/contracts/turn-events/types.ts';

/** `loadBytes` is the ceiling on one answer: the standard asks a `SKILL.md` to stay under 500 lines,
 * and a body far past that is a pack's bug, not a prompt the person should pay for. */
export const settings = { resources: true, loadBytes: 262144 };
/** One conversation remembers a handful of ids; the bound is on how many conversations a long-lived
 * worker keeps at once, oldest forgotten first (AGENTS.md: bound every pool). */
export const defaults = { conversations: 64 };
const source = 'skills-l1@1.0.0';
const schemas = new Schemas();
let catalog: ReturnType<typeof cataloguer> | undefined;
/** The conversation whose turn is in flight. `contract/turn-events` gives a call request no
 * conversation of its own, so the stage takes it from the log it already observes: every envelope of
 * an iteration — retrieve, context, offer, the model exchange — precedes that iteration's calls. Two
 * conversations turning at once in one worker can still cross here; the catalog is in both prompts,
 * so the cost is a body sent twice or withheld once, never a skill the model cannot reach. */
let current = '';

interface Context { emit: (notice: { content: Content[] }) => void }

/** The corpus is read once, at registration, so a turn never pays for disk and every turn of a
 * conversation catalogues the same bytes; a changed pack arrives with the next generation (ADR 0012). */
export const stages = {
  source,
  async init(_profile: unknown, context: Context): Promise<void> {
    await schemas.load();
    const loaded = await loadInstalled(schemas);
    // A pack that could not load is worth saying out loud: a skill missing from the catalog is a
    // skill the model will never ask for, and silence makes that look like the model's choice.
    for (const warning of loaded.warnings) context.emit({ content: [{ type: 'text', text: warning }] });
    catalog = cataloguer(loaded.skills);
  },
  observe(event: Envelope): void { current = event.conversation; },
  retrieve(request: RetrieveRequest): Promise<RetrieveAnswer> {
    return Promise.resolve(catalog?.retrieve(request) ?? { entries: [], dropped: [] });
  },
  offer(request: OfferRequest): Promise<ToolDef[]> {
    const tool = catalog?.tool;
    return Promise.resolve(tool && (!request.mode.readOnly || tool.readOnly) ? [structuredClone(tool)] : []);
  },
  call(request: CallRequest): Promise<CallAnswer> {
    return Promise.resolve(catalog?.load(request, current) ?? refuse(request.id, 'gone', `${request.name} no longer exists.`));
  }
};

function refuse(id: string, code: NonNullable<CallAnswer['error']>['code'], message: string): CallAnswer {
  return { id, ok: false, error: { code, message } };
}
function answer(id: string, text: string): CallAnswer { return { id, ok: true, content: [{ type: 'text', text }] }; }

/** The catalog is the tool's enum, so a hallucinated name fails validation like any other bad
 * argument; naming it back is what lets the model correct itself instead of guessing again. */
function fault(args: unknown): string {
  const named = isObject(args) && typeof args['name'] === 'string' ? args['name'] : '';
  return named ? `${named} is not a skill in this catalog.` : 'load_skill takes the name of a skill in this catalog.';
}

/** Level 2, wrapped as the integration guide prescribes, so the model can tell a loaded skill from
 * the conversation around it and can find the skill's own files without another catalog. */
function wrap(skill: LoadedSkill): string {
  const { card } = skill;
  const files = ['SKILL.md', ...card.children.map(child => `${child.slice(card.id.length + 1)}/SKILL.md`)];
  // Children are resources, never catalogue entries: one Thetis skill has 65 of them, and level 3 is
  // read with the file tools from the directory below rather than paid for in every prompt.
  const resources = settings.resources && files.length > 1 ? `\n<skill_resources>${files.map(file => `<file>${file}</file>`).join('')}</skill_resources>` : '';
  return `<skill_content name="${card.id}">\n${skill.body.trim()}\n\nSkill directory: ${dirname(card.path)}${resources}\n</skill_content>`;
}

/** Level 1: the whole catalog, ranked by nothing. `query` and `k` are a ranker's arguments and this
 * stage has no ranker — the model does the matching, from the names and descriptions below. */
function catalogue(skills: readonly LoadedSkill[], request: RetrieveRequest): RetrieveAnswer {
  const entries: RetrieveAnswer['entries'] = []; const dropped: string[] = [];
  let used = 0;
  for (const { card, body } of skills) {
    const activated = request.activate?.includes(card.id) === true;
    // Level 2 is the tool's job: only a universal skill, or one the person named for this turn,
    // spends the prompt's budget on a body it may never need.
    const full = card.universal || activated;
    const tokens = Math.ceil(Buffer.byteLength(full ? body : card.description) / 4);
    const fits = used + tokens <= request.budget;
    if (!fits && !full) { dropped.push(card.id); continue; }
    if (fits) used += tokens;
    entries.push({ id: card.id, pack: card.pack, version: card.version, path: card.path, contentHash: card.contentHash,
      universal: card.universal, name: card.name, description: card.description,
      how: card.universal ? 'universal' : activated ? 'activated' : 'whole-corpus', ...(full && fits ? { body } : {}) });
  }
  return { entries, dropped };
}

export function cataloguer(skills: readonly LoadedSkill[]) {
  const byId = new Map(skills.map(skill => [skill.card.id, skill]));
  const loaded = new Map<string, Set<string>>();
  // The enum is the guide's guard against a hallucinated name. It lists ids, not the standard's
  // `name`: a name is a directory basename, and only an id stays unique once a skill has children
  // (contract/skills); for a top-level skill the two are the same string.
  const tool: ToolDef = {
    name: 'load_skill', source, readOnly: true, endsTurn: false,
    description: 'Load a skill’s full instructions by name, once the catalog says one fits the task.',
    schema: { type: 'object', properties: { name: { type: 'string', enum: [...byId.keys()] } }, required: ['name'] }
  };
  function seen(conversation: string): Set<string> {
    const known = loaded.get(conversation);
    if (known) return known;
    const oldest = loaded.size >= defaults.conversations ? loaded.keys().next().value : undefined;
    if (oldest !== undefined) loaded.delete(oldest);
    const fresh = new Set<string>(); loaded.set(conversation, fresh); return fresh;
  }
  return {
    source,
    // An empty catalog offers an enum no argument can satisfy, which is worse than no tool at all.
    tool: byId.size ? tool : undefined,
    retrieve: (request: RetrieveRequest): RetrieveAnswer => catalogue(skills, request),
    load(request: CallRequest, conversation: string): CallAnswer {
      if (request.name !== tool.name || !byId.size) return refuse(request.id, 'gone', `${request.name} no longer exists.`);
      const deny = request.mode['deny'];
      if (request.mode['readOnly'] === true && !tool.readOnly || Array.isArray(deny) && (deny.includes(tool.name) || deny.includes(`skills-l1/${tool.name}`))) {
        return refuse(request.id, 'read-only-mode', `${tool.name} is not available in this mode.`);
      }
      if (!isObject(request.args) || !schemas.arguments(tool.schema, request.args)) return refuse(request.id, 'invalid-args', fault(request.args));
      const id = typeof request.args['name'] === 'string' ? request.args['name'] : '';
      const skill = byId.get(id);
      if (!skill) return refuse(request.id, 'invalid-args', fault(request.args));
      // Deduplicated per the guide: a body already in this conversation is context the model still
      // has, and sending it twice pays for it twice.
      const already = seen(conversation);
      if (already.has(id)) return answer(request.id, `${id} is already loaded in this conversation.`);
      const text = wrap(skill);
      if (Buffer.byteLength(text) > settings.loadBytes) return refuse(request.id, 'budget', `${id} exceeds the ${String(settings.loadBytes)} byte load budget.`);
      already.add(id);
      return answer(request.id, text);
    }
  };
}

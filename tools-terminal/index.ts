/** Run a person's commands where they are, and let both the model and their own panel drive them.
 *
 * Five tools and four panel verbs reach the same set of running commands (commands.ts). That is the
 * point of the package: the agent starts a build, and the person watches it and types into it while
 * it runs, instead of reading about it afterwards in a tool result. The panel is an ordinary
 * contributed one — its verbs are declared in this package's own manifest and answered by the `call`
 * hook below, which is the route ADR 0051 opened; nothing here touches the gateway.
 *
 * A command that does not finish inside the turn's grace does not hold the turn: the answer carries
 * `pending` with a handle, and when the command ends this stage emits exactly one notice against
 * that handle (contract/turn-events, `notice`). A command a person started from the panel owes no
 * notice, because nothing in the turn is waiting on it.
 *
 * Where a command runs is the sandbox's business and not this file's: the environment is already
 * confined to the roots it was granted, so the only thing decided here is which of those to sit in.
 * `ctx.spaces` names them when a deployment configures any; otherwise the first writable root the
 * stage sees on a real tool call stands in, and the process's own directory before that.
 */
import { Schemas, isObject } from '@/lib/schema/index.ts';
import type { SpillSink } from '@/lib/spill/index.ts';
import type { CallRequest, CallAnswer, OfferRequest, Envelope } from '@/contracts/turn-events/types.ts';
import { definitions } from './definitions.ts';
import { Commands, configure, limits } from './commands.ts';
import type { Command } from './commands.ts';
import { panelCall, standing, tail, toolCall } from './answers.ts';

interface Space { path: string; mode: 'ro' | 'rw'; space: string }
interface Context {
  settings: Record<string, unknown>;
  spaces: readonly Space[];
  emit: (notice: Record<string, unknown>) => void;
}

const schemas = new Schemas();
const verbs = new Set(['start', 'output', 'input', 'stop']);
/** The conversation's mode as the last `offer` stated it. A panel command arrives with a mode of its
 *  own that says nothing about the conversation (packages/core/surface-command.ts), so this is how a
 *  read-only conversation still refuses to start anything from the panel. Until a turn has run there
 *  is nothing to read and the environment's own default stands. */
let readOnly = false;
let where = process.cwd();
let emit: (notice: Record<string, unknown>) => void = () => { /* replaced at init */ };

/** One notice per handle, and only for a command a turn is actually waiting on. */
function ended(command: Command): void {
  if (command.handle === undefined) return;
  const handle = command.handle; command.handle = undefined;
  try { emit({ handle, wake: false, content: [{ type: 'text', text: `${standing(command.status)}\n\n${tail(command)}` }] }); }
  catch { /* a notice the contract refuses is not worth taking the environment down for */ }
}

const commands = new Commands(() => where, ended);

/** Waits for a command to finish, but only for as long as a turn can be kept waiting for one. */
function grace(command: Command): Promise<void> {
  return Promise.race([command.exited, new Promise<void>(resolve => { setTimeout(resolve, limits.graceMs).unref(); })]);
}

function refuse(request: CallRequest, code: NonNullable<CallAnswer['error']>['code'], message: string): CallAnswer {
  return { id: request.id, ok: false, error: { code, message } };
}

async function fromModel(request: CallRequest, sink: SpillSink): Promise<CallAnswer> {
  const tool = definitions.find(item => item.name === request.name);
  if (!tool) return refuse(request, 'gone', `${request.name} no longer exists.`);
  if (!isObject(request.args) || !schemas.arguments(tool.schema, request.args)) return refuse(request, 'invalid-args', `${request.name} arguments do not match its schema.`);
  const deny = request.mode['deny'];
  if (request.mode['readOnly'] === true && !tool.readOnly || Array.isArray(deny) && (deny.includes(request.name) || deny.includes(`tools-terminal/${request.name}`))) {
    return refuse(request, 'read-only-mode', `${request.name} is not available in this mode.`);
  }
  const writable = request.roots.find(root => root.mode === 'rw') ?? request.roots[0];
  if (writable) where = writable.path;
  const answered = await toolCall(commands, request, sink, grace);
  if (!answered.ok) return refuse(request, answered.error.code, answered.error.message);
  const running = answered.value.pending === true;
  const id = typeof answered.value.data?.['id'] === 'string' ? answered.value.data['id'] : undefined;
  const command = id === undefined ? undefined : commands.get(id);
  if (running && command) command.handle = command.id;
  return { id: request.id, ok: true, ...(answered.value.data ? { data: answered.value.data } : {}), ...(running && command ? { pending: { handle: command.id } } : {}) };
}

function fromPanel(request: CallRequest): CallAnswer {
  const args = isObject(request.args) ? request.args : {};
  const answered = panelCall(commands, request.name, args, readOnly);
  if (!answered.ok) return refuse(request, answered.error.code, answered.error.message);
  return { id: request.id, ok: true, content: [{ type: 'text', text: JSON.stringify(answered.value) }] };
}

export const stages = {
  source: 'tools-terminal@1.0.0',
  init(_profile: unknown, ctx: Context): Promise<void> {
    configure(ctx.settings);
    const space = ctx.spaces.find(entry => entry.mode === 'rw') ?? ctx.spaces[0];
    if (space) where = space.path;
    emit = ctx.emit;
    return schemas.load();
  },
  observe(event: Envelope): void {
    if (event.type !== 'offer') return;
    const mode = event.payload['mode'];
    if (isObject(mode) && typeof mode['readOnly'] === 'boolean') readOnly = mode['readOnly'];
  },
  offer(request: OfferRequest) {
    return Promise.resolve(definitions.filter(tool => !request.mode.readOnly || tool.readOnly).map(tool => structuredClone(tool)));
  },
  async call(request: CallRequest, sink: SpillSink): Promise<CallAnswer> {
    try { return verbs.has(request.name) ? fromPanel(request) : await fromModel(request, sink); }
    catch { return refuse(request, 'io', `${request.name} could not be carried out.`); }
  },
  shutdown(): Promise<void> { return commands.close(); }
};

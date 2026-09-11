/** Turn one ask — from the model or from the panel — into what the asker gets back; TE-016, ADR 0051.
 *
 * The model and the panel drive exactly the same commands, which is the whole point: the agent
 * starts a build and the person watches it run and types into it, rather than reading about it
 * afterwards in a tool result. So the work lives here once and the two callers differ only in what
 * they are handed — the model gets text streamed into the core's sink, which is what gets spilled
 * and summarized; the panel gets one JSON body it can render, bounded well under the 64 KiB the
 * gateway will carry back (gateway-web/surface-request.ts).
 */
import type { CallRequest } from '@/contracts/turn-events/types.ts';
import type { SpillSink } from '@/lib/spill/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { limits } from './commands.ts';
import type { Command, Commands, Status } from './commands.ts';

/** What the tail of a notice may carry, so a finished command reports without flooding the prompt. */
export const noticeBytes = 2000;

const text = (args: Record<string, unknown>, name: string): string => typeof args[name] === 'string' ? args[name] : '';
const flag = (args: Record<string, unknown>, name: string, fallback: boolean): boolean => typeof args[name] === 'boolean' ? args[name] : fallback;

/** One line saying where a command stands, in the words a person would use for it. */
export function standing(status: Status): string {
  if (status.running) return `${status.name} is still running.`;
  if (status.why === 'asked') return `${status.name} was stopped.`;
  if (status.why === 'idle') return `${status.name} was stopped after going quiet for a while.`;
  if (status.why === 'flood') return `${status.name} was stopped after printing more than could be kept.`;
  return status.code === 0 ? `${status.name} finished.` : `${status.name} finished with exit code ${String(status.code ?? 0)}.`;
}

/** Everything the ring still holds for one command, in order, from `since`. Bounded by the ring
 *  itself: the core spills whatever exceeds the call's result budget into the person's own space. */
export function drain(command: Command, since: number): { text: string; next: number } {
  let at = since; let collected = '';
  for (;;) {
    const chunk = command.read(at);
    if (!chunk.text) return { text: collected, next: at };
    collected += chunk.text; at = chunk.next;
  }
}

/** The tail of what a command produced, for a notice that has to say what happened in a few lines. */
export function tail(command: Command): string {
  const whole = drain(command, 0).text;
  return whole.length <= noticeBytes ? whole : `…${whole.slice(-noticeBytes)}`;
}

function table(rows: readonly Status[]): string {
  if (!rows.length) return 'Nothing has been run here yet.\n';
  return `${rows.map(row => `${row.id}\t${row.name}\t${standing(row)}\t${row.command}`).join('\n')}\n`;
}

function found(commands: Commands, args: Record<string, unknown>): Result<Command, 'not-found'> {
  const command = commands.get(text(args, 'id'));
  return command ? { ok: true, value: command } : failure('not-found', 'There is no command here by that name.');
}

export interface Answer { data?: Record<string, number | string | boolean>; pending?: boolean }

/** The model's side. Writes its result into the sink the core handed it and reports its columns. */
export async function toolCall(commands: Commands, request: CallRequest, sink: SpillSink, grace: (command: Command) => Promise<void>): Promise<Result<Answer, 'not-found' | 'budget' | 'invalid-args' | 'tool' | 'outside-roots' | 'io'>> {
  const args = isObject(request.args) ? request.args : {};
  const say = (body: string): Promise<Result<void, 'budget' | 'outside-roots' | 'io'>> => sink.write(Buffer.from(body));
  switch (request.name) {
    case 'run_command': {
      const started = commands.start(text(args, 'command'), text(args, 'name'));
      if (!started.ok) return started;
      const command = started.value;
      await grace(command);
      const produced = drain(command, 0);
      command.cursor = produced.next;
      // A command that has not finished has to leave the model something to do next, which is the
      // name to read from; without it the answer says "still running" and stops there.
      const more = command.running ? ` Read what it prints next with read_command id ${command.id}.` : '';
      const written = await say(`${produced.text}${produced.text.endsWith('\n') || !produced.text ? '' : '\n'}${standing(command.status)}${more}\n`);
      if (!written.ok) return written;
      return { ok: true, value: { data: columnsFor(command), pending: command.running } };
    }
    case 'read_command': {
      const command = found(commands, args); if (!command.ok) return command;
      const from = flag(args, 'from_start', false) ? 0 : command.value.cursor;
      const produced = drain(command.value, from);
      command.value.cursor = produced.next;
      const written = await say(produced.text ? `${produced.text}\n${standing(command.value.status)}\n` : `Nothing new. ${standing(command.value.status)}\n`);
      return written.ok ? { ok: true, value: { data: columnsFor(command.value) } } : written;
    }
    case 'write_command': {
      const command = found(commands, args); if (!command.ok) return command;
      const body = text(args, 'text');
      if (Buffer.byteLength(body) > limits.inputBytes) return failure('invalid-args', 'That is too much to type in at once.');
      const typed = command.value.write(flag(args, 'enter', true) ? `${body}\n` : body);
      if (!typed.ok) return typed;
      const written = await say(`Typed into ${command.value.name}.\n`);
      return written.ok ? { ok: true, value: { data: columnsFor(command.value) } } : written;
    }
    case 'stop_command': {
      const command = found(commands, args); if (!command.ok) return command;
      command.value.stop('asked');
      const written = await say(`${command.value.name} was stopped.\n`);
      return written.ok ? { ok: true, value: { data: columnsFor(command.value) } } : written;
    }
    case 'list_commands': {
      const written = await say(table(commands.list()));
      return written.ok ? { ok: true, value: {} } : written;
    }
    default: return failure('not-found', `${request.name} no longer exists.`);
  }
}

function columnsFor(command: Command): Record<string, number | string | boolean> {
  const status = command.status;
  return { id: status.id, running: status.running, code: status.code ?? -1 };
}

/** The panel's side. One JSON body per ask, because the panel redraws from a whole picture rather
 *  than from a diff it would have to reconcile against whatever it drew last. */
export function panelCall(commands: Commands, verb: string, args: Record<string, unknown>, readOnly: boolean): Result<Record<string, unknown>, 'not-found' | 'budget' | 'invalid-args' | 'tool' | 'read-only-mode'> {
  const picture = (extra: Record<string, unknown> = {}): Result<Record<string, unknown>, never> =>
    ({ ok: true, value: { commands: commands.list(), readOnly, ...extra } });
  switch (verb) {
    case 'start': {
      if (readOnly) return failure('read-only-mode', 'This conversation is read-only, so nothing can be run in it.');
      const started = commands.start(text(args, 'command'), text(args, 'name'));
      return started.ok ? picture({ started: started.value.id }) : started;
    }
    case 'output': {
      const id = text(args, 'id');
      if (!id) return picture();
      const command = commands.get(id);
      if (!command) return picture();
      const since = typeof args['since'] === 'number' && Number.isSafeInteger(args['since']) ? args['since'] : 0;
      const chunk = command.read(since);
      return picture({ id, text: chunk.text, next: chunk.next, skipped: chunk.skipped });
    }
    case 'input': {
      if (readOnly) return failure('read-only-mode', 'This conversation is read-only, so nothing can be typed into it.');
      const command = found(commands, args); if (!command.ok) return command;
      const body = text(args, 'text');
      if (Buffer.byteLength(body) > limits.inputBytes) return failure('invalid-args', 'That is too much to type in at once.');
      const typed = command.value.write(body);
      return typed.ok ? picture() : typed;
    }
    case 'stop': {
      const command = found(commands, args); if (!command.ok) return command;
      command.value.stop('asked');
      return picture();
    }
    default: return failure('not-found', 'That panel is not allowed to do this.');
  }
}

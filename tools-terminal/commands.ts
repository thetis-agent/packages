/** Hold the person's running commands as stage state, bounded at every edge; TE-024, ADR 0021.
 *
 * A stage may own child processes and they are stage state rather than services: they inherit no
 * kernel socket and no run token (lib/sandbox-runner/children.ts is that path), a work restart ends
 * them, and `shutdown` must leave none behind. Everything else here is a bound, because a command a
 * person started is the one thing in this environment that can produce output for as long as it
 * likes: how many may run at once, how much of one's output is kept, how much it may produce before
 * it is stopped, and how long it may sit untouched before it is reaped.
 *
 * Output is kept as a ring of the last `bufferBytes`, addressed by absolute offset, so a reader that
 * was away can be told it missed something rather than silently resuming mid-stream. The command
 * runs under `/bin/sh -c`, which execs a single command in the common case, so stopping the shell
 * stops the work; a command that forks a tree of its own leaves that tree to the sandbox's pid
 * namespace, which ends when the environment does. Nothing here decides what a command may reach —
 * the sandbox already did that, and this file deliberately adds no second opinion about paths.
 */
import type { ChildProcess } from 'node:child_process';
import { spawnChild } from '@/lib/sandbox-runner/children.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const limits = {
  sessions: 4, bufferBytes: 262144, totalBytes: 4194304, idleMs: 300000,
  readBytes: 16384, commandBytes: 4096, inputBytes: 4096, nameBytes: 48, sweepMs: 5000, graceMs: 2000, killMs: 2000
};

/** Applies the package's declared settings over the defaults. Only the five a deployment may set are
 *  read, and only when they arrive as whole positive numbers: a bound configured into nonsense is a
 *  bound that is not there. */
export function configure(settings: Readonly<Record<string, unknown>>): void {
  for (const name of ['sessions', 'bufferBytes', 'totalBytes', 'idleMs', 'readBytes'] as const) {
    const value = settings[name];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) limits[name] = value;
  }
}

/** Why a command is no longer running. The words a person reads are the panel's; these are the facts. */
export type Why = 'itself' | 'asked' | 'idle' | 'flood';
export interface Ended { code: number | null; signal: string | null; why: Why }
export interface Status { id: string; name: string; command: string; running: boolean; code: number | null; why: Why | ''; bytes: number }
export interface Chunk { text: string; next: number; skipped: number }

/** Trims a trailing incomplete UTF-8 sequence so a read that lands mid-character does not turn the
 *  last glyph into a replacement mark; the next read starts on the byte this one declined. */
export function whole(bytes: Buffer): Buffer {
  for (let back = 1; back <= 4 && back <= bytes.length; back++) {
    const byte = bytes[bytes.length - back];
    if (byte === undefined || byte < 0x80) break;
    if (byte < 0xc0) continue;
    const wants = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return back < wants ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

export class Command {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  /** Set when a tool call answered `pending`; the one notice owed for that handle is keyed by it. */
  handle: string | undefined;
  /** Where the model's last read stopped. The panel keeps its own place in the browser, so the two
   *  read the same command without either one consuming what the other has not seen. */
  cursor = 0;
  ended: Ended | undefined;
  readonly exited: Promise<void>;
  readonly #child: ChildProcess;
  #settle: () => void = () => { /* replaced synchronously below */ };
  #asked: Why | undefined;
  #buffer = Buffer.alloc(0);
  #base = 0;
  #produced = 0;
  #touched = Date.now();

  constructor(id: string, name: string, command: string, cwd: string, onEnd: (command: Command) => void) {
    this.id = id; this.name = name; this.command = command;
    this.exited = new Promise<void>(resolve => { this.#settle = resolve; });
    this.#child = spawnChild('/bin/sh', ['-c', command], cwd, true);
    for (const stream of [this.#child.stdout, this.#child.stderr]) stream?.on('data', (chunk: Buffer) => { this.#append(chunk); });
    this.#child.once('exit', (code, signal) => { this.#finish({ code, signal, why: this.#asked ?? 'itself' }, onEnd); });
    // A command that cannot be started at all still has to end, or whoever asked for it waits for a
    // notice that is never owed. The message is the output, because there is nothing else to show.
    this.#child.once('error', () => {
      this.#append(Buffer.from('That command could not be started.\n'));
      this.#finish({ code: null, signal: null, why: 'itself' }, onEnd);
    });
  }

  get bytes(): number { return this.#produced; }
  get running(): boolean { return this.ended === undefined; }
  get idleMs(): number { return Date.now() - this.#touched; }
  /** The offset a reader who only wants what happens next should start from. */
  get end(): number { return this.#produced; }
  get status(): Status {
    return { id: this.id, name: this.name, command: this.command, running: this.running, code: this.ended?.code ?? null, why: this.ended?.why ?? '', bytes: this.#produced };
  }

  #finish(ended: Ended, onEnd: (command: Command) => void): void {
    if (this.ended) return;
    this.ended = ended; this.#touched = Date.now();
    this.#child.stdin?.end(); this.#settle(); onEnd(this);
  }

  #append(chunk: Buffer): void {
    this.#touched = Date.now();
    this.#produced += chunk.byteLength;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > limits.bufferBytes) {
      const dropped = this.#buffer.length - limits.bufferBytes;
      this.#buffer = this.#buffer.subarray(dropped); this.#base += dropped;
    }
    if (this.#produced > limits.totalBytes) this.stop('flood');
  }

  /** Reads from an absolute offset. `skipped` is what the ring dropped before the reader got back. */
  read(since: number): Chunk {
    this.#touched = Date.now();
    const wanted = Math.min(Math.max(since, 0), this.#produced);
    const from = Math.max(wanted, this.#base);
    const taken = whole(this.#buffer.subarray(from - this.#base, from - this.#base + limits.readBytes));
    return { text: taken.toString('utf8'), next: from + taken.byteLength, skipped: from - wanted };
  }

  write(text: string): Result<void, 'tool'> {
    if (!this.running) return failure('tool', `${this.name} is not running any more.`);
    const stdin = this.#child.stdin;
    if (!stdin?.writable) return failure('tool', `${this.name} is not taking any more input.`);
    this.#touched = Date.now(); stdin.write(text);
    return { ok: true, value: undefined };
  }

  stop(why: Why): void {
    if (!this.running || this.#asked) return;
    this.#asked = why;
    this.#child.kill('SIGTERM');
    // A command that ignores the polite signal still has to go, and the escalation must not hold the
    // process open on its own: an unreferenced timer lets the environment exit while one is pending.
    setTimeout(() => { if (this.#child.exitCode === null) this.#child.kill('SIGKILL'); }, limits.killMs).unref();
  }
}

export class Commands {
  readonly #commands = new Map<string, Command>();
  readonly #cwd: () => string;
  readonly #notice: (command: Command) => void;
  #sweeper: ReturnType<typeof setInterval> | undefined;
  #counter = 0;

  constructor(cwd: () => string, notice: (command: Command) => void) { this.#cwd = cwd; this.#notice = notice; }

  /** Reaps on a timer rather than on access, so a command nobody is watching is still bounded. */
  watch(): void {
    this.#sweeper ??= setInterval(() => { this.sweep(); }, limits.sweepMs).unref();
  }

  sweep(): void {
    for (const [id, command] of this.#commands) {
      if (command.idleMs < limits.idleMs) continue;
      if (command.running) command.stop('idle'); else this.#commands.delete(id);
    }
  }

  list(): Status[] { return [...this.#commands.values()].map(command => command.status); }
  get(id: string): Command | undefined { return this.#commands.get(id); }

  start(command: string, name: string): Result<Command, 'budget' | 'invalid-args'> {
    if (!command.trim()) return failure('invalid-args', 'There is no command to run.');
    if (Buffer.byteLength(command) > limits.commandBytes) return failure('invalid-args', 'That command is too long to run.');
    // Finished commands make room before the limit is reported, oldest first: being told four
    // commands are in the way when all four stopped an hour ago is a limit nobody can act on.
    for (const [id, done] of this.#commands) {
      if (this.#commands.size < limits.sessions) break;
      if (!done.running) this.#commands.delete(id);
    }
    if (this.#commands.size >= limits.sessions) return failure('budget', `Only ${String(limits.sessions)} commands can run at once. Stop one first.`);
    const id = `c${String(++this.#counter)}`;
    const started = new Command(id, name.slice(0, limits.nameBytes) || id, command, this.#cwd(), this.#notice);
    this.#commands.set(id, started); this.watch();
    return { ok: true, value: started };
  }

  /** Ends every child and forgets them; TE-024 requires a handler to leave none behind. */
  async close(): Promise<void> {
    if (this.#sweeper) { clearInterval(this.#sweeper); this.#sweeper = undefined; }
    const running = [...this.#commands.values()].filter(command => command.running);
    for (const command of running) command.stop('asked');
    await Promise.all(running.map(command => command.exited));
    this.#commands.clear();
  }
}

// Runs turns in the background and fans their events out to every connected browser of the user.
// A turn's events are buffered while it runs, so a page that connects mid-turn receives what it missed.
// Turns the hub did not start (a subagent's, one sent from the command line) reach it through
// `sessions.watch` and are carried the same way, stamped with the session's parent when it has one.
import type { KernelClient, TurnEvent, WatchedTurnEvent } from "@thetis/runtime/contracts";

export interface NumberedEvent {
  seq: number;
  event: TurnEvent;
}

export interface RunningTurn {
  session: string;
  /** The parent session, when the turn is a subagent's. */
  parent?: string;
  /** The turn id, known after `turn.start`. */
  turn?: string;
  input: string;
  /** The model the turn was asked for, when the person chose one. */
  model?: string;
  startedAt: string;
  events: NumberedEvent[];
}

export interface TurnMessage extends NumberedEvent {
  session: string;
  /** The parent session, on every message of a subagent's turn. */
  parent?: string;
  turn?: string;
  /** Set on `turn.start` only: what the user sent, so another tab can draw it. */
  input?: string;
}

export type Listener = (message: TurnMessage) => void;

export class TurnHub {
  private readonly running = new Map<string, RunningTurn>();
  private readonly listeners = new Map<string, Set<Listener>>();
  /** The turns this hub started, as `user/session`: `send` delivers their events, so the watch must not. */
  private readonly mine = new Set<string>();

  constructor(
    private readonly kernel: KernelClient,
    private readonly log: (line: string) => void = () => {},
    /** Called after `turn.end` with the complete event list of the turn. */
    private readonly onEnd: (user: string, run: RunningTurn) => void | Promise<void> = () => {},
    /** The person this hub serves, whom the kernel client acts as. With it the hub also carries the turns it did not start. */
    user?: string,
  ) {
    if (user) {
      kernel.sessions.watch((m) => this.watched(user, m)).catch((err: Error) => log(`[gateway-web] turns started elsewhere will not be shown: ${err.message}`));
    }
  }

  /**
   * Starts a turn. Resolves once the kernel has emitted its first event; rejects with the kernel's own
   * error (code `busy`, `not-found`) when the turn cannot start, so nothing is recorded in that case.
   */
  start(user: string, session: string, input: string, model?: string): Promise<RunningTurn> {
    const k = key(user, session);
    // A second sender must not clear ownership of the first sender's watch events when it is refused.
    if (this.mine.has(k) || this.running.has(k)) return Promise.reject(Object.assign(new Error(`session ${session} already has a turn in progress`), { code: "busy" }));
    return new Promise((done, fail) => {
      const run: RunningTurn = { session, input, model, startedAt: new Date().toISOString(), events: [] };
      let started = false;
      const begin = () => {
        if (started) return;
        started = true;
        this.running.set(key(user, session), run);
        done(run);
      };
      // Before `send`: the watch reports the first event before `send` does, and it must already know the turn is ours.
      this.mine.add(key(user, session));
      this.kernel.sessions
        .send(session, input, (event) => {
          begin();
          if (event.type === "turn.start") run.turn = event.turn;
          this.push(user, run, event);
        }, model ? { model } : undefined)
        .then(
          () => this.finish(user, run, begin),
          (err: Error) => {
            if (!started) {
              this.mine.delete(key(user, session));
              return fail(err);
            }
            this.log(`[gateway-web] turn failed for ${user}/${session}: ${err.message}`);
            this.push(user, run, { type: "error", message: err.message, code: "gateway" });
            this.finish(user, run, begin);
          },
        );
    });
  }

  cancel(user: string, session: string): Promise<boolean> {
    return this.kernel.sessions.cancel(session);
  }

  runningOf(user: string, session: string): RunningTurn | undefined {
    return this.running.get(key(user, session));
  }

  snapshot(user: string): RunningTurn[] {
    const prefix = `${user}/`;
    return [...this.running.entries()].filter(([k]) => k.startsWith(prefix)).map(([, run]) => run);
  }

  subscribe(user: string, fn: Listener): () => void {
    let set = this.listeners.get(user);
    if (!set) this.listeners.set(user, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(user);
    };
  }

  /**
   * A turn event the watch reported. A turn of this hub's own is ignored: `send` delivers it. Any other
   * turn opens on `turn.start`, is carried like one of ours, and ends through the same bookkeeping, so a
   * subagent's usage is recorded under its own session. The kernel replays the events so far of every
   * turn in progress when the watch opens, `turn.start` first with the moment it really started, so a hub
   * that is new (the gateway restarted with its fence) picks up the turns the old one was carrying, its
   * own included: they are watched now, not "mine". An event of a turn never seen to start is dropped.
   */
  private watched(user: string, m: WatchedTurnEvent & { startedAt?: string }): void {
    const k = key(user, m.session);
    if (this.mine.has(k)) return;
    let run = this.running.get(k);
    if (m.event.type === "turn.start") {
      run = { session: m.session, parent: m.parent, turn: m.event.turn, input: m.input ?? "", startedAt: m.startedAt ?? new Date().toISOString(), events: [] };
      this.running.set(k, run);
    }
    if (!run) return;
    this.push(user, run, m.event);
    if (m.event.type === "turn.end") this.finish(user, run, () => {});
  }

  private finish(user: string, run: RunningTurn, begin: () => void): void {
    begin();
    if (run.events.at(-1)?.event.type !== "turn.end") this.push(user, run, { type: "turn.end", turn: run.turn ?? "", session: run.session });
    this.running.delete(key(user, run.session));
    this.mine.delete(key(user, run.session));
    Promise.resolve()
      .then(() => this.onEnd(user, run))
      .catch((err: Error) => this.log(`[gateway-web] turn bookkeeping failed for ${user}/${run.session}: ${err.message}`));
  }

  private push(user: string, run: RunningTurn, event: TurnEvent): void {
    const numbered = { seq: run.events.length + 1, event };
    run.events.push(numbered);
    const message: TurnMessage = { ...numbered, session: run.session, turn: run.turn };
    if (run.parent) message.parent = run.parent;
    if (event.type === "turn.start") message.input = run.input;
    for (const fn of this.listeners.get(user) ?? []) {
      try {
        fn(message);
      } catch (err) {
        this.log(`[gateway-web] listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function key(user: string, session: string): string {
  return `${user}/${session}`;
}

// Runs turns in the background and fans their events out to every connected browser of the user.
// A turn's events are buffered while it runs, so a page that connects mid-turn receives what it missed.
import type { SessionApi, TurnEvent } from "@thetis/kernel";

export interface NumberedEvent {
  seq: number;
  event: TurnEvent;
}

export interface RunningTurn {
  session: string;
  /** The turn id, known after `turn.start`. */
  turn?: string;
  input: string;
  startedAt: string;
  events: NumberedEvent[];
}

export interface TurnMessage extends NumberedEvent {
  session: string;
  turn?: string;
  /** Set on `turn.start` only: what the user sent, so another tab can draw it. */
  input?: string;
}

export type Listener = (message: TurnMessage) => void;

export class TurnHub {
  private readonly running = new Map<string, RunningTurn>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly sessions: SessionApi,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Starts a turn. Throws the kernel's own error when the session is busy or unknown. */
  start(user: string, session: string, input: string): RunningTurn {
    const events = this.sessions.send(user, session, input);
    const run: RunningTurn = { session, input, startedAt: new Date().toISOString(), events: [] };
    this.running.set(key(user, session), run);
    void this.pump(user, run, events);
    return run;
  }

  cancel(user: string, session: string): boolean {
    return this.sessions.cancel(user, session);
  }

  isRunning(user: string, session: string): boolean {
    return this.running.has(key(user, session));
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

  private async pump(user: string, run: RunningTurn, events: AsyncIterable<TurnEvent>): Promise<void> {
    let ended = false;
    try {
      for await (const event of events) {
        if (event.type === "turn.start") run.turn = event.turn;
        this.push(user, run, event);
        ended = event.type === "turn.end";
      }
    } catch (err) {
      this.log(`[gateway-web] turn failed for ${user}/${run.session}: ${err instanceof Error ? err.message : String(err)}`);
      this.push(user, run, { type: "error", message: err instanceof Error ? err.message : String(err), code: "gateway" });
    } finally {
      if (!ended) this.push(user, run, { type: "turn.end", turn: run.turn ?? "", session: run.session });
      this.running.delete(key(user, run.session));
    }
  }

  private push(user: string, run: RunningTurn, event: TurnEvent): void {
    const numbered = { seq: run.events.length + 1, event };
    run.events.push(numbered);
    const message: TurnMessage = { ...numbered, session: run.session, turn: run.turn };
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

// Fan-out of turn events per user: the mechanism behind `sessions.watch`. A tap is a watcher a caller
// registered for one user; an emitter wraps a turn's event sink so every event also reaches that user's
// watchers, stamped with the session it belongs to. Who may watch whom is the kernel's question, not this one.
import type { TurnEvent, WatchedTurnEvent } from "@thetis/contracts";

/** What every event of one turn is stamped with. `input` rides on `turn.start` only. */
export type TapMeta = { session: string; parent?: string; input?: string };

export type Watcher = (m: WatchedTurnEvent) => void;

export class TurnTaps {
  private readonly watchers = new Map<string, Set<Watcher>>();

  /** Resolves when `signal` aborts, after the watcher is removed. Without a signal it never resolves. */
  watch(user: string, fn: Watcher, signal?: AbortSignal): Promise<void> {
    let set = this.watchers.get(user);
    if (!set) this.watchers.set(user, (set = new Set()));
    set.add(fn);
    return new Promise((done) => {
      if (!signal) return;
      const remove = () => {
        this.remove(user, fn);
        done();
      };
      if (signal.aborted) remove();
      else signal.addEventListener("abort", remove, { once: true });
    });
  }

  /** How many watchers a user has. */
  count(user: string): number {
    return this.watchers.get(user)?.size ?? 0;
  }

  /**
   * Wraps an emit: `inner` gets every event, then the user's watchers get it stamped with `meta`.
   * A watcher that throws is dropped, not propagated: the turn is the caller's, and a broken tap must not end it.
   */
  emitter(user: string, meta: TapMeta, inner: (e: TurnEvent) => void): (e: TurnEvent) => void {
    return (e) => {
      inner(e);
      const set = this.watchers.get(user);
      if (!set) return;
      const m: WatchedTurnEvent = { session: meta.session, event: e };
      if (meta.parent) m.parent = meta.parent;
      if (e.type === "turn.start" && meta.input !== undefined) m.input = meta.input;
      for (const fn of [...set]) {
        try {
          fn(m);
        } catch {
          this.remove(user, fn);
        }
      }
    };
  }

  private remove(user: string, fn: Watcher): void {
    const set = this.watchers.get(user);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this.watchers.delete(user);
  }
}

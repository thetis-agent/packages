import type { Message, SessionRecord, TurnEvent, TurnOptions, UserRecord, Userspace } from "@thetis/contracts";
import { AsyncQueue } from "@thetis/lib/async";
import { assert } from "@thetis/lib/error";
import { newId, now } from "@thetis/lib/ids";
import type { JsonDirStore } from "@thetis/lib/json-store";
import type { UserspaceLayout } from "@thetis/lib/userspace-layout";
import type { PackageManager } from "../packages/manager.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { UserStore } from "../users.js";

/** The shape of a session id. The store checks it before an id becomes a file name. */
export const SESSION_ID = /^s_[a-f0-9]+$/;

export interface SessionRef {
  id: string;
  user: string;
  parent?: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
}

export type TurnInput = string | Message[];

/** The session API: the only surface gateways and subagent-spawning steps use. Every call is authorized against a user. */
export class SessionApi {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly users: UserStore,
    private readonly userspaces: UserspaceLayout,
    private readonly packages: PackageManager,
    private readonly store: JsonDirStore<SessionRecord>,
    private readonly runner: PipelineRunner,
  ) {}

  /** Ensures the user's userspace exists and is seeded. Called on a user's first turn. */
  userspaceFor(user: UserRecord): Userspace {
    const fresh = !this.userspaces.exists(user.id);
    const us = this.userspaces.ensure(user.id);
    if (fresh || this.packages.installed(us).length === 0) this.packages.seedSystem(us);
    return us;
  }

  create(userId: string, opts: { parent?: string } = {}): SessionRef {
    const user = this.users.authorize(userId);
    const us = this.userspaceFor(user);
    if (opts.parent) this.load(us, opts.parent);
    const stamp = now();
    const rec: SessionRecord = { id: newId("s"), user: us.id, parent: opts.parent, createdAt: stamp, updatedAt: stamp, turns: 0, conversation: [], harness: {} };
    this.store.save(us.sessions, rec);
    return ref(rec);
  }

  /** `opts.model` names the model for this turn; steps may still change `call.model`. Empty means the configured default. */
  send(userId: string, sessionId: string, input: TurnInput, opts: TurnOptions = {}): AsyncIterable<TurnEvent> {
    const user = this.users.authorize(userId);
    const us = this.userspaceFor(user);
    const session = this.load(us, sessionId);
    const key = `${userId}/${sessionId}`;
    assert(!this.running.has(key), `session ${sessionId} already has a turn in progress`, "busy");
    const control = new AbortController();
    this.running.set(key, control);
    const messages: Message[] = typeof input === "string" ? [{ role: "user", content: input }] : input;
    const queue = new AsyncQueue<TurnEvent>();
    this.runner
      .runTurn(us, session, messages, (e) => queue.push(e), control.signal, opts)
      .then(() => queue.close(), (err: unknown) => queue.close(err))
      .finally(() => this.running.delete(key));
    return queue;
  }

  /** Stops the running turn of a session. Returns false when no turn is running. The turn ends with an `error` event of code `cancelled`. */
  cancel(userId: string, sessionId: string): boolean {
    this.users.authorize(userId);
    const control = this.running.get(`${userId}/${sessionId}`);
    if (!control) return false;
    control.abort();
    return true;
  }

  /**
   * Every turn running anywhere, as `user/session`. Ids and not a count, because the one caller that waits
   * on this — a restart, which ends them all — must be able to name whose turn it cut.
   */
  inFlight(): string[] {
    return [...this.running.keys()];
  }

  /** Runs a turn to completion and returns the assistant's final text. Convenient for subagents and one-shot calls. */
  async ask(userId: string, sessionId: string, input: TurnInput): Promise<string> {
    let last = "";
    for await (const e of this.send(userId, sessionId, input)) {
      if (e.type === "message" && e.message.role === "assistant") last = e.message.content;
      if (e.type === "error") throw new Error(e.message);
    }
    return last;
  }

  inspect(userId: string, sessionId: string): SessionRecord & { status: "idle" | "running" } {
    const user = this.users.authorize(userId);
    const rec = this.load(this.userspaceFor(user), sessionId);
    return { ...rec, status: this.running.has(`${userId}/${sessionId}`) ? "running" : "idle" };
  }

  list(userId: string): SessionRef[] {
    const user = this.users.authorize(userId);
    return this.store
      .list(this.userspaceFor(user).sessions)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(ref);
  }

  /** A session of this userspace only: another user's id is unknown here, whatever it names elsewhere. */
  private load(us: Userspace, id: string): SessionRecord {
    const rec = this.store.load(us.sessions, id);
    assert(rec, `unknown session ${id} for user ${us.id}`, "not-found");
    return rec;
  }
}

function ref(s: SessionRecord): SessionRef {
  return { id: s.id, user: s.user, parent: s.parent, createdAt: s.createdAt, updatedAt: s.updatedAt, turns: s.turns };
}

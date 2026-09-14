// UI state the gateway owns: which conversations each user archived, the name and the model each
// person chose for a conversation, and the accounting reported for each reply so a reopened
// transcript can show it. Kept in the gateway's own directory inside
// the userspace home. Identity lives in the kernel, not here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Usage by conversation index of the assistant message it belongs to. */
export type SessionUsage = Record<string, Record<string, number | string>>;

interface State {
  archived: Record<string, string[]>;
  usage?: Record<string, SessionUsage>;
  /** The model chosen for a conversation, keyed `user/session`. Absent means the default. */
  models?: Record<string, string>;
  /** A name the person gave a conversation, keyed `user/session`. */
  titles?: Record<string, string>;
}

export class GatewayStore {
  private readonly file: string;
  private readonly state: State;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = resolve(dir, "state.json");
    this.state = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as State) : { archived: {} };
  }

  archived(user: string): Set<string> {
    return new Set(this.state.archived[user] ?? []);
  }

  setArchived(user: string, session: string, archived: boolean): void {
    const set = this.archived(user);
    if (archived) set.add(session);
    else set.delete(session);
    this.state.archived[user] = [...set];
    this.flush();
  }

  usage(user: string, session: string): SessionUsage {
    return this.state.usage?.[`${user}/${session}`] ?? {};
  }

  /** Records the usage of the assistant messages at the given conversation indices. */
  setUsage(user: string, session: string, entries: Record<number, Record<string, number | string>>): void {
    const all = (this.state.usage ??= {});
    const key = `${user}/${session}`;
    all[key] = { ...(all[key] ?? {}), ...Object.fromEntries(Object.entries(entries).map(([i, u]) => [String(i), u])) };
    this.flush();
  }

  model(user: string, session: string): string | undefined {
    return this.state.models?.[`${user}/${session}`];
  }

  /** An empty model means the default. */
  setModel(user: string, session: string, model: string): void {
    const all = (this.state.models ??= {});
    if (model) all[`${user}/${session}`] = model;
    else delete all[`${user}/${session}`];
    this.flush();
  }

  title(user: string, session: string): string | undefined {
    return this.state.titles?.[`${user}/${session}`];
  }

  /** An empty title restores the derived one. */
  setTitle(user: string, session: string, title: string): void {
    const all = (this.state.titles ??= {});
    if (title) all[`${user}/${session}`] = title;
    else delete all[`${user}/${session}`];
    this.flush();
  }

  forget(user: string, session: string): void {
    const key = `${user}/${session}`;
    delete this.state.usage?.[key];
    delete this.state.models?.[key];
    delete this.state.titles?.[key];
    this.flush();
  }

  private flush(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}

/** The former name. */
export const ArchiveStore = GatewayStore;
export type ArchiveStore = GatewayStore;

// UI state the gateway owns: which conversations each user archived, the name and the model each
// person chose for a conversation, and the accounting reported for each reply so a reopened
// transcript can show it. Kept in the gateway's own directory inside the userspace home, one small
// file per conversation, so a change to one conversation rewrites that file and nothing else; the whole
// set is read once at start and served from memory. Identity lives in the kernel, not here.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Usage by conversation index of the assistant message it belongs to. */
export type SessionUsage = Record<string, Record<string, number | string>>;

/** What the gateway keeps about one conversation. A key left undefined is not written. */
interface Entry {
  title?: string;
  model?: string;
  usage?: SessionUsage;
  archived?: boolean;
}

/** The former single-file layout, read once to migrate it. */
interface LegacyState {
  archived: Record<string, string[]>;
  usage?: Record<string, SessionUsage>;
  models?: Record<string, string>;
  titles?: Record<string, string>;
}

/** What the gateway keeps about one person across conversations. A key left undefined is not written. */
interface Prefs {
  /** The model the person chose most recently, in any conversation; a new conversation starts with it. */
  model?: string;
}

export class GatewayStore {
  private readonly dir: string;
  private readonly prefsDir: string;
  private readonly entries = new Map<string, Entry>(); // "user/session" -> what is kept about it
  private readonly prefs = new Map<string, Prefs>(); // user -> what is kept about the person

  constructor(dir: string) {
    this.dir = resolve(dir, "sessions");
    this.prefsDir = resolve(dir, "prefs");
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.prefsDir, { recursive: true });
    this.migrate(resolve(dir, "state.json"));
    for (const user of readdirSync(this.dir)) {
      for (const file of readdirSync(resolve(this.dir, user))) {
        if (!file.endsWith(".json")) continue;
        this.entries.set(`${user}/${file.slice(0, -5)}`, JSON.parse(readFileSync(resolve(this.dir, user, file), "utf8")) as Entry);
      }
    }
    for (const file of readdirSync(this.prefsDir)) {
      if (!file.endsWith(".json")) continue;
      this.prefs.set(file.slice(0, -5), JSON.parse(readFileSync(resolve(this.prefsDir, file), "utf8")) as Prefs);
    }
  }

  /** The model the person chose last, in any conversation: what a new conversation starts with. Undefined means the default. */
  lastModel(user: string): string | undefined {
    return this.prefs.get(user)?.model;
  }

  /** Remembers the person's latest choice. An empty model means new conversations start with the default again. */
  setLastModel(user: string, model: string): void {
    const next: Prefs = { ...this.prefs.get(user), model: model || undefined };
    for (const key of Object.keys(next) as (keyof Prefs)[]) if (next[key] === undefined) delete next[key];
    const file = resolve(this.prefsDir, `${user}.json`);
    if (!Object.keys(next).length) {
      this.prefs.delete(user);
      rmSync(file, { force: true });
      return;
    }
    this.prefs.set(user, next);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, file);
  }

  archived(user: string): Set<string> {
    const out = new Set<string>();
    for (const [key, entry] of this.entries) if (entry.archived && key.startsWith(`${user}/`)) out.add(key.slice(user.length + 1));
    return out;
  }

  setArchived(user: string, session: string, archived: boolean): void {
    this.put(user, session, { archived: archived || undefined });
  }

  usage(user: string, session: string): SessionUsage {
    return this.entry(user, session).usage ?? {};
  }

  /** Records the usage of the assistant messages at the given conversation indices. */
  setUsage(user: string, session: string, entries: Record<number, Record<string, number | string>>): void {
    const usage = { ...this.usage(user, session), ...Object.fromEntries(Object.entries(entries).map(([i, u]) => [String(i), u])) };
    this.put(user, session, { usage });
  }

  model(user: string, session: string): string | undefined {
    return this.entry(user, session).model;
  }

  /** An empty model means the default. */
  setModel(user: string, session: string, model: string): void {
    this.put(user, session, { model: model || undefined });
  }

  title(user: string, session: string): string | undefined {
    return this.entry(user, session).title;
  }

  /** An empty title restores the derived one. */
  setTitle(user: string, session: string, title: string): void {
    this.put(user, session, { title: title || undefined });
  }

  forget(user: string, session: string): void {
    this.put(user, session, { usage: undefined, model: undefined, title: undefined });
  }

  private entry(user: string, session: string): Entry {
    return this.entries.get(`${user}/${session}`) ?? {};
  }

  /** Merges `patch` into the conversation's entry and writes that one file; an entry with nothing left is removed. */
  private put(user: string, session: string, patch: Entry): void {
    const next: Entry = { ...this.entry(user, session), ...patch };
    for (const key of Object.keys(next) as (keyof Entry)[]) if (next[key] === undefined) delete next[key];
    const key = `${user}/${session}`;
    const file = resolve(this.dir, user, `${session}.json`);
    if (!Object.keys(next).length) {
      this.entries.delete(key);
      rmSync(file, { force: true });
      return;
    }
    this.entries.set(key, next);
    mkdirSync(resolve(this.dir, user), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, file);
  }

  /** The one-file layout becomes per-conversation files; the old file is kept aside, not deleted. */
  private migrate(legacy: string): void {
    if (!existsSync(legacy)) return;
    const state = JSON.parse(readFileSync(legacy, "utf8")) as LegacyState;
    const split = (key: string): [string, string] => {
      const at = key.indexOf("/");
      return [key.slice(0, at), key.slice(at + 1)];
    };
    for (const [key, usage] of Object.entries(state.usage ?? {})) this.put(...split(key), { usage });
    for (const [key, model] of Object.entries(state.models ?? {})) this.put(...split(key), { model });
    for (const [key, title] of Object.entries(state.titles ?? {})) this.put(...split(key), { title });
    for (const [user, ids] of Object.entries(state.archived ?? {})) for (const id of ids) this.put(user, id, { archived: true });
    renameSync(legacy, `${legacy}.migrated`);
  }
}

/** The former name. */
export const ArchiveStore = GatewayStore;
export type ArchiveStore = GatewayStore;

// UI state the gateway owns: which conversations each user archived, the name and the model each
// person chose for a conversation, the accounting reported for each reply so a reopened transcript can
// show it, and the picture a person uploaded for themselves. Kept in the gateway's own directory inside
// the userspace home, one small file per conversation, so a change to one conversation rewrites that file
// and nothing else; the whole set is read once at start and served from memory. Identity lives in the
// kernel, not here — an avatar is decoration, which is why it may live in the gateway's own directory.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { z } from "zod";
import { parseSchema } from "@thetis/runtime/lib/validation";

const SessionUsageSchema = z.record(z.string(), z.record(z.string(), z.union([z.number(), z.string()])));
const EntrySchema = z.looseObject({
  title: z.string().optional(),
  model: z.string().optional(),
  usage: SessionUsageSchema.optional(),
  archived: z.boolean().optional(),
});
const PrefsSchema = z.looseObject({ model: z.string().optional() });
const FileIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const SessionKeySchema = z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/);
const LegacyStateSchema = z.looseObject({
  archived: z.record(FileIdSchema, z.array(FileIdSchema)).optional(),
  usage: z.record(SessionKeySchema, SessionUsageSchema).optional(),
  models: z.record(SessionKeySchema, z.string()).optional(),
  titles: z.record(SessionKeySchema, z.string()).optional(),
});

/** Usage by conversation index of the assistant message it belongs to. */
export type SessionUsage = z.infer<typeof SessionUsageSchema>;
type Entry = z.infer<typeof EntrySchema>;
type Prefs = z.infer<typeof PrefsSchema>;

function readState<S extends z.ZodType>(schema: S, file: string): z.output<S> {
  return parseSchema(schema, JSON.parse(readFileSync(file, "utf8")), `gateway state ${file}`);
}

/**
 * The picture types a person may upload, each named by the bytes an image of that type begins with. The
 * list is short on purpose. SVG is not on it: an SVG is a document that can carry script, and it would be
 * served from this person's own origin, so an uploaded one would be a way to run code as them. The check
 * is on the bytes and never on the `Content-Type` the browser declared, because the browser's word about a
 * file it was handed is the uploader's word, and the uploader is the one we are guarding against.
 */
const IMAGE_TYPES: { mime: string; ext: string; looksLike: (bytes: Buffer) => boolean }[] = [
  { mime: "image/png", ext: ".png", looksLike: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: ".jpg", looksLike: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: ".gif", looksLike: (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a" },
  // A WebP is a RIFF container whose form type sits four bytes past the length, so both markers are read.
  { mime: "image/webp", ext: ".webp", looksLike: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** The type a file on disk holds, by its extension: the reverse of `IMAGE_TYPES`, for the read at start. */
const MIME_BY_EXT = Object.fromEntries(IMAGE_TYPES.map((t) => [t.ext, t.mime]));

/** The type these bytes really are, or undefined when they are not one of the four. */
export function sniffImage(bytes: Buffer): { mime: string; ext: string } | undefined {
  const match = bytes.length >= 12 ? IMAGE_TYPES.find((t) => t.looksLike(bytes)) : undefined;
  return match ? { mime: match.mime, ext: match.ext } : undefined;
}

/** A person's uploaded picture, as the route that serves it needs it. */
export interface StoredAvatar {
  path: string;
  mime: string;
  /**
   * When the file was written, in milliseconds. It is the `v` of the URL the page draws: the response
   * carries `Cache-Control: no-store`, so this is not about caching but about the `<img>` element — a `src`
   * that did not change is not fetched again, and the person who just replaced their picture would go on
   * seeing the old one until the next reload.
   */
  at: number;
}

/**
 * A file name is built from a user id here, so the id has to be a name and never a path. The kernel already
 * refuses anything else (`[a-z][a-z0-9-]{0,31}`) and this gateway only ever serves the one person it was
 * started for, but the check belongs at the line where a name becomes a path: a `..` that reached it would
 * write outside the directory, and nothing downstream would notice.
 */
function fileNameOf(user: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(user)) throw new Error(`invalid user id: ${user}`);
  return user;
}

export class GatewayStore {
  private readonly dir: string;
  private readonly prefsDir: string;
  private readonly avatarsDir: string;
  private readonly entries = new Map<string, Entry>(); // "user/session" -> what is kept about it
  private readonly prefs = new Map<string, Prefs>(); // user -> what is kept about the person
  private readonly avatars = new Map<string, { ext: string; mime: string; at: number }>(); // user -> the picture on disk

  constructor(dir: string) {
    this.dir = resolve(dir, "sessions");
    this.prefsDir = resolve(dir, "prefs");
    this.avatarsDir = resolve(dir, "avatars");
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.prefsDir, { recursive: true });
    mkdirSync(this.avatarsDir, { recursive: true });
    this.migrate(resolve(dir, "state.json"));
    for (const user of readdirSync(this.dir)) {
      for (const file of readdirSync(resolve(this.dir, user))) {
        if (!file.endsWith(".json")) continue;
        this.entries.set(`${user}/${file.slice(0, -5)}`, readState(EntrySchema, resolve(this.dir, user, file)));
      }
    }
    for (const file of readdirSync(this.prefsDir)) {
      if (!file.endsWith(".json")) continue;
      this.prefs.set(file.slice(0, -5), readState(PrefsSchema, resolve(this.prefsDir, file)));
    }
    // Which picture each person has, and how old it is, read once. A name with any other extension is
    // skipped rather than cleaned up: a `.tmp` left by a machine that died mid-write is the only thing
    // that can be there, it is harmless, and the next upload of that type renames over it anyway.
    for (const file of readdirSync(this.avatarsDir)) {
      const ext = extname(file);
      const mime = MIME_BY_EXT[ext];
      if (!mime) continue;
      this.avatars.set(file.slice(0, -ext.length), { ext, mime, at: statSync(resolve(this.avatarsDir, file)).mtimeMs });
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

  /**
   * Where a person's picture of a given type lives. The extension is part of the name so the bytes on disk
   * and the type served with them can never drift apart: there is no sidecar to fall out of step with, and
   * a directory listing says what each file is. With no extension given, it answers the path of the picture
   * the person has now, and an empty-ish path (no extension at all) when they have none.
   */
  avatarPath(user: string, ext = this.avatars.get(user)?.ext ?? ""): string {
    return resolve(this.avatarsDir, `${fileNameOf(user)}${ext}`);
  }

  /** The picture the person has, or undefined. The file is not read here; the route sends it. */
  getAvatar(user: string): StoredAvatar | undefined {
    const held = this.avatars.get(user);
    return held ? { path: this.avatarPath(user, held.ext), mime: held.mime, at: held.at } : undefined;
  }

  /**
   * Keeps `bytes` as the person's picture and answers what it turned out to be. The type is decided here,
   * from the bytes, and the caller's opinion of it is not consulted: an upload is whatever it is, not
   * whatever it claims. Bytes that are none of the four are refused rather than kept as some default,
   * because a file the page will later hand a browser as an image has to actually be one.
   *
   * The write goes to a temp file and is renamed into place, so a reader either sees the whole old picture
   * or the whole new one and never a half-written file. Two uploads racing is two of these calls, and each
   * is synchronous from the temp write to the map: they cannot interleave, so the second simply wins, whole.
   * The rename comes before the removal of a picture of some other type, so no instant has two files for
   * one person — the order matters, because the reverse would leave the person with no picture if the
   * process died between the two steps.
   */
  setAvatar(user: string, bytes: Buffer, mime?: string): StoredAvatar {
    const kind = sniffImage(bytes);
    if (!kind) throw new Error(`that file is not a PNG, JPEG, WebP or GIF image${mime ? ` (it was sent as ${mime})` : ""}`);
    const file = this.avatarPath(user, kind.ext);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
    for (const other of IMAGE_TYPES) if (other.ext !== kind.ext) rmSync(this.avatarPath(user, other.ext), { force: true });
    const at = Date.now();
    this.avatars.set(user, { ext: kind.ext, mime: kind.mime, at });
    return { path: file, mime: kind.mime, at };
  }

  /** Removes the person's picture, whatever type it was. Removing one they never had is not an error. */
  deleteAvatar(user: string): void {
    for (const type of IMAGE_TYPES) rmSync(this.avatarPath(user, type.ext), { force: true });
    this.avatars.delete(user);
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

  /**
   * Drops everything kept about a conversation, the archive mark included; with nothing left, its file
   * goes too. The one caller is the discard of an empty conversation, where the record itself is being
   * removed: what is left behind afterwards is not state about anything, it is litter read at every start.
   * There is no second meaning here that keeps the mark — archiving a conversation that no longer exists
   * is not a thing anyone can want — so this stays one method rather than one with a flag.
   */
  forget(user: string, session: string): void {
    this.put(user, session, { usage: undefined, model: undefined, title: undefined, archived: undefined });
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
    const state = readState(LegacyStateSchema, legacy);
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

/** Keep conversation identities inside the assigned environment state; KS-004, proposal §6. */
import { mkdir, realpath, opendir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionCreateParams } from '@/contracts/kernel-socket/types.ts';
import type { Schemas, Result, Validator } from '@/lib/schema/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { resolvePath } from '@/lib/files/index.ts';
import { atomicWrite, syncDirectory } from '@/lib/files/atomic.ts';
import type { SessionInfo } from './types.ts';
import validate from './schema-validators.cjs';

export const storeLimits = { conversations: 1024, metadataBytes: 4096, titleChars: 96, previewChars: 200 };
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Epoch milliseconds, injected the way the kernel injects its own (`() => Date.now()`; kernel/main.ts).
 * `lib/events`'s `Clock` is deliberately not used here: its `now()` is `performance.now()`, a monotonic
 * reading since process start, and these stamps are compared against a browser's `Date.now()`. */
export type Now = () => number;

/** One line, whitespace collapsed, capped in code points.
 *
 * Code points, not UTF-16 units, because that is the unit JSON Schema's `maxLength` counts and the
 * schema is what this has to satisfy — cutting in code units would also leave half a character behind.
 * `Array.from` rather than a spread, which lint refuses on a string for the coarser reason that neither
 * unit is a grapheme cluster; segmenting by grapheme is not an option here, since one cluster may be
 * many code points and slicing N of them could still exceed the bound.
 *
 * Returns undefined for text with nothing in it, which is what keeps `title`/`preview` honest: the
 * schema requires a minimum length of one, so an empty message writes no field at all. */
function summarise(text: string, characters: number): string | undefined {
  const line = text.replace(/\s+/gu, ' ').trim();
  if (!line) return undefined;
  const points = Array.from(line);
  return points.length <= characters ? line : `${points.slice(0, characters - 1).join('')}\u2026`;
}

export class SessionStore {
  readonly #root: string;
  readonly #check: Validator<SessionInfo>;
  readonly #now: Now;
  #creating = false;
  private constructor(root: string, check: Validator<SessionInfo>, now: Now) { this.#root = root; this.#check = check; this.#now = now; }

  static async open(root: string, schemas: Schemas, now: Now = () => Date.now()): Promise<Result<SessionStore>> {
    try {
      const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
      if (!isObject(schema)) throw new Error('The committed session schema is invalid.');
      await mkdir(root, { recursive: true, mode: 0o700 });
      return { ok: true, value: new SessionStore(await realpath(root), schemas.precompiled<SessionInfo>(schema, validate.digest, validate), now) };
    } catch { return failure('io', 'The environment conversation state could not be opened.'); }
  }

  async list(): Promise<Result<SessionInfo[]>> {
    const names = await this.#names(); if (!names.ok) return names;
    const result: SessionInfo[] = [];
    for (const name of names.value.sort()) {
      const info = await this.info(name); if (!info.ok) return info;
      result.push(info.value);
    }
    return { ok: true, value: result };
  }

  async create(input: SessionCreateParams): Promise<Result<SessionInfo>> {
    if (this.#creating) return failure('budget', 'The environment already has an active conversation creation.');
    this.#creating = true;
    try {
      const names = await this.#names(); if (!names.ok) return names;
      if (names.value.length >= storeLimits.conversations) return failure('budget', 'The environment conversation pool is full.');
      const at = this.#now();
      const info = { id: randomUUID(), surface: input.surface, ...(input.project === undefined ? {} : { project: input.project }), createdMs: at, updatedMs: at };
      if (!this.#check(info)) return failure('invalid-args', 'The conversation metadata violates its schema.');
      const target = join(this.#root, info.id); await mkdir(target, { mode: 0o700 });
      const saved = await atomicWrite(join(target, 'metadata.json'), Buffer.from(JSON.stringify(info)));
      if (!saved.ok) { await rm(target, { recursive: true, force: true }); return saved; }
      const synced = await syncDirectory(this.#root);
      return synced.ok ? { ok: true, value: info } : synced;
    } catch { return failure('io', 'The conversation could not be created.'); }
    finally { this.#creating = false; }
  }

  async info(id: string): Promise<Result<SessionInfo>> {
    const path = await this.path(id, 'metadata.json'); if (!path.ok) return path;
    const bytes = await readBounded(path.value, storeLimits.metadataBytes); if (!bytes.ok) return bytes;
    try {
      const info: unknown = JSON.parse(bytes.value.toString('utf8'));
      return this.#check(info) && info.id === id ? { ok: true, value: info } : failure('io', 'The conversation metadata is invalid.');
    } catch { return failure('io', 'The conversation metadata could not be read.'); }
  }

  async prefixGeneration(id: string, generation: number): Promise<Result<void>> {
    const info = await this.info(id); if (!info.ok) return info;
    const value = { ...info.value, prefixGeneration: generation };
    if (!this.#check(value)) return failure('invalid-args', 'The conversation prefix generation is invalid.');
    return this.#save(id, value);
  }

  /** Records the newest thing said in a conversation: its `preview` always, and its `title` when it
   * has none yet, so the first message names the conversation and nothing renames it afterwards.
   * `updatedMs` moves on every call, including one whose text summarises to nothing — a conversation
   * that has just been spoken to sorts first whether or not the words survived the cap. That stamp is
   * also the merge key the web sidebar orders replies by, so it must move on every recorded change. */
  async record(id: string, text: string): Promise<Result<void>> {
    const info = await this.info(id); if (!info.ok) return info;
    const preview = summarise(text, storeLimits.previewChars);
    const title = info.value.title ?? summarise(text, storeLimits.titleChars);
    const value = { ...info.value, ...(title === undefined ? {} : { title }),
      ...(preview === undefined ? {} : { preview }), updatedMs: this.#now() };
    if (!this.#check(value)) return failure('invalid-args', 'The conversation summary violates its schema.');
    return this.#save(id, value);
  }

  /** Moves a conversation in or out of the archive. Storage only: no gateway command reaches this yet
   * (runtime TODO.md, "Carry conversation archiving to the wire"), so the flag is written by tests and
   * by any future caller, and the web sidebar already filters an archived row out of its list. */
  async archive(id: string, archived: boolean): Promise<Result<void>> {
    const info = await this.info(id); if (!info.ok) return info;
    const value = { ...info.value, archived, updatedMs: this.#now() };
    if (!this.#check(value)) return failure('invalid-args', 'The conversation archive flag violates its schema.');
    return this.#save(id, value);
  }

  async #save(id: string, value: SessionInfo): Promise<Result<void>> {
    const path = await this.path(id, 'metadata.json', true); if (!path.ok) return path;
    return atomicWrite(path.value, Buffer.from(JSON.stringify(value)));
  }

  async path(id: string, name: 'metadata.json' | 'conversation.jsonl', write = false): Promise<Result<string>> {
    if (!identifier.test(id)) return failure('not-found', 'The conversation does not exist in this environment.');
    const directory = await resolvePath(id, [{ path: this.#root, mode: 'rw', space: 'state' }]); if (!directory.ok) return directory;
    return resolvePath(name, [{ path: directory.value, mode: 'rw', space: 'state' }], write);
  }

  async #names(): Promise<Result<string[]>> {
    const names: string[] = [];
    try {
      for await (const entry of await opendir(this.#root)) {
        if (!entry.isDirectory() || !identifier.test(entry.name)) return failure('io', 'The environment conversation state contains an invalid entry.');
        if (names.length >= storeLimits.conversations) return failure('budget', 'The environment conversation pool is full.');
        names.push(entry.name);
      }
      return { ok: true, value: names };
    } catch { return failure('io', 'The environment conversations could not be listed.'); }
  }
}

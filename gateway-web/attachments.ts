/** Keep an attached image inside its own conversation's directory, named by its content; ADR 0005, ADR 0019.
 *
 * An attachment is a file the input *refers to*, never bytes the input carries:
 * `contract/turn-events#input.attachments` names `path` and `hash`, and core's `sessionLimits.inputBytes`
 * caps a whole submitted input at 64 KiB, so a 3 MB photograph cannot travel inside one. Nor can it travel
 * inside a wire frame — `lib/websocket`'s `messageBytes` caps a frame at 1 MiB, and base64 costs a third
 * again. So the bytes arrive over the same-origin POST this module backs, land here, and the `send` frame
 * that follows names them.
 *
 * Where "here" is: the gateway process is spawned `scope: 'person'` with one writable mount, `/state`
 * (kernel/generations/prepare.ts), which is this person's and no one else's. A conversation gets its own
 * directory under it, named by the conversation's own identifier, and nothing this module does can write
 * outside one: the identifier must match the shape core's session-store mints, the stored file is named
 * from the content hash rather than from anything a person typed, and both the directory and the file are
 * canonicalised through `resolvePath` against the root before use, so a symlink planted in the tree is
 * refused rather than followed.
 *
 * Naming the file `<sha256>.<subtype>` rather than by the person's own filename does three things at once:
 * two people attaching the same picture cost one copy, re-attaching one costs nothing, and the name the
 * browser chose — which is attacker-controlled text — never reaches the filesystem at all. It survives
 * only as the `name` field, which is a label to show and nothing else.
 *
 * Not built here: reaping. Nothing deletes an attachment once a turn has referred to it, because nothing
 * yet knows when the last reference goes away. The bound that does exist is the target's own 64 MiB state
 * quota; past it a write fails and the person is told plainly to try a smaller image.
 */
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@/lib/files/atomic.ts';
import { resolvePath } from '@/lib/files/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

/** Exactly `contract/turn-events#$defs/input.attachments[]`; this is what `session.submit` receives. */
export interface Descriptor { name: string; mime: string; bytes: number; hash: string; path: string }
/** The three numbers gateway-web/index.ts owns, passed in rather than imported so a test can shrink them. */
export interface Limits { attachmentBytes: number; attachments: number; attachmentTypes: readonly string[] }

/** The shape core's session-store mints (packages/core/session-store.ts); anything else names no conversation. */
const conversationName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** What this module writes, and therefore the only thing it will read back or hand out. */
const storedName = /^(?<digest>[0-9a-f]{64})\.(?<suffix>[a-z0-9]{2,5})$/u;
const hashName = /^sha256:(?<digest>[0-9a-f]{64})$/u;

/** The whole allow-list, in the one form this module can both store and serve. `image/png` becomes the file
 * suffix `png` and back again, so the stored name alone carries the type and no sidecar can disagree with
 * the bytes. A type whose subtype is not a plain suffix — `image/svg+xml` — has no such name and is refused
 * at construction rather than silently dropped, so a widened list fails loudly instead of half-working. */
function suffixes(types: readonly string[]): Result<Map<string, string>, 'invalid-args'> {
  const table = new Map<string, string>();
  for (const type of types) {
    const suffix = type.startsWith('image/') ? type.slice('image/'.length) : '';
    if (!/^[a-z0-9]{2,5}$/u.test(suffix)) return failure('invalid-args', 'An allowed attachment type has no safe file name.');
    table.set(type, suffix);
  }
  return { ok: true, value: table };
}

/** What a person called the file, reduced to a label. Separators and control characters are removed rather
 * than refused: the name never names anything on disk, so a strange one is a cosmetic problem, not a risk. */
function label(name: unknown, suffix: string): string {
  const raw = typeof name === 'string' ? name : '';
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}/\\]/gu, ' ').trim().slice(0, 128);
  return cleaned === '' ? `image.${suffix}` : cleaned;
}

function megabytes(bytes: number): string {
  return String(Math.round(bytes / 1048576));
}

export class Attachments {
  readonly #root: string;
  readonly #limits: Limits;
  readonly #suffixes: ReadonlyMap<string, string>;
  private constructor(root: string, limits: Limits, types: ReadonlyMap<string, string>) {
    this.#root = root; this.#limits = limits; this.#suffixes = types;
  }

  /** Refuses an unusable allow-list here, at start-up, rather than on the first upload of the day. */
  static open(root: string, limits: Limits): Result<Attachments, 'invalid-args'> {
    const types = suffixes(limits.attachmentTypes); if (!types.ok) return types;
    return { ok: true, value: new Attachments(root, limits, types.value) };
  }

  /** The person-facing sentence for each refusal, said once here so http.ts and wire.ts cannot disagree. */
  get tooLarge(): string { return `That image is too large — the limit is ${megabytes(this.#limits.attachmentBytes)} MB.`; }
  get wrongType(): string { return 'Only images can be attached.'; }
  get tooMany(): string { return `You can attach up to ${String(this.#limits.attachments)} images to a message.`; }

  /** Store one uploaded image and describe it. The only way bytes enter this tree. */
  async save(conversation: string, name: unknown, mime: unknown, body: Buffer): Promise<Result<Descriptor>> {
    const suffix = typeof mime === 'string' ? this.#suffixes.get(mime) : undefined;
    if (suffix === undefined || typeof mime !== 'string') return failure('invalid-args', this.wrongType);
    if (body.byteLength === 0) return failure('invalid-args', 'That file is empty.');
    if (body.byteLength > this.#limits.attachmentBytes) return failure('budget', this.tooLarge);
    const directory = await this.#directory(conversation, true); if (!directory.ok) return directory;
    const digest = createHash('sha256').update(body).digest('hex');
    const path = join(directory.value, `${digest}.${suffix}`);
    const written = await atomicWrite(path, body);
    if (!written.ok) return failure('io', 'That image could not be saved. Try a smaller one.');
    return { ok: true, value: { name: label(name, suffix), mime, bytes: body.byteLength, hash: `sha256:${digest}`, path } };
  }

  /** Check the descriptors a `send` frame names against what is actually on disk, and hand back the list
   * `session.submit` may have. Nothing the browser said about `path` is believed: the path is rebuilt from
   * the conversation, the hash and the type, so a frame naming another conversation's file — or anywhere
   * else on the filesystem — fails the comparison instead of being opened. */
  async accept(conversation: string, values: readonly unknown[] | undefined): Promise<Result<Descriptor[]>> {
    if (!values?.length) return { ok: true, value: [] };
    if (values.length > this.#limits.attachments) return failure('budget', this.tooMany);
    const directory = await this.#directory(conversation, false); if (!directory.ok) return directory;
    const accepted: Descriptor[] = [];
    for (const value of values) {
      if (!isObject(value)) return failure('invalid-args', 'That file is no longer available. Add it again.');
      const suffix = typeof value['mime'] === 'string' ? this.#suffixes.get(value['mime']) : undefined;
      if (suffix === undefined || typeof value['mime'] !== 'string') return failure('invalid-args', this.wrongType);
      const digest = typeof value['hash'] === 'string' ? hashName.exec(value['hash'])?.groups?.['digest'] : undefined;
      if (digest === undefined) return failure('invalid-args', 'That file is no longer available. Add it again.');
      const path = join(directory.value, `${digest}.${suffix}`);
      if (value['path'] !== path) return failure('invalid-args', 'That file is no longer available. Add it again.');
      const size = await this.#size(path); if (!size.ok) return size;
      if (size.value > this.#limits.attachmentBytes) return failure('budget', this.tooLarge);
      accepted.push({ name: label(value['name'], suffix), mime: value['mime'], bytes: size.value, hash: `sha256:${digest}`, path });
    }
    return { ok: true, value: accepted };
  }

  /** Resolve one stored file for reading back, so the transcript can show what was attached. The name must
   * be one this module wrote — a content hash and a known suffix — which is what keeps this from being a
   * read of any file the request cares to name. */
  async file(conversation: string, name: string): Promise<Result<{ path: string; mime: string; bytes: number }>> {
    const parts = storedName.exec(name)?.groups;
    const mime = parts ? `image/${String(parts['suffix'])}` : '';
    if (!parts || !this.#suffixes.has(mime)) return failure('not-found', 'That image is no longer available.');
    const directory = await this.#directory(conversation, false); if (!directory.ok) return directory;
    const path = join(directory.value, name);
    const resolved = await resolvePath(name, [{ path: directory.value, mode: 'ro', space: 'this conversation' }]);
    if (!resolved.ok || resolved.value !== path) return failure('not-found', 'That image is no longer available.');
    const size = await this.#size(path); if (!size.ok) return size;
    return { ok: true, value: { path, mime, bytes: size.value } };
  }

  /** The conversation's own directory, canonical and provably under the root. Created only for a write, so
   * reading back an unknown conversation cannot leave an empty directory behind for every id ever guessed. */
  async #directory(conversation: string, write: boolean): Promise<Result<string>> {
    if (!conversationName.test(conversation)) return failure('not-found', 'That conversation could not be found.');
    const root = join(this.#root, 'attachments');
    try { if (write) await mkdir(join(root, conversation), { recursive: true, mode: 0o700 }); }
    catch { return failure('io', 'That image could not be saved. Try a smaller one.'); }
    const resolved = await resolvePath(conversation, [{ path: root, mode: write ? 'rw' : 'ro', space: 'this conversation' }], write);
    if (!resolved.ok) return failure('not-found', 'That conversation could not be found.');
    return resolved;
  }

  async #size(path: string): Promise<Result<number>> {
    try {
      const info = await stat(path);
      if (!info.isFile()) return failure('not-found', 'That image is no longer available.');
      return { ok: true, value: info.size };
    } catch { return failure('not-found', 'That image is no longer available.'); }
  }
}

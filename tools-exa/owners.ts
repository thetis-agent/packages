/** Keep shared-account run IDs private to their authenticated owners across restarts; EXA-008. */
import { lstat } from 'node:fs/promises';
import { atomicWrite } from '@/lib/files/atomic.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Owners as Ledger } from './types.ts';
import type { ApiSchemas } from './schema.ts';
export const ownerLimits = { bytes: 2097152, recordBytes: 2048 };
export class Owners {
  readonly #runs: Ledger['runs']; readonly #path: string; readonly #limit: number;
  #bytes: number; #pending = 0; #failed = false; #tail: Promise<unknown> = Promise.resolve();
  private constructor(path: string, runs: Ledger['runs'], limit: number) { this.#path = path; this.#runs = runs; this.#limit = limit; this.#bytes = Buffer.byteLength(JSON.stringify({ version: 1, runs })); }
  static async open(path: string, schemas: ApiSchemas, limit: number): Promise<Result<Owners>> {
    try {
      const info = await lstat(path);
      if (!info.isFile()) return failure('io', 'The Exa run ledger is not a regular file.');
      const read = await readBounded(path, ownerLimits.bytes); if (!read.ok) return read;
      const value: unknown = JSON.parse(read.value.toString('utf8'));
      if (!schemas.validator<Ledger>('owners')(value) || new Set(value.runs.map(run => run.id)).size !== value.runs.length || value.runs.length > limit) return failure('invalid-args', 'The Exa run ledger is invalid.');
      return { ok: true, value: new Owners(path, value.runs, limit) };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return failure('io', 'The Exa run ledger could not be read.');
      const saved = await atomicWrite(path, Buffer.from(JSON.stringify({ version: 1, runs: [] })));
      return saved.ok ? { ok: true, value: new Owners(path, [], limit) } : saved;
    }
  }
  check(id: string, person: string, stop = false): Result<void, 'tool' | 'invalid-args'> {
    const owner = this.#runs.find(run => run.id === id && run.person === person);
    if (!owner) return failure('tool', 'This Exa run does not belong to the caller.');
    return stop && owner.effort !== 'max' ? failure('invalid-args', 'Only max-effort Exa runs support early stop.') : { ok: true, value: undefined };
  }
  room(): boolean { return !this.#failed && this.#runs.length + this.#pending < this.#limit && this.#pending < 16 && this.#bytes + (this.#pending + 1) * ownerLimits.recordBytes <= ownerLimits.bytes; }
  begin(): Result<() => void, 'budget'> {
    if (!this.room()) return failure('budget', 'The Exa run ledger is full or unavailable.');
    this.#pending++; let ended = false;
    return { ok: true, value: () => { if (!ended) { ended = true; this.#pending--; } } };
  }
  save(id: string, person: string, effort: string): Promise<Result<void>> {
    if (this.#failed || this.#runs.length >= this.#limit || this.#runs.some(run => run.id === id)) return Promise.resolve(failure('budget', 'The Exa run could not be recorded.'));
    const record = { id, person, effort };
    if (Buffer.byteLength(JSON.stringify(record)) + 1 > ownerLimits.recordBytes) return Promise.resolve(failure('budget', 'The Exa ownership record exceeds its byte limit.'));
    this.#runs.push(record); const bytes = Buffer.from(JSON.stringify({ version: 1, runs: this.#runs })); this.#bytes = bytes.length;
    const result = this.#tail.then(async () => {
      if (this.#failed) return failure('io', 'The Exa run ledger is unavailable.');
      const saved = await atomicWrite(this.#path, bytes); if (!saved.ok) this.#failed = true; return saved;
    });
    this.#tail = result; return result;
  }
}

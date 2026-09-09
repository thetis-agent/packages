/** Resolve password evidence only through the designated kernel authority; KS-006–007, ADR 0018 §2. */
import { basename, dirname } from 'node:path';
import type { IdentityAssertParams } from '../../contracts/kernel-socket/types.ts';
import { resolvePath } from '../../lib/files/index.ts';
import { readFile } from 'node:fs/promises';
import { readBounded } from '../../lib/files/read-bounded.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import type { Schemas, Result, Validator } from '../../lib/schema/index.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { Accounts, Credential, Login, Session } from './types.ts';
import { verify } from './password.ts';

export const settings = { accountsBytes: 1048576, identities: 4096, attempts: 5, windowMs: 60000 };
export type AssertIdentity = (params: IdentityAssertParams) => Promise<Result<unknown>>;

export class PasswordAuthority {
  readonly #accounts: ReadonlyMap<string, Credential>;
  readonly #attempts = new Map<string, { at: number; count: number }>();
  readonly #assert: AssertIdentity;
  readonly #clock: Clock;
  readonly #input: Validator<Login>;
  readonly #session: Validator<Session>;
  private constructor(accounts: Accounts, assert: AssertIdentity, clock: Clock, input: Validator<Login>, session: Validator<Session>) {
    this.#accounts = new Map(accounts.accounts.map(account => [account.id, structuredClone(account)]));
    this.#assert = assert; this.#clock = clock; this.#input = input; this.#session = session;
  }

  static async open(path: string, schemas: Schemas, clock: Clock, assert: AssertIdentity): Promise<Result<PasswordAuthority>> {
    const raw: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
    if (!isObject(raw)) throw new Error('The committed password authority schema is invalid.');
    const canonical = await resolvePath(basename(path), [{ path: dirname(path), mode: 'ro', space: 'password state' }]); if (!canonical.ok) return canonical;
    const read = await readBounded(canonical.value, settings.accountsBytes); if (!read.ok) return read;
    let accounts: unknown;
    try { accounts = JSON.parse(read.value.toString('utf8')); } catch { return failure('invalid-args', 'The password state has invalid JSON.'); }
    if (!schemas.compile<Accounts>(raw)(accounts)) return failure('invalid-args', 'The password state violates its schema.');
    if (new Set(accounts.accounts.map(account => account.id)).size !== accounts.accounts.length) return failure('collision', 'The password state has duplicate identities.');
    const input = schemas.compile<Login>({ ...raw, $id: 'thetis://internal/password-input/1', $ref: '#/$defs/login' });
    const session = schemas.compile<Session>({ ...raw, $id: 'thetis://internal/password-session/1', $ref: '#/$defs/session' });
    return { ok: true, value: new PasswordAuthority(accounts, assert, clock, input, session) };
  }

  async login(input: unknown): Promise<Result<Session>> {
    if (!this.#input(input)) return failure('invalid-args', 'The login request violates its schema.');
    const admitted = this.#admit(input.id); if (!admitted.ok) return admitted;
    const checked = await verify(input.password, this.#accounts.get(input.id)); if (!checked.ok) return checked;
    if (!checked.value) return failure('auth', 'The password proof was refused.');
    const resolved = await this.#assert({ kind: 'password', id: input.id, evidence: { verified: true } }); if (!resolved.ok) return resolved;
    if (!this.#session(resolved.value)) return failure('protocol', 'The kernel returned an invalid identity session.');
    return { ok: true, value: { sessionToken: resolved.value.sessionToken, person: resolved.value.person, role: resolved.value.role } };
  }

  #admit(id: string): Result<void> {
    const now = this.#clock.now();
    for (const [key, value] of this.#attempts) if (now - value.at >= settings.windowMs) this.#attempts.delete(key);
    const previous = this.#attempts.get(id);
    if (!previous && this.#attempts.size >= settings.identities || previous && previous.count >= settings.attempts) return failure('budget', 'The password attempt limit was reached.');
    this.#attempts.set(id, { at: previous?.at ?? now, count: (previous?.count ?? 0) + 1 });
    return { ok: true, value: undefined };
  }
}

/** Resolve the thetis_session cookie to a kernel identity on every request and once per WebSocket
 * upgrade, trusting the kernel's answer and never the request path; ADR 0038 §4, KS-023. */
import type { Peer } from '../../lib/socket/index.ts';
import { cookie } from '../../lib/http/index.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';

export interface Signed { person: string; role: string }

/** Extract only the named cookie, then decode it; a malformed percent-encoding reads as no cookie
 * at all rather than throwing past this edge. */
export function sessionToken(header: string | undefined): string | undefined {
  const raw = cookie(header, 'thetis_session');
  if (raw === undefined) return undefined;
  try { return decodeURIComponent(raw); } catch { return undefined; }
}

/** One instance per connection: the pending-call bound is per connection, not shared across the service. */
export class SignIn {
  readonly #peer: Peer;
  readonly #limit: number;
  #pending = 0;

  constructor(peer: Peer, limit: number) { this.#peer = peer; this.#limit = limit; }

  /** Any failure — absent cookie, kernel refusal, a malformed answer — reads as "not signed in"; never the token in the message. */
  async check(token: string | undefined): Promise<Result<Signed>> {
    if (token === undefined) return failure('auth', 'Sign in to continue.');
    if (this.#pending >= this.#limit) return failure('budget', 'Too many pending identity checks.');
    this.#pending++;
    try {
      const result = await this.#peer.call('session.whois', { sessionToken: token });
      if (!result.ok || !isObject(result.value) || typeof result.value['person'] !== 'string' || typeof result.value['role'] !== 'string') return failure('auth', 'Sign in to continue.');
      return { ok: true, value: { person: result.value['person'], role: result.value['role'] } };
    } catch { return failure('auth', 'Sign in to continue.'); }
    finally { this.#pending--; }
  }
}

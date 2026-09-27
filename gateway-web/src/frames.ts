// The tokens behind `f/<token>/…`: a document served into a sandboxed iframe has an opaque origin, so
// nothing it loads — its images, its fonts, its stylesheets — carries the login cookie (SameSite=Strict
// stays home). The page, signed in, mints a token for one frame command and its arguments; the browser then
// fetches under that token with no cookie at all, and the token is the whole credential. It names one
// person, one package, one verb and one set of arguments, so a leaked token reads that one thing and nothing
// else, for as long as it lives. Kept in memory: a gateway serves one person, and a restart invalidating
// every token costs the page one mint.
import { randomBytes } from "node:crypto";
import type { UserRole } from "@thetis/runtime/contracts";

export interface FrameRecord {
  user: string;
  role: UserRole;
  pkg: string;
  verb: string;
  args: Record<string, unknown>;
}

interface Held extends FrameRecord {
  at: number;
  expiresAt: number;
}

export const TOKEN = /^[a-f0-9]{64}$/;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PER_USER = 64;

export class FrameTokens {
  private readonly held = new Map<string, Held>();
  private readonly ttlMs: number;
  private readonly perUser: number;
  private readonly now: () => number;
  private readonly random: () => string;

  constructor(opts: { ttlMs?: number; perUser?: number; now?: () => number; random?: () => string } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.perUser = opts.perUser ?? DEFAULT_PER_USER;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? (() => randomBytes(32).toString("hex"));
  }

  /** A fresh token for `record`. The expired ones go first, then the person's oldest past the cap. */
  mint(record: FrameRecord): string {
    const now = this.now();
    this.sweep(now);
    const mine = [...this.held.entries()].filter(([, h]) => h.user === record.user).sort((a, b) => a[1].at - b[1].at);
    for (const [token] of mine.slice(0, Math.max(0, mine.length + 1 - this.perUser))) this.held.delete(token);
    const token = this.random();
    this.held.set(token, { ...record, args: { ...record.args }, at: now, expiresAt: now + this.ttlMs });
    return token;
  }

  /** The record a token names, or undefined for one unknown or expired (and forgotten then). */
  lookup(token: string): FrameRecord | undefined {
    const held = this.held.get(token);
    if (!held) return undefined;
    if (held.expiresAt <= this.now()) {
      this.held.delete(token);
      return undefined;
    }
    // A copy, so an export handed these arguments cannot change what the token means for the next request.
    const { at: _at, expiresAt: _expiresAt, ...record } = held;
    return { ...record, args: { ...record.args } };
  }

  revoke(token: string): void {
    this.held.delete(token);
  }

  revokeUser(user: string): void {
    for (const [token, held] of this.held) if (held.user === user) this.held.delete(token);
  }

  get size(): number {
    return this.held.size;
  }

  private sweep(now: number): void {
    for (const [token, held] of this.held) if (held.expiresAt <= now) this.held.delete(token);
  }
}

import { timingSafeEqual } from "node:crypto";
import { SYSTEM_USER, type UserRecord } from "@thetis/contracts";
import { randomHex, scryptHex } from "@thetis/lib/crypto";
import { assert } from "@thetis/lib/error";
import { now } from "@thetis/lib/ids";
import type { StoreMirror } from "@thetis/lib/store";
import type { UserStore } from "./users.js";

export interface Credential {
  salt: string;
  hash: string;
}

export interface TokenRecord {
  user: string;
  createdAt: string;
}

/** Verified against when the user has no password, so a login attempt costs the same either way. */
const EMPTY: Credential = { salt: "00".repeat(16), hash: "00".repeat(64) };
const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Identity for network gateways: a password per user and the login tokens issued against it. Both live
 * in private namespaces of the service plane's store. A gateway verifies a token here and then acts for that user.
 */
export class AuthService {
  constructor(
    private readonly credentials: StoreMirror<Credential>,
    private readonly tokens: StoreMirror<TokenRecord>,
    private readonly users: UserStore,
    private readonly tokenTtlMs = TOKEN_TTL_MS,
  ) {}

  hasPassword(id: string): boolean {
    return this.credentials.has(id);
  }

  /** Sets a password and revokes every token of the user. */
  async setPassword(id: string, password: string): Promise<void> {
    assert(this.users.get(id), `unknown user: ${id}`);
    assert(id !== SYSTEM_USER, "the system user cannot sign in");
    assert(password.length > 0, "password must not be empty");
    const salt = randomHex(16);
    this.credentials.set(id, { salt, hash: await scryptHex(password, salt) });
    for (const [token, rec] of this.tokens.all()) if (rec.user === id) this.tokens.delete(token);
  }

  /** Verifies the pair and issues a token. The work is the same whether or not the user exists. */
  async login(id: string, password: string): Promise<{ token: string; user: UserRecord } | undefined> {
    const cred = this.credentials.get(id) ?? EMPTY;
    const hash = Buffer.from(await scryptHex(password, cred.salt), "hex");
    const expected = Buffer.from(cred.hash, "hex");
    const ok = hash.length === expected.length && timingSafeEqual(hash, expected) && this.credentials.has(id);
    if (!ok) return undefined;
    let user: UserRecord;
    try {
      user = this.users.authorize(id);
    } catch {
      return undefined;
    }
    const token = randomHex(32);
    this.tokens.set(token, { user: id, createdAt: now() });
    return { token, user };
  }

  /** The active user a token stands for, or undefined when the token is unknown, expired, or the user may not act. */
  authenticate(token: string): UserRecord | undefined {
    const rec = this.tokens.get(token);
    if (!rec) return undefined;
    if (Date.now() - Date.parse(rec.createdAt) > this.tokenTtlMs) {
      this.logout(token);
      return undefined;
    }
    try {
      return this.users.authorize(rec.user);
    } catch {
      return undefined;
    }
  }

  logout(token: string): void {
    if (this.tokens.has(token)) this.tokens.delete(token);
  }
}

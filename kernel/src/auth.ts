import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { SYSTEM_USER, type UserRecord } from "@thetis/contracts";
import { randomHex, scryptHex } from "@thetis/lib/crypto";
import { assert } from "@thetis/lib/error";
import { now } from "@thetis/lib/ids";
import { JsonFile } from "@thetis/lib/json";
import type { UserStore } from "./users.js";

interface Credential {
  salt: string;
  hash: string;
}

interface TokenRecord {
  user: string;
  createdAt: string;
}

interface AuthFile {
  credentials: Record<string, Credential>;
  tokens: Record<string, TokenRecord>;
}

/** Verified against when the user has no password, so a login attempt costs the same either way. */
const EMPTY: Credential = { salt: "00".repeat(16), hash: "00".repeat(64) };
const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Identity for network gateways: a password per user and the login tokens issued against it.
 * Lives in the service plane. A gateway verifies a token here and then acts for that user.
 */
export class AuthService {
  private readonly file: JsonFile<AuthFile>;

  constructor(home: string, private readonly users: UserStore, private readonly tokenTtlMs = TOKEN_TTL_MS) {
    this.file = new JsonFile(resolve(home, "auth.json"), { credentials: {}, tokens: {} }, 0o600);
  }

  private get data(): AuthFile {
    return this.file.value;
  }

  hasPassword(id: string): boolean {
    return id in this.data.credentials;
  }

  /** Sets a password and revokes every token of the user. */
  async setPassword(id: string, password: string): Promise<void> {
    assert(this.users.get(id), `unknown user: ${id}`);
    assert(id !== SYSTEM_USER, "the system user cannot sign in");
    assert(password.length > 0, "password must not be empty");
    const salt = randomHex(16);
    this.data.credentials[id] = { salt, hash: await scryptHex(password, salt) };
    for (const [token, rec] of Object.entries(this.data.tokens)) if (rec.user === id) delete this.data.tokens[token];
    this.file.save();
  }

  /** Verifies the pair and issues a token. The work is the same whether or not the user exists. */
  async login(id: string, password: string): Promise<{ token: string; user: UserRecord } | undefined> {
    const cred = this.data.credentials[id] ?? EMPTY;
    const hash = Buffer.from(await scryptHex(password, cred.salt), "hex");
    const expected = Buffer.from(cred.hash, "hex");
    const ok = hash.length === expected.length && timingSafeEqual(hash, expected) && id in this.data.credentials;
    if (!ok) return undefined;
    let user: UserRecord;
    try {
      user = this.users.authorize(id);
    } catch {
      return undefined;
    }
    const token = randomHex(32);
    this.data.tokens[token] = { user: id, createdAt: now() };
    this.file.save();
    return { token, user };
  }

  /** The active user a token stands for, or undefined when the token is unknown, expired, or the user may not act. */
  authenticate(token: string): UserRecord | undefined {
    const rec = this.data.tokens[token];
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
    if (!(token in this.data.tokens)) return;
    delete this.data.tokens[token];
    this.file.save();
  }
}

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { SYSTEM_USER, type UserRecord } from "./types.js";
import type { UserStore } from "./users.js";
import { assert, now, readJson, writeJson } from "./util.js";

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

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const EMPTY: Credential = { salt: "00".repeat(16), hash: "00".repeat(64) };

/**
 * Identity for network gateways: a password per user and the login tokens issued against it.
 * Lives in the service plane. A gateway verifies a token here and then acts for that user.
 */
export class AuthService {
  private readonly file: string;
  private readonly data: AuthFile;

  constructor(home: string, private readonly users: UserStore, private readonly tokenTtlMs = 30 * 24 * 60 * 60_000) {
    this.file = resolve(home, "auth.json");
    this.data = readJson<AuthFile>(this.file, { credentials: {}, tokens: {} });
  }

  hasPassword(id: string): boolean {
    return id in this.data.credentials;
  }

  /** Sets a password and revokes every token of the user. */
  async setPassword(id: string, password: string): Promise<void> {
    assert(this.users.get(id), `unknown user: ${id}`);
    assert(id !== SYSTEM_USER, "the system user cannot sign in");
    assert(password.length > 0, "password must not be empty");
    const salt = randomBytes(16).toString("hex");
    this.data.credentials[id] = { salt, hash: await derive(password, salt) };
    for (const [token, rec] of Object.entries(this.data.tokens)) if (rec.user === id) delete this.data.tokens[token];
    this.flush();
  }

  /** Verifies the pair and issues a token. The work is the same whether or not the user exists. */
  async login(id: string, password: string): Promise<{ token: string; user: UserRecord } | undefined> {
    const cred = this.data.credentials[id] ?? EMPTY;
    const hash = Buffer.from(await derive(password, cred.salt), "hex");
    const expected = Buffer.from(cred.hash, "hex");
    const ok = hash.length === expected.length && timingSafeEqual(hash, expected) && id in this.data.credentials;
    if (!ok) return undefined;
    let user: UserRecord;
    try {
      user = this.users.authorize(id);
    } catch {
      return undefined;
    }
    const token = randomBytes(32).toString("hex");
    this.data.tokens[token] = { user: id, createdAt: now() };
    this.flush();
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
    this.flush();
  }

  private flush(): void {
    writeJson(this.file, this.data, 0o600);
  }
}

function derive(password: string, salt: string): Promise<string> {
  return new Promise((done, fail) => {
    scrypt(password, Buffer.from(salt, "hex"), 64, SCRYPT, (err, key) => (err ? fail(err) : done(key.toString("hex"))));
  });
}

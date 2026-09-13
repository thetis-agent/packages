// Gateway-owned state: password credentials, login tokens, and per-user archive flags.
// Kept in the gateway's own directory under the data dir. The kernel knows nothing of it.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

export interface Credential {
  salt: string;
  hash: string;
}

export interface TokenRecord {
  user: string;
  createdAt: string;
}

interface State {
  archived: Record<string, string[]>;
}

/** Three small JSON files, each written atomically. */
export class GatewayStore {
  private readonly accounts: Record<string, Credential>;
  private readonly tokens: Record<string, TokenRecord>;
  private readonly state: State;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.accounts = this.read("accounts.json", {});
    this.tokens = this.read("tokens.json", {});
    this.state = this.read("state.json", { archived: {} });
  }

  // ---- passwords ----

  async setPassword(user: string, password: string): Promise<void> {
    if (!password) throw new Error("password must not be empty");
    const salt = randomBytes(16).toString("hex");
    this.accounts[user] = { salt, hash: await derive(password, salt) };
    this.write("accounts.json", this.accounts);
  }

  hasPassword(user: string): boolean {
    return user in this.accounts;
  }

  /** Constant work whether or not the user exists, so a probe cannot tell the two apart by timing. */
  async verify(user: string, password: string): Promise<boolean> {
    const cred = this.accounts[user] ?? { salt: "00".repeat(16), hash: "00".repeat(64) };
    const hash = Buffer.from(await derive(password, cred.salt), "hex");
    const expected = Buffer.from(cred.hash, "hex");
    return hash.length === expected.length && timingSafeEqual(hash, expected) && user in this.accounts;
  }

  // ---- login tokens ----

  issue(user: string): string {
    const token = randomBytes(32).toString("hex");
    this.tokens[token] = { user, createdAt: new Date().toISOString() };
    this.write("tokens.json", this.tokens);
    return token;
  }

  lookup(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const rec = this.tokens[token];
    if (!rec) return undefined;
    if (Date.now() - Date.parse(rec.createdAt) > TOKEN_TTL_MS) {
      this.revoke(token);
      return undefined;
    }
    return rec.user;
  }

  revoke(token: string): void {
    if (!(token in this.tokens)) return;
    delete this.tokens[token];
    this.write("tokens.json", this.tokens);
  }

  /** Drops every token of a user, for example after a password change. */
  revokeUser(user: string): void {
    for (const [token, rec] of Object.entries(this.tokens)) if (rec.user === user) delete this.tokens[token];
    this.write("tokens.json", this.tokens);
  }

  // ---- archive ----

  archived(user: string): Set<string> {
    return new Set(this.state.archived[user] ?? []);
  }

  setArchived(user: string, session: string, archived: boolean): void {
    const set = this.archived(user);
    if (archived) set.add(session);
    else set.delete(session);
    this.state.archived[user] = [...set];
    this.write("state.json", this.state);
  }

  // ---- files ----

  private read<T>(name: string, fallback: T): T {
    const file = resolve(this.dir, name);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  }

  private write(name: string, value: unknown): void {
    const file = resolve(this.dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }
}

function derive(password: string, salt: string): Promise<string> {
  return new Promise((done, fail) => {
    scryptCb(password, Buffer.from(salt, "hex"), 64, SCRYPT, (err, key) => (err ? fail(err) : done(key.toString("hex"))));
  });
}

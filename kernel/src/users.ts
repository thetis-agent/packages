import { resolve } from "node:path";
import { assert, now, readJson, writeJson } from "./util.js";
import { SYSTEM_USER, type UserRecord, type UserRole, type UserStatus } from "./types.js";

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Identity store: one record per user, persisted in the service plane. */
export class UserStore {
  private readonly file: string;
  private users: Record<string, UserRecord>;

  constructor(home: string) {
    this.file = resolve(home, "users.json");
    this.users = readJson<Record<string, UserRecord>>(this.file, {});
    if (!this.users[SYSTEM_USER]) {
      this.users[SYSTEM_USER] = { id: SYSTEM_USER, role: "system", status: "active", createdAt: now() };
      this.flush();
    }
  }

  list(): UserRecord[] {
    return Object.values(this.users);
  }

  get(id: string): UserRecord | undefined {
    return this.users[id];
  }

  /** Returns the user only if it exists and may act; throws otherwise. */
  authorize(id: string): UserRecord {
    const user = this.users[id];
    assert(user, `unknown user: ${id}`, "unauthorized");
    assert(user.status === "active", `user ${id} is suspended`, "unauthorized");
    return user;
  }

  create(id: string, role: UserRole = "user"): UserRecord {
    assert(USER_ID.test(id), `invalid user id: ${id} (use [a-z][a-z0-9-]{0,31})`);
    assert(!this.users[id], `user already exists: ${id}`);
    const user: UserRecord = { id, role, status: "active", createdAt: now() };
    this.users[id] = user;
    this.flush();
    return user;
  }

  setStatus(id: string, status: UserStatus): UserRecord {
    return this.update(id, { status });
  }

  setRole(id: string, role: UserRole): UserRecord {
    assert(role !== "system", "the system role cannot be assigned");
    return this.update(id, { role });
  }

  remove(id: string): void {
    assert(id !== SYSTEM_USER, "the system user cannot be removed");
    assert(this.users[id], `unknown user: ${id}`);
    delete this.users[id];
    this.flush();
  }

  private update(id: string, patch: Partial<UserRecord>): UserRecord {
    const user = this.users[id];
    assert(user, `unknown user: ${id}`);
    assert(user.role !== "system", "the system user cannot be modified");
    Object.assign(user, patch);
    this.flush();
    return user;
  }

  private flush(): void {
    writeJson(this.file, this.users);
  }
}

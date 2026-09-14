import { resolve } from "node:path";
import { SYSTEM_USER, type UserRecord, type UserRole, type UserStatus } from "@thetis/contracts";
import { assert } from "@thetis/lib/error";
import { now } from "@thetis/lib/ids";
import { JsonFile } from "@thetis/lib/json";

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Identity store: one record per user, persisted in the service plane. */
export class UserStore {
  private readonly file: JsonFile<Record<string, UserRecord>>;

  constructor(home: string) {
    this.file = new JsonFile(resolve(home, "users.json"), {});
    if (!this.users[SYSTEM_USER]) {
      this.users[SYSTEM_USER] = { id: SYSTEM_USER, role: "system", status: "active", createdAt: now() };
      this.file.save();
    }
  }

  private get users(): Record<string, UserRecord> {
    return this.file.value;
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
    this.file.save();
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
    this.file.save();
  }

  private update(id: string, patch: Partial<UserRecord>): UserRecord {
    const user = this.users[id];
    assert(user, `unknown user: ${id}`);
    assert(user.role !== "system", "the system user cannot be modified");
    Object.assign(user, patch);
    this.file.save();
    return user;
  }
}

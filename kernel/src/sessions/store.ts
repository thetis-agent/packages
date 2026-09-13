import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionRecord, Userspace } from "../types.js";
import { assert, newId, now, readJson, writeJson } from "../util.js";

/** Persists sessions as JSON files inside the owning userspace. */
export class SessionStore {
  create(us: Userspace, parent?: string): SessionRecord {
    const stamp = now();
    const rec: SessionRecord = { id: newId("s"), user: us.id, parent, createdAt: stamp, updatedAt: stamp, turns: 0, conversation: [], harness: {} };
    this.save(us, rec);
    return rec;
  }

  load(us: Userspace, id: string): SessionRecord {
    const file = this.file(us, id);
    assert(existsSync(file), `unknown session ${id} for user ${us.id}`, "not-found");
    return readJson<SessionRecord>(file, undefined as never);
  }

  save(us: Userspace, rec: SessionRecord): void {
    rec.updatedAt = now();
    writeJson(this.file(us, rec.id), rec);
  }

  list(us: Userspace): SessionRecord[] {
    if (!existsSync(us.sessions)) return [];
    return readdirSync(us.sessions)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<SessionRecord>(resolve(us.sessions, f), undefined as never))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private file(us: Userspace, id: string): string {
    assert(/^s_[a-f0-9]+$/.test(id), `invalid session id: ${id}`);
    return resolve(us.sessions, `${id}.json`);
  }
}

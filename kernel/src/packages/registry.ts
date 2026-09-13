import { resolve } from "node:path";
import { readJson, writeJson } from "../util.js";
import type { PackageRecord } from "../types.js";

/** Service-plane record of what packages exist, who owns them, and where they are installed. */
export class PackageRegistry {
  private readonly file: string;
  private records: Record<string, PackageRecord>;

  constructor(home: string) {
    this.file = resolve(home, "registry.json");
    this.records = readJson<Record<string, PackageRecord>>(this.file, {});
  }

  get(name: string): PackageRecord | undefined {
    return this.records[name];
  }

  all(): PackageRecord[] {
    return Object.values(this.records);
  }

  installedIn(userspace: string): PackageRecord[] {
    return this.all().filter((r) => r.userspaces.includes(userspace));
  }

  record(rec: Omit<PackageRecord, "userspaces">, userspace: string): PackageRecord {
    const existing = this.records[rec.name];
    const userspaces = existing ? existing.userspaces.filter((u) => u !== userspace) : [];
    const next = { ...rec, userspaces: [...userspaces, userspace] };
    this.records[rec.name] = next;
    writeJson(this.file, this.records);
    return next;
  }

  unlink(name: string, userspace: string): void {
    const rec = this.records[name];
    if (!rec) return;
    rec.userspaces = rec.userspaces.filter((u) => u !== userspace);
    if (rec.userspaces.length === 0) delete this.records[name];
    writeJson(this.file, this.records);
  }

  forgetUserspace(userspace: string): void {
    for (const name of Object.keys(this.records)) this.unlink(name, userspace);
  }
}

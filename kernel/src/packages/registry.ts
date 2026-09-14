import { resolve } from "node:path";
import type { PackageRecord } from "@thetis/contracts";
import { JsonFile } from "@thetis/lib/json";

/** Service-plane record of what packages exist, who owns them, and where they are installed. */
export class PackageRegistry {
  private readonly file: JsonFile<Record<string, PackageRecord>>;

  constructor(home: string) {
    this.file = new JsonFile(resolve(home, "registry.json"), {});
  }

  private get records(): Record<string, PackageRecord> {
    return this.file.value;
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
    // A promoted fork is installed into every userspace in turn; the first install that displaced something must not lose it.
    const kept = { ...(existing?.everyone ? { everyone: true } : {}), ...(existing?.replaced && !rec.replaced ? { replaced: existing.replaced, replacedSource: existing.replacedSource } : {}) };
    const next = { ...rec, userspaces: [...userspaces, userspace], ...kept };
    this.records[rec.name] = next;
    this.file.save();
    return next;
  }

  /** Marks a package as the default for everyone, or unmarks it. */
  setEveryone(name: string, on: boolean): void {
    const rec = this.records[name];
    if (!rec) return;
    if (on) rec.everyone = true;
    else delete rec.everyone;
    this.file.save();
  }

  /** The packages every new person is seeded with. */
  everyone(): string[] {
    return this.all().filter((r) => r.everyone).map((r) => r.name);
  }

  unlink(name: string, userspace: string): void {
    const rec = this.records[name];
    if (!rec) return;
    rec.userspaces = rec.userspaces.filter((u) => u !== userspace);
    if (rec.userspaces.length === 0) delete this.records[name];
    this.file.save();
  }

  forgetUserspace(userspace: string): void {
    for (const name of Object.keys(this.records)) this.unlink(name, userspace);
  }
}

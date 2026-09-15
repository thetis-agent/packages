import { resolve } from "node:path";
import type { Mount } from "@thetis/contracts";
import { JsonFile } from "./json.js";

/** The per-user mount lists in `<home>/mounts.json`: `{ "<user>": [ { path, mode } ] }`. Who may set one is the caller's decision. */
export class MountStore {
  private readonly file: JsonFile<Record<string, Mount[]>>;

  constructor(home: string) {
    this.file = new JsonFile(resolve(home, "mounts.json"), {});
  }

  /** A copy of one person's list; empty when none. */
  get(user: string): Mount[] {
    return (this.file.value[user] ?? []).map((m) => ({ ...m }));
  }

  all(): Record<string, Mount[]> {
    return Object.fromEntries(Object.keys(this.file.value).map((u) => [u, this.get(u)]));
  }

  /** Replaces one person's list; an empty list removes the entry. */
  set(user: string, mounts: Mount[]): void {
    if (mounts.length) this.file.value[user] = mounts.map((m) => ({ path: m.path, mode: m.mode }));
    else delete this.file.value[user];
    this.file.save();
  }
}

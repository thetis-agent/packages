// UI state the gateway owns: which conversations each user archived. Kept in the gateway's own directory
// inside the userspace home. Identity lives in the kernel, not here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface State {
  archived: Record<string, string[]>;
}

export class ArchiveStore {
  private readonly file: string;
  private readonly state: State;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = resolve(dir, "state.json");
    this.state = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as State) : { archived: {} };
  }

  archived(user: string): Set<string> {
    return new Set(this.state.archived[user] ?? []);
  }

  setArchived(user: string, session: string, archived: boolean): void {
    const set = this.archived(user);
    if (archived) set.add(session);
    else set.delete(session);
    this.state.archived[user] = [...set];
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}

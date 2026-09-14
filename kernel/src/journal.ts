import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { now } from "./util.js";

/** One row of the journal. `observed` rows are what the kernel saw; `reported` values inside them came from package code. */
export interface JournalRow {
  at: string;
  kind: string;
  actor?: string;
  target?: string;
  data?: Record<string, unknown>;
}

const MAX_BYTES = 16 * 1024 * 1024;

/**
 * The append-only record of what happened: operator acts, turns, services. One JSON object per line in
 * `$THETIS_HOME/journal.jsonl`; when it outgrows the limit it rolls to `journal.1.jsonl` and starts over.
 */
export class Journal {
  private readonly file: string;

  constructor(home: string, private readonly maxBytes = MAX_BYTES) {
    this.file = resolve(home, "journal.jsonl");
  }

  append(row: Omit<JournalRow, "at">): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) renameSync(this.file, this.file.replace(/\.jsonl$/, ".1.jsonl"));
      appendFileSync(this.file, JSON.stringify({ at: now(), ...row }) + "\n");
    } catch (err) {
      console.error(`[journal] could not write: ${(err as Error).message}`);
    }
  }

  /** The newest rows first, at most `limit`, optionally only those about one actor or target. */
  tail(limit = 200, filter: { actor?: string; target?: string; kind?: string } = {}): JournalRow[] {
    if (!existsSync(this.file)) return [];
    const rows: JournalRow[] = [];
    const lines = readFileSync(this.file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
      if (!lines[i]) continue;
      try {
        const row = JSON.parse(lines[i]) as JournalRow;
        if ((filter.actor && row.actor !== filter.actor) || (filter.target && row.target !== filter.target) || (filter.kind && row.kind !== filter.kind)) continue;
        rows.push(row);
      } catch {
        continue;
      }
    }
    return rows;
  }
}

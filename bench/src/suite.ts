// A suite on disk: what to ask, what each task needed, and how the provider should answer. Everything here
// is data the bench owns; no package can edit it, and the held-back split never leaves the host.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Split = "tune" | "holdout" | "holdback";

export interface Task {
  id: string;
  /** The query, exactly as authored. The bench never prefixes or tags it: a retriever matches on this. */
  query: string;
  required?: string[];
  helpful?: string[];
  forbidden?: string[];
  /** Tools the task needs, named `package/tool@major` so a rename breaks loudly instead of matching nothing. */
  tools?: string[];
  /** The tool groups (corpus ids) a routing mechanism should admit for this task. Empty for a control. */
  groups?: string[];
  /** A label for the kind of query, so a report can be split by it: `direct`, `paraphrase`, `scenario`, `control`. */
  family?: string;
  budget?: { k_max?: number; token_max?: number };
  split?: Split;
  tags?: string[];
  /** Spans a variant may rewrite. Everything else is corpus vocabulary and must be left alone. */
  mutable?: Record<string, string>;
  /** A task no capability should help with. An arm that bloats the prompt must not harm these. */
  control?: boolean;
  /** How many turns to drive. More than one is how prefix stability becomes measurable. */
  turns?: number;
}

export interface SuiteDef {
  id: string;
  version: string;
  /** `A` needs no model; `B` pins one and costs money. */
  probe: "A" | "B";
  corpus?: string;
  description?: string;
  tasks: Task[];
  script?: unknown;
  runs?: number;
  /** Reference mechanisms the bench ships with the suite, as paths relative to the suite directory. */
  fixtures?: string[];
  /** Packages every arm gets, the floor included, as paths relative to the suite directory: how a corpus of tools reaches every arm. */
  base?: string[];
}

export function loadSuite(dir: string): SuiteDef {
  const suite = JSON.parse(readFileSync(join(dir, "suite.json"), "utf8")) as SuiteDef;
  const tasksPath = join(dir, "tasks.jsonl");
  if (existsSync(tasksPath)) {
    suite.tasks = readFileSync(tasksPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Task);
  }
  const scriptPath = join(dir, "script.json");
  if (existsSync(scriptPath)) suite.script = JSON.parse(readFileSync(scriptPath, "utf8"));
  validateSuite(suite);
  return suite;
}

export function validateSuite(suite: SuiteDef): void {
  if (!suite.id || !suite.version) throw new Error("a suite needs an id and a version");
  if (!Array.isArray(suite.tasks) || !suite.tasks.length) throw new Error(`suite ${suite.id} has no tasks`);
  const seen = new Set<string>();
  for (const task of suite.tasks) {
    if (!task.id || !task.query) throw new Error(`suite ${suite.id} has a task with no id or query`);
    if (seen.has(task.id)) throw new Error(`suite ${suite.id} repeats the task id ${task.id}`);
    seen.add(task.id);
  }
}

/** `holdback` never ships with the suite; it lives outside the packages tree and outside every fence. */
export function visible(suite: SuiteDef, splits: readonly Split[] = ["tune", "holdout"]): Task[] {
  return suite.tasks.filter((t) => splits.includes(t.split ?? "tune"));
}

export function strata(tasks: readonly Task[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const task of tasks) for (const tag of task.tags ?? ["untagged"]) out[tag] = (out[tag] ?? 0) + 1;
  return out;
}

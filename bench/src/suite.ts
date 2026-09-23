// A suite on disk: what to ask, what each task needed, and how the provider should answer. Everything here
// is data the bench owns; no package can edit it, and the held-back split never leaves the host.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import { parseSchema } from "@thetis/runtime/lib/validation";
import { SuiteSchema, TaskSchema, type Split, type SuiteDef, type Task } from "./schemas.js";
import { parseJson, parseJsonLines } from "./json.js";
export type { Split, Task, SuiteDef } from "./schemas.js";

export function loadSuite(dir: string): SuiteDef {
  const suite = parseJson(z.record(z.string(), z.unknown()), readFileSync(join(dir, "suite.json"), "utf8"), `suite ${dir}/suite.json`);
  const tasksPath = join(dir, "tasks.jsonl");
  if (existsSync(tasksPath)) suite.tasks = parseJsonLines(TaskSchema, readFileSync(tasksPath, "utf8"), `suite ${tasksPath}`);
  const scriptPath = join(dir, "script.json");
  if (existsSync(scriptPath)) suite.script = parseJson(z.unknown(), readFileSync(scriptPath, "utf8"), `suite ${scriptPath}`);
  return validateSuite(suite);
}

export function validateSuite(raw: unknown): SuiteDef {
  const suite = parseSchema(SuiteSchema, raw, "suite");
  const seen = new Set<string>();
  for (const task of suite.tasks) {
    if (seen.has(task.id)) throw new Error(`suite ${suite.id} repeats the task id ${task.id}`);
    seen.add(task.id);
  }
  return suite;
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

// Validating `thetis.bench`. Deliberately not in the kernel: the kernel never reads this field, a malformed
// one cannot hurt a turn, and the useful error — "the adapter you named is not declared as a bench step" —
// belongs where the author is working, not in the pipeline.
import { ThetisFieldSchema } from "@thetis/runtime/schemas";
import { parseSchema } from "@thetis/runtime/lib/validation";
import { BENCH_PHASE } from "./arena.js";

export function validateBench(name: string, raw: unknown): string[] {
  let thetis;
  try { thetis = parseSchema(ThetisFieldSchema, raw, `${name}: thetis`); }
  catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  const bench = thetis.bench;
  if (!bench) return [];
  const problems: string[] = [];
  const steps = thetis.steps ?? [];
  const benchExports = new Set(steps.filter((s) => s.phase === BENCH_PHASE).map((s) => s.export));

  if (!bench.suites.length) {
    problems.push(`${name}: thetis.bench.suites must name at least one suite`);
  } else if (bench.suites.some((s) => !s.includes("@"))) {
    problems.push(`${name}: every suite is named id@version, for example skill-recall@1`);
  }

  for (const role of ["importer", "adapter"] as const) {
    const named = bench[role];
    if (named === undefined) continue;
    if (!benchExports.has(named)) {
      problems.push(
        `${name}: thetis.bench.${role} is "${named}", which is not declared in thetis.steps with phase "${BENCH_PHASE}" — that declaration is how it is called, and it is why it cannot run outside a bench`,
      );
    }
  }

  if (bench.corpus && !bench.importer) {
    problems.push(`${name}: a package that imports a corpus must name its importer`);
  }
  if (bench.arms && new Set(bench.arms).size !== bench.arms.length) {
    problems.push(`${name}: thetis.bench.arms repeats a name`);
  }
  for (const arm of Object.keys(bench.armConfig ?? {})) {
    if (!bench.arms?.includes(arm)) problems.push(`${name}: thetis.bench.armConfig names "${arm}", which is not in thetis.bench.arms`);
  }
  for (const step of steps) {
    if (step.phase === BENCH_PHASE && !bench.suites?.length) {
      problems.push(`${name}: step "${step.id}" is declared in the bench phase but the package opts into no suite`);
    }
  }
  return problems;
}

// `bench run` and `bench verify`. The run boots a throwaway kernel, drives every arm over the suite, and
// writes one report per suite plus a view inside each participating package.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Arena, type Arm } from "./arena.js";
import { comparable, participants, readParticipant, type Participant } from "./peers.js";
import { buildReport, readViews, renderMarkdown, sha256, viewFor, writeMarkdown, writePackageView, writeSuiteReport, SCORER, type ReportInputs } from "./report.js";
import { writeChart } from "./chart.js";
import { runSuite, type Observation } from "./runner.js";
import { latencyRatio, summarise } from "./score.js";
import { loadSuite, visible, type SuiteDef, type Task } from "./suite.js";
import { hasCorpus, loadCorpus } from "./corpus.js";
import { validateBench } from "./manifest.js";
import { seedOf } from "./metrics/stats.js";
import { routingOf } from "./metrics/routing.js";

export const FLOOR = "none";
/** Every participating package at once: the harness as installed. */
export const ALL = "all";

export interface RunArgs {
  project: string;
  suiteDir: string;
  /** Extra package directories to bench. Anything under `packages/` that opted in is found without this. */
  packages?: string[];
  roots?: string[];
  sandbox?: "auto" | "bwrap" | "none";
  write?: boolean;
  force?: boolean;
  /** Put a real model in the loop. Costs money; the ceiling is enforced by the provider, mid-run. */
  model?: string;
  maxCostUsd?: number;
  /** Take only the first n tasks. Sensible only with a model; a free run should take the whole suite. */
  limit?: number;
  out?: string;
  runId?: string;
  log?: (line: string) => void;
}

const armIdFor = (p: Participant): string => p.name.replace(/^@/, "").replace("/", "-");

export async function run(args: RunArgs): Promise<{ report: ReturnType<typeof buildReport>; wrote: string[] }> {
  const log = args.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const suite = loadSuite(args.suiteDir);
  const everyTask = visible(suite);
  // With a model answering, a whole suite is a bill rather than a run: one task of the skills suite cost about
  // twelve cents on a cheap model. Say how many to take.
  const tasks = args.limit ? everyTask.slice(0, args.limit) : everyTask;
  const roots = args.roots ?? [resolve(args.project, "packages")];

  const corpus = hasCorpus(args.suiteDir) ? loadCorpus(args.suiteDir) : null;
  if (corpus) log(`  corpus ${corpus.id}: ${corpus.records.length} records, ${corpus.sha256.slice(0, 19)}…`);

  const found = participants(roots, suite.id);
  const fixtures = (suite.fixtures ?? []).map((rel) => resolve(args.suiteDir, rel));
  const extra = [...fixtures, ...(args.packages ?? [])].map(readParticipant).filter((p): p is Participant => p !== null);
  const all = [...found, ...extra.filter((e) => !found.some((f) => f.name === e.name))];
  for (const p of all) {
    const problems = validateBench(p.name, p.thetis);
    if (problems.length) throw new Error(`${p.name}: ${problems.join("; ")}`);
  }

  // The floor, then each package alone. A combined arm is added only when the participants are all shipped
  // system packages, because those add up to the harness a person actually runs; competing mechanisms are
  // alternatives to each other, and installing three retrievers at once would measure none of them.
  // A package with `bench.arms` runs once more per named arm, under that arm's configuration of itself.
  const own = (p: Participant): Arm[] => (p.bench.arms ?? []).map((arm) => ({ id: `${armIdFor(p)}-${arm}`, packages: [p.dir], config: { [p.name]: p.bench.armConfig?.[arm] ?? {} } }));
  const arms: Arm[] = [{ id: FLOOR }, ...all.flatMap((p) => [{ id: armIdFor(p), packages: [p.dir] }, ...own(p)])];
  const complementary = all.length > 1 && all.every((p) => p.name.startsWith("@thetis/"));
  if (complementary) arms.push({ id: ALL, packages: all.map((p) => p.dir) });
  log(
    `${suite.id}: ${tasks.length}${tasks.length < everyTask.length ? ` of ${everyTask.length}` : ""} tasks, ${arms.length} arms (${arms.map((a) => a.id).join(", ")})${args.model ? ` against ${args.model}, ceiling $${(args.maxCostUsd ?? 1).toFixed(2)}` : ""}`,
  );

  const arena = await Arena.open({
    project: args.project,
    arms,
    sandbox: args.sandbox,
    script: suite.script,
    // The harness and the probe, then what the suite says every arm gets: a corpus of tools reaches the floor this way.
    base: [resolve(args.project, "packages/harness-core"), resolve(args.project, "packages/bench-probe"), ...(suite.base ?? []).map((rel) => resolve(args.suiteDir, rel))],
    // The digest goes with the records: an importer looks a vector file up by it.
    ...(corpus ? { corpus: { id: corpus.id, version: corpus.version, sha256: corpus.sha256, records: corpus.records }, canaries: corpus.canaries } : {}),
    ...(args.model
      ? {
          upstream: {
            model: args.model,
            maxCostUsd: args.maxCostUsd ?? 1,
            config: { apiKey: process.env.OPENROUTER_API_KEY ?? "", baseUrl: "https://openrouter.ai/api/v1" },
          },
        }
      : {}),
  });
  try {
      const observations = await runSuite(arena, suite, tasks, {
      runId: args.runId ?? "r1",
      // A warm-up turn exists to keep the cold fence out of the latency figures. With a model answering it
      // would be billed, and no latency is committed from such a run anyway.
      warmup: args.model ? 0 : 1,
      onProgress: (line) => log(`    ${line}`),
    });
    const scores = summarise(observations, tasks, { floor: FLOOR, suite: suite.id, registrySize: corpus?.records.length ?? 0, ...(corpus ? { routing: routingOf(corpus.records) } : {}) });
    const inputs: ReportInputs = {
      probe: suite.probe,
      suite: {
        id: suite.id,
        version: suite.version,
        sha256: sha256(readFileSync(resolve(args.suiteDir, "tasks.jsonl"), "utf8")),
        tasks: tasks.length,
        controls: tasks.filter((t) => t.control).length,
        ...(suite.description ? { description: suite.description } : {}),
      },
      arms: arms.map((a) => ({
        id: a.id,
        packages: (a.packages ?? []).map((dir) => {
          const p = all.find((x) => x.dir === resolve(dir));
          return p ? `${p.name}@${p.version}` : dir;
        }),
      })),
      floor: FLOOR,
      scorer: SCORER,
      seed: seedOf([suite.id, suite.version]),
      model: args.model ?? null,
      sandbox: arena.config.fence.sandbox,
      ...(corpus ? { corpus: { id: corpus.id, version: corpus.version, sha256: corpus.sha256, records: corpus.records.length } } : {}),
    };

    const notes = [...findings(observations, tasks, suite), ...omissions(all, suite)];
    const report = buildReport(scores, inputs, latencyRatio(scores, FLOOR), notes);
    log(summaryLine(report, suite));
    const spent = observations.reduce((n, o) => n + (o.usage.cost ?? 0), 0);
    if (spent > 0) log(`  spent $${spent.toFixed(4)} of the $${(args.maxCostUsd ?? 1).toFixed(2)} ceiling`);

    const wrote: string[] = [];
    if (args.out) {
      const result = writeSuiteReport(resolve(args.out), report, args.force);
      log(`  suite report ${result.written ? "written" : "unchanged"}: ${result.path}`);
      if (result.written) wrote.push(result.path);
    }
    if (args.write) {
      const suiteDir = resolve(args.project, "bench", suite.id.replace("@", "-v"));
      const result = writeSuiteReport(suiteDir, report, args.force);
      log(`  suite report ${result.written ? "written" : "unchanged"}: ${result.path}`);
      if (result.written) wrote.push(result.path);
      for (const p of all) {
        const check = comparable(p, all, suite.id, p.bench.corpus);
        const peerArms = check.peers.map((name) => armIdFor(all.find((x) => x.name === name) as Participant));
        const ownArms = own(p).map((a) => a.id);
        const view = viewFor(report, p.name, armIdFor(p), p.peerGroup, [...ownArms, ...peerArms, ...(complementary ? [ALL] : [])]);
        const written = writePackageView(p.dir, view, p.bench.report, args.force);
        // The chart sits beside the view and follows the same rule: rewritten when the view is, never otherwise.
        const chart = writeChart(p.dir, view, p.bench.report, args.force);
        // The page shows every suite this package runs, not only the one just run, so a second suite does
        // not overwrite the first's section.
        const views = readViews(p.dir, p.bench.report);
        for (const out of [written, chart, writeMarkdown(p.dir, views.length ? views : [view], p.bench.report, args.force)]) {
          log(`  ${p.name}: ${out.written ? "written" : "unchanged"} ${out.path}`);
          if (out.written) wrote.push(out.path);
        }
      }
    }
    return { report, wrote };
  } finally {
    await arena.close();
  }
}

function omissions(all: readonly Participant[], suite: SuiteDef): string[] {
  const notes: string[] = [];
  for (const p of all) {
    for (const o of comparable(p, all, suite.id, p.bench.corpus).omitted) {
      notes.push(`${p.name}: ${o.name} omitted from the comparison — ${o.reason}`);
    }
  }
  return notes;
}

/**
 * What the run cannot claim. A number is only worth reading next to the reason it might mislead, and the
 * reader will not otherwise know that nothing in this harness varies what it attaches per task.
 */
function findings(observations: readonly Observation[], tasks: readonly Task[], suite: SuiteDef): string[] {
  const notes: string[] = [];
  const perArm = new Map<string, Set<number>>();
  for (const o of observations) {
    const n = o.rounds[0]?.toolNames.length ?? 0;
    perArm.set(o.arm, (perArm.get(o.arm) ?? new Set()).add(n));
  }
  const varies = [...perArm.values()].some((counts) => counts.size > 1);
  if (!varies && tasks.length > 1) {
    notes.push(
      "Every task received the same tools, because nothing installed here decides what to attach per query. So recall is one by construction and means nothing; precision and the wasted bytes are the real figures, and they are the headroom a tool-attention package would have.",
    );
  }
  const statesCapabilities = tasks.some((t) => (t.required ?? []).length);
  const statesTools = tasks.some((t) => (t.tools ?? []).length);
  const statesGroups = tasks.some((t) => (t.groups ?? []).length);
  if (statesGroups) {
    notes.push(
      "Tasks name the tool groups they need. route_recall, route_precision and route_f1 are scored from the canaries found in the tool segment of the first round, with the always-on groups left out of precision; routed_nothing is the share of tasks with a need where no routable group was admitted; surface_tools counts the corpus tools attached. The floor attaches everything, so its recall is one by construction and its precision is the base rate.",
    );
  }
  if (!statesCapabilities && !statesTools && !statesGroups) {
    notes.push(`Suite ${suite.id} names nothing a task needed, so recall, overshoot and completeness are not computed — only footprint.`);
  } else if (!statesCapabilities && statesTools) {
    notes.push(
      `Suite ${suite.id} names the tools each task needed but no capabilities, so the capability columns are absent. The tool gold is authored rather than imported; ${"`"}packages/bench/suites/tool-recall-v1/GOLD.md${"`"} says why that is defensible for tools and would not be for skills.`,
    );
  }
  const controls = tasks.filter((t) => t.control).length;
  if (controls < 3) {
    notes.push(`Only ${controls} control tasks. An arm that bloats the prompt is best caught on tasks no capability should help with; this suite has few.`);
  }
  if (tasks.length < 50) {
    notes.push(`${tasks.length} tasks is below the 50 at which a percentage is worth quoting. Read the win/tie/loss counts, not the means.`);
  }
  const spent = observations.reduce((n, o) => n + (o.usage.cost ?? 0), 0);
  if (spent > 0) {
    notes.push(
      `A model answered these tasks and it cost $${spent.toFixed(4)}. Selection is reported under the arm that asked the model to choose; a mechanism that pins what it believes is right never asks, so it has no selection figure and its absence is not a failure.`,
    );
  }
  return notes;
}

function summaryLine(report: ReturnType<typeof buildReport>, suite: SuiteDef): string {
  const failed = Object.entries(report.conformance).filter(([, c]) => !c.passed).map(([arm]) => arm);
  const head = `  ${suite.id} ${report.digest.slice(0, 19)}…`;
  return failed.length ? `${head} — conformance FAILED for ${failed.join(", ")}` : `${head} — every arm conformed`;
}

/** `bench verify`: check a package's declaration without running anything. */
export function verify(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { name?: string; thetis?: unknown };
  if (!manifest.thetis) return [`${dir} has no thetis field`];
  return validateBench(manifest.name ?? dir, manifest.thetis as never);
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const project = resolve(process.cwd());
  const flag = (name: string): string | undefined => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  const has = (name: string): boolean => rest.includes(`--${name}`);

  if (command === "verify") {
    const problems = verify(rest[0] ?? project);
    if (problems.length) {
      for (const p of problems) process.stderr.write(`${p}\n`);
      return 1;
    }
    process.stdout.write("the bench declaration is well formed\n");
    return 0;
  }

  if (command !== "run") {
      process.stdout.write(
      "usage: bench run <suite-id|suite-dir> [--write] [--force] [--out <dir>] [--sandbox auto|bwrap|none] [--package <dir>]\n" +
        "                                     [--model <id> --max-cost <usd> --tasks <n>]   put a real model in the loop\n" +
        "       bench verify [<package-dir>]\n",
    );
    return command ? 1 : 0;
  }

  const named = rest[0];
  if (!named) {
    process.stderr.write("bench run needs a suite\n");
    return 1;
  }
  const suiteDir = named.includes("/") && !named.includes("@") ? resolve(named) : resolve(project, "packages/bench/suites", `${named.replace("@", "-v")}`);
  const packages = rest.flatMap((arg, i) => (arg === "--package" ? [resolve(rest[i + 1] as string)] : []));
  const { report } = await run({
    project,
    suiteDir,
    packages,
    sandbox: flag("sandbox") as RunArgs["sandbox"],
    model: flag("model"),
    maxCostUsd: flag("max-cost") ? Number(flag("max-cost")) : undefined,
    limit: flag("tasks") ? Number(flag("tasks")) : undefined,
    write: has("write"),
    force: has("force"),
    out: flag("out") ? resolve(flag("out") as string) : undefined,
  });
  return Object.values(report.conformance).every((c) => c.passed) ? 0 : 1;
}

export { renderMarkdown };

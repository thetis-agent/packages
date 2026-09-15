// The artifact. One authoritative report per suite holds every arm's numbers, so there is exactly one place
// a score lives and no two packages can disagree about a third's. Each participating package then carries a
// view of that report, filtered to itself and its peers, stamped with the suite's digest: a view whose stamp
// no longer matches renders as stale rather than quietly wrong, which is also what catches a fork that
// copied a package directory along with its numbers.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ArmScore, MetricName } from "./score.js";
import { PER_ARM, SHARED } from "./score.js";
import type { Interval, Paired } from "./metrics/stats.js";

/**
 * The scorer's identity, read from its own manifest rather than written here, so it cannot drift. It is part
 * of a report's digest: changing how a number is computed changes what the number means, and a report
 * produced by different arithmetic is not the same report. Bump this package's version when scoring changes.
 */
export const SCORER = `@thetis/bench@${(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version}`;
export const REPORT_VERSION = 1;

export interface ReportInputs {
  probe: "A" | "B";
  suite: { id: string; version: string; sha256: string; tasks: number; controls: number; description?: string };
  corpus?: { id: string; version: string; sha256: string; records: number };
  /** Every arm as `name@version`, never a content hash: a report must not change its own digest by existing. */
  arms: { id: string; packages: string[] }[];
  floor: string;
  scorer: string;
  seed: string;
  model: string | null;
  sandbox: string;
}

export interface SuiteReport {
  version: number;
  generatedAt: string;
  digest: string;
  inputs: ReportInputs;
  shared: Record<string, Partial<Record<MetricName, Interval>>>;
  delta: Record<string, Partial<Record<MetricName, Paired>>>;
  perArm: Record<string, Partial<Record<MetricName, Interval>>>;
  latency: Record<string, number | null>;
  conformance: Record<string, ArmScore["conformance"] & { passed: boolean }>;
  notes: string[];
}

export interface PackageView {
  version: number;
  package: string;
  peerGroup: string;
  suite: string;
  suiteDigest: string;
  generatedAt: string;
  arms: string[];
  report: SuiteReport;
}

/** Stable key order, so the same inputs always hash the same however they were built. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export const digestOf = (inputs: ReportInputs): string => `sha256:${createHash("sha256").update(canonical(inputs)).digest("hex")}`;

export const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** A run is sound only if no arm claimed something the prompt does not show and no turn failed. */
function conformanceOf(score: ArmScore): ArmScore["conformance"] & { passed: boolean } {
  return { ...score.conformance, passed: score.conformance.adapterLies.length === 0 && score.conformance.errors.length === 0 };
}

export function buildReport(scores: readonly ArmScore[], inputs: ReportInputs, latency: Record<string, number | null>, notes: string[] = []): SuiteReport {
  const shared: SuiteReport["shared"] = {};
  const delta: SuiteReport["delta"] = {};
  const perArm: SuiteReport["perArm"] = {};
  const conformance: SuiteReport["conformance"] = {};
  for (const score of scores) {
    shared[score.arm] = score.absolute;
    delta[score.arm] = score.delta;
    perArm[score.arm] = score.perArm;
    conformance[score.arm] = conformanceOf(score);
  }
  return { version: REPORT_VERSION, generatedAt: new Date().toISOString(), digest: digestOf(inputs), inputs, shared, delta, perArm, latency, conformance, notes };
}

export interface WriteResult {
  path: string;
  written: boolean;
  reason: string;
}

/**
 * Writing through a userspace store would edit the real package source invisibly, because the store is a
 * directory of symbolic links to it. Refuse rather than surprise someone.
 */
export function assertWritable(path: string): void {
  const parts = resolve(path).split(sep);
  const at = parts.indexOf("store");
  if (at > 0 && parts[at + 1] === "node_modules") {
    throw new Error(`refusing to write through a package store link: ${path}`);
  }
}

function writeIfChanged(path: string, body: string, digest: string, force: boolean): WriteResult {
  assertWritable(path);
  if (!force && existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, "utf8")) as { digest?: string; suiteDigest?: string };
      if ((existing.digest ?? existing.suiteDigest) === digest) return { path, written: false, reason: "unchanged" };
    } catch {
      // A report we cannot read is a report we should replace.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return { path, written: true, reason: force ? "forced" : "inputs changed" };
}

export function writeSuiteReport(dir: string, report: SuiteReport, force = false): WriteResult {
  return writeIfChanged(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, report.digest, force);
}

/** A package's own view: the floor, itself, and its peers. Nothing else, so the file stays readable. */
export function viewFor(report: SuiteReport, packageName: string, armId: string, peerGroup: string, peers: readonly string[]): PackageView {
  const arms = [report.inputs.floor, armId, ...peers].filter((a, i, all) => a && all.indexOf(a) === i && report.shared[a]);
  const keep = <T,>(from: Record<string, T>): Record<string, T> => Object.fromEntries(arms.filter((a) => from[a] !== undefined).map((a) => [a, from[a] as T]));
  return {
    version: REPORT_VERSION,
    package: packageName,
    peerGroup,
    suite: report.inputs.suite.id,
    suiteDigest: report.digest,
    generatedAt: report.generatedAt,
    arms,
    report: {
      ...report,
      shared: keep(report.shared),
      delta: keep(report.delta),
      perArm: keep(report.perArm),
      latency: keep(report.latency),
      conformance: keep(report.conformance),
    },
  };
}

/** A suite's directory name inside a package: `tool-recall@1` becomes `tool-recall-v1`. */
export const slugOf = (suiteId: string): string => suiteId.replace("@", "-v");

export function writePackageView(packageDir: string, view: PackageView, reportDir = "bench", force = false): WriteResult {
  return writeIfChanged(join(packageDir, reportDir, slugOf(view.suite), "report.json"), `${JSON.stringify(view, null, 2)}\n`, view.suiteDigest, force);
}

/** Every suite this package has a view for, newest run first within a stable order by suite id. */
export function readViews(packageDir: string, reportDir = "bench"): PackageView[] {
  const root = join(packageDir, reportDir);
  if (!existsSync(root)) return [];
  const out: PackageView[] = [];
  for (const entry of readdirSync(root)) {
    const at = join(root, entry, "report.json");
    if (!existsSync(at)) continue;
    try {
      out.push(JSON.parse(readFileSync(at, "utf8")) as PackageView);
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.suite.localeCompare(b.suite));
}

/** Is this view still talking about the run that produced it? */
export const isStale = (view: PackageView, report: SuiteReport): boolean => view.suiteDigest !== report.digest;

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) >= 10 ? 1 : 3));
const cell = (i: Interval | undefined): string => (i ? `${fmt(i.mean)} ±${fmt(i.mde)}` : "—");
/** A list long enough to matter is summarised: the whole of it belongs in report.json, not on a page. */
const some = (ids: readonly string[], show = 3): string =>
  ids.length <= show ? ids.join(", ") : `${ids.slice(0, show).join(", ")}, and ${ids.length - show} more`;

function table(rows: readonly string[], header: readonly string[], body: readonly (readonly string[])[]): string {
  void rows;
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/**
 * The columns worth printing. A metric no arm produced says nothing; so does one where every arm landed on
 * the same number, which is a column of the same value repeated. Both stay in report.json for a reader with
 * a question; neither belongs in a table meant to be read.
 */
/** Wall clock never appears as an absolute in a committed table; the latency section decides what to say. */
const NOT_IN_TABLES = new Set<MetricName>(["assemble_ms"]);

/**
 * Below this many tasks a latency verdict is not stable enough to commit. Measured, not assumed: on a suite
 * of seven the same pair of arms swaps which one is "measurably slower" between consecutive runs, because
 * assembly costs a few milliseconds and the noise floor is larger than the effect.
 */
const MIN_TASKS_FOR_LATENCY = 30;

function columnsOf(shared: SuiteReport["shared"], names: readonly MetricName[], arms: readonly string[]): MetricName[] {
  return names.filter((m) => {
    if (NOT_IN_TABLES.has(m)) return false;
    const means = arms.map((a) => shared[a]?.[m]?.mean).filter((v): v is number => v !== undefined);
    return means.length > 0 && (means.length === 1 || new Set(means.map((v) => v.toFixed(4))).size > 1);
  });
}

/** Delta columns where at least one arm actually moved. A column of zeroes is not a comparison. */
function deltaColumnsOf(delta: SuiteReport["delta"], names: readonly MetricName[], arms: readonly string[]): MetricName[] {
  return names.filter((m) => !NOT_IN_TABLES.has(m) && arms.some((a) => Math.abs(delta[a]?.[m]?.interval.mean ?? 0) > 1e-9));
}

export function renderMarkdown(views: readonly PackageView[]): string {
  const first = views[0];
  if (!first) return "# Bench\n\nNo suite has been run against this package yet.\n";
  const head = [
    `# Bench · ${first.package}`,
    "",
    "Generated by `@thetis/bench`. Every figure is a mean over tasks with the half-width of a bootstrap interval beside it, which is the smallest difference that many tasks can resolve. Bytes, not tokens: byte density differs between a prose catalogue and a JSON schema, so segments are kept apart rather than summed.",
    "",
    views.length > 1 ? `Suites: ${views.map((v) => `[\`${v.suite}\`](#suite-${slugOf(v.suite)})`).join(", ")}.` : "",
    views.length > 1 ? "" : "",
    "---",
    "",
  ].filter((line, i, all) => !(line === "" && all[i - 1] === ""));
  return `${head.join("\n")}${views.map((v) => renderSuite(v)).join("\n")}`;
}

function renderSuite(view: PackageView): string {
  const r = view.report;
  const arms = view.arms;
  const sharedCols = columnsOf(r.shared, SHARED, arms);
  const perArmCols = columnsOf(r.perArm, PER_ARM, arms);
  const lines: string[] = [];

  lines.push(`<a id="suite-${slugOf(r.inputs.suite.id)}"></a>`, "");
  lines.push(`## Suite \`${r.inputs.suite.id}\``, "");
  lines.push(r.inputs.suite.description ?? "", "");
  lines.push(`${r.inputs.suite.tasks} tasks (${r.inputs.suite.controls} of them controls), probe ${r.inputs.probe}.`);
  lines.push(`Generated ${view.generatedAt}. Digest \`${view.suiteDigest.slice(0, 19)}…\`.`, "");

  lines.push("### Compared", "");
  lines.push(
    "Only numbers every arm can produce appear here, and only those on which the arms differ. A mechanism that does not rank cannot have a ranking score, and averaging one in would compare different acts.",
    "",
  );
  lines.push(table([], ["arm", ...sharedCols], arms.map((arm) => [arm === view.arms[1] ? `**${arm}**` : arm, ...sharedCols.map((m) => cell(r.shared[arm]?.[m]))])));
  lines.push("");

  const withDelta = arms.filter((a) => a !== r.inputs.floor && Object.keys(r.delta[a] ?? {}).length);
  if (withDelta.length) {
    lines.push(`### Against the floor (\`${r.inputs.floor}\`)`, "");
    lines.push("Paired per task, so the constant cost of the harness cancels. `w/t/l` counts the tasks each arm won, tied and lost, which a mean can hide.", "");
    const cols = deltaColumnsOf(r.delta, SHARED, withDelta);
    lines.push(
      table([], ["arm", ...cols], withDelta.map((arm) => [
        arm,
        ...cols.map((m) => {
          const d = r.delta[arm]?.[m];
          return d ? `${fmt(d.interval.mean)} [${fmt(d.interval.lower)}, ${fmt(d.interval.upper)}] ${d.wins}/${d.ties}/${d.losses}` : "—";
        }),
      ])),
    );
    lines.push("");
  }

  if (perArmCols.length) {
    lines.push("### Per arm, not compared", "");
    lines.push("These belong to one mechanism and are printed under it. They are not columns in the table above and must not be read across arms.", "");
    for (const arm of arms) {
      const own = perArmCols.filter((m) => r.perArm[arm]?.[m]);
      if (own.length) lines.push(`- **${arm}** — ${own.map((m) => `${m} ${cell(r.perArm[arm]?.[m])}`).join(", ")}`);
    }
    lines.push("");
  }

  lines.push("### Assembly latency", "");
  lines.push(
    `Absolute milliseconds are not committed: the fence opens lazily, the sandbox mode differs per machine, and step timing includes serialising the context across the fence, so two machines on this commit would disagree. A ratio against the floor is printed only once a suite has at least ${MIN_TASKS_FOR_LATENCY} tasks and the paired difference clears its own interval — below that the verdict changes between consecutive runs of the same code, which is a reason to say nothing rather than a number to publish. The step count and the byte totals above are the stable part, and they are what assembly time is spent on. Raw timings are in \`report.json\`.`,
    "",
  );
  lines.push(
    table([], ["arm", "steps", "assembly vs floor"], arms.map((arm) => {
      const d = r.delta[arm]?.assemble_ms;
      const steps = r.shared[arm]?.steps_n;
      if (arm === r.inputs.floor) return [arm, steps ? fmt(steps.mean) : "—", "floor"];
      if (!d) return [arm, steps ? fmt(steps.mean) : "—", "—"];
      const resolved = d.interval.lower > 0 || d.interval.upper < 0;
      const ratio = r.latency[arm];
      const enough = d.interval.n >= MIN_TASKS_FOR_LATENCY;
      return [
        arm,
        steps ? fmt(steps.mean) : "—",
        enough && resolved && ratio ? `${ratio.toFixed(1)}×` : `not measured at ${d.interval.n} tasks`,
      ];
    })),
  );
  lines.push("");

  lines.push("### Conformance", "");
  lines.push(
    "What each arm claimed it surfaced, against what the assembled prompt actually shows. Every corpus record carries a token a mechanism must preserve however it reformats the text, so a claim is checked rather than believed, and only checked reach is scored.",
    "",
  );
  for (const arm of arms) {
    const c = r.conformance[arm];
    if (!c) continue;
    const notes: string[] = [];
    if (c.adapterLies.length) notes.push(`**claimed without evidence: ${some(c.adapterLies)}**`);
    if (c.adapterModest.length) notes.push(`reached the prompt without being claimed: ${some(c.adapterModest)}`);
    if (c.offeredUnverified.length) {
      notes.push(
        `${c.offeredUnverified.length} claimed reachable with nothing to show for it, so excluded from every score (${some(c.offeredUnverified, 2)})`,
      );
    }
    if (c.errors.length) notes.push(`errors: ${c.errors.slice(0, 3).join("; ")}`);
    lines.push(`- **${arm}** — ${c.passed ? "passed" : "failed"}${notes.length ? `; ${notes.join("; ")}` : ""}`);
  }
  lines.push("");

  lines.push("### Inputs", "");
  lines.push("Two reports are comparable only when these match.", "");
  lines.push(table([], ["field", "value"], [
    ["suite", `${r.inputs.suite.id} (${r.inputs.suite.sha256.slice(0, 19)}…)`],
    ["corpus", r.inputs.corpus ? `${r.inputs.corpus.id}, ${r.inputs.corpus.records} records` : "none"],
    ["arms", r.inputs.arms.filter((a) => view.arms.includes(a.id)).map((a) => `${a.id}${a.packages.length ? ` (${a.packages.join(", ")})` : ""}`).join("; ")],
    ["model", r.inputs.model ?? "none — this probe needs no model"],
    ["sandbox", r.inputs.sandbox],
    ["scorer", r.inputs.scorer],
  ]));
  lines.push("");

  if (r.notes.length) {
    lines.push("### Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  }

  lines.push(`Regenerate with \`npm run bench -- run ${r.inputs.suite.id}\`. This section is rewritten only when the inputs above change.`, "", "---", "");
  return lines.join("\n");
}

/**
 * The rendered page carries the moment it was made, which would otherwise differ on every run and make the
 * file look changed when nothing was. Identity is the digest and the numbers, not the clock.
 */
const withoutTimestamp = (body: string): string => body.replace(/^Generated .*$/gm, "Generated —");

export function writeMarkdown(packageDir: string, views: readonly PackageView[], reportDir = "bench", force = false): WriteResult {
  const path = join(packageDir, "BENCH.md");
  assertWritable(path);
  const body = renderMarkdown(views);
  if (!force && existsSync(path) && withoutTimestamp(readFileSync(path, "utf8")) === withoutTimestamp(body)) {
    return { path, written: false, reason: "unchanged" };
  }
  mkdirSync(join(packageDir, reportDir), { recursive: true });
  writeFileSync(path, body);
  return { path, written: true, reason: force ? "forced" : "inputs changed" };
}

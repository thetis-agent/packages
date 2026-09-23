import { z } from "zod";
import { IntervalSchema, PairedSchema } from "./metrics/stats.js";
import { ConformanceSchema } from "./schemas.js";

const Count = z.number().int().nonnegative();
const IntervalsSchema = z.record(z.string(), z.record(z.string(), IntervalSchema));
const PairsSchema = z.record(z.string(), z.record(z.string(), PairedSchema));

export const ReportInputsSchema = z.looseObject({
  probe: z.enum(["A", "B"]),
  suite: z.looseObject({ id: z.string(), version: z.string(), sha256: z.string(), tasks: Count, controls: Count, description: z.string().optional() }),
  corpus: z.looseObject({ id: z.string(), version: z.string(), sha256: z.string(), records: Count }).optional(),
  /** Identity uses package versions, not content hashes, so writing a report never changes its digest. */
  arms: z.array(z.looseObject({ id: z.string(), packages: z.array(z.string()) })),
  floor: z.string(), scorer: z.string(), seed: z.string(), model: z.string().nullable(), sandbox: z.string(),
});

export const SuiteReportSchema = z.looseObject({
  version: z.literal(1), generatedAt: z.string(), digest: z.string(), inputs: ReportInputsSchema,
  shared: IntervalsSchema, delta: PairsSchema, perArm: IntervalsSchema,
  latency: z.record(z.string(), z.number().nullable()),
  conformance: z.record(z.string(), ConformanceSchema.extend({ passed: z.boolean() })),
  notes: z.array(z.string()),
});

export const PackageViewSchema = z.looseObject({
  version: z.literal(1), package: z.string(), peerGroup: z.string(), suite: z.string(),
  suiteDigest: z.string(), generatedAt: z.string(), arms: z.array(z.string()), report: SuiteReportSchema,
});

export const StoredDigestSchema = z.union([
  SuiteReportSchema.transform((report) => report.digest),
  PackageViewSchema.transform((view) => view.suiteDigest),
]);
export const ScorerManifestSchema = z.looseObject({ version: z.string().min(1) });

export type ReportInputs = z.infer<typeof ReportInputsSchema>;
export type SuiteReport = z.infer<typeof SuiteReportSchema>;
export type PackageView = z.infer<typeof PackageViewSchema>;

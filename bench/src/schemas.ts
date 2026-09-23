import { z } from "zod";
import { CorpusSchema } from "@thetis/runtime/schemas";

const Strings = z.array(z.string());
const Count = z.number().int().nonnegative();

export const CaptureLineSchema = z.looseObject({
  run: z.string(), arm: z.string(), task: z.string(), attempt: Count, round: Count,
  model: z.string(), at: z.number().nonnegative(),
  bytes: z.looseObject({ system: Count, tools: Count, messages: Count, hints: Count, total: Count }),
  sha: z.looseObject({ system: z.string(), tools: z.string(), prefix: z.string() }),
  prefixBytes: Count, toolNames: Strings, toolIds: Strings, toolBytes: z.record(z.string(), Count),
  canaryDirect: Strings, canaryTools: Strings.optional(), idsMentioned: Strings,
  idsReturned: Strings, canaryReturned: Strings, nonAsciiRatio: z.number().min(0).max(1), hintKeys: Strings,
});

export const SplitSchema = z.enum(["tune", "holdout", "holdback"]);

export const TaskSchema = z.looseObject({
  id: z.string().min(1), query: z.string().min(1),
  required: Strings.optional(), helpful: Strings.optional(), forbidden: Strings.optional(),
  tools: Strings.optional(), groups: Strings.optional(), family: z.string().optional(),
  budget: z.looseObject({ k_max: Count.optional(), token_max: Count.optional() }).optional(),
  split: SplitSchema.optional(), tags: Strings.optional(), mutable: z.record(z.string(), z.string()).optional(),
  control: z.boolean().optional(), turns: z.number().int().positive().optional(),
});

export const SuiteSchema = z.looseObject({
  id: z.string().min(1), version: z.string().min(1), probe: z.enum(["A", "B"]),
  corpus: z.string().optional(), description: z.string().optional(), tasks: z.array(TaskSchema).min(1),
  script: z.unknown().optional(), runs: z.number().int().positive().optional(),
  fixtures: Strings.optional(), base: Strings.optional(),
});

export const CorpusFileSchema = CorpusSchema.omit({ records: true }).extend({
  records: Count, file: z.string().min(1), seed: z.string(),
  dataset: z.looseObject({ name: z.string(), id: z.string(), revision: z.string(), url: z.string(), license: z.string(), split: z.string() }).optional(),
  sampling: z.record(z.string(), z.unknown()).optional(),
});

export const ConformanceSchema = z.looseObject({ adapterLies: Strings, adapterModest: Strings, offeredUnverified: Strings, errors: Strings });
export const VerifyManifestSchema = z.looseObject({ name: z.string().optional(), thetis: z.unknown().optional() });

export type CaptureLine = z.infer<typeof CaptureLineSchema>;
export type Split = z.infer<typeof SplitSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type SuiteDef = z.infer<typeof SuiteSchema>;
export type CorpusFile = z.infer<typeof CorpusFileSchema>;
export type Conformance = z.infer<typeof ConformanceSchema>;

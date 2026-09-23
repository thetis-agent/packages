import { z } from "zod";

export const ExaConfigSchema = z.looseObject({
  apiKey: z.string().optional(),
  baseUrl: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  defaults: z.looseObject({
    numResults: z.number().int().positive().optional(),
    maxCharacters: z.number().int().positive().optional(),
    researchWaitSeconds: z.number().nonnegative().optional(),
  }).optional(),
});

export const ExaResultSchema = z.looseObject({
  title: z.string().nullish(),
  url: z.string().optional(),
  id: z.string().optional(),
  publishedDate: z.string().nullish(),
  author: z.string().nullish(),
  score: z.number().nullish(),
  text: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  summary: z.string().optional(),
  get subpages() { return z.array(ExaResultSchema).optional(); },
  extras: z.looseObject({ links: z.array(z.string()).optional(), imageLinks: z.array(z.string()).optional() }).optional(),
});

export const ExaStatusSchema = z.looseObject({
  id: z.string().optional(), status: z.string().optional(), source: z.string().optional(),
  error: z.union([z.string(), z.looseObject({ tag: z.string().optional(), httpStatusCode: z.number().optional() })]).optional(),
});

export const CostSchema = z.looseObject({ costDollars: z.looseObject({ total: z.number().optional() }).optional() });

export const ResultsResponseSchema = CostSchema.extend({
  results: z.array(ExaResultSchema),
  statuses: z.array(ExaStatusSchema).optional(),
  searchType: z.string().optional(),
});

export const CitationSchema = z.looseObject({
  title: z.string().optional(), url: z.string().optional(),
  publishedDate: z.string().nullish(), author: z.string().nullish(), text: z.string().optional(),
});

export const AnswerResponseSchema = CostSchema.extend({ answer: z.json(), citations: z.array(CitationSchema).optional() });

export const AgentRunSchema = CostSchema.extend({
  id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  stopReason: z.string().nullish(),
  createdAt: z.string().optional(),
  completedAt: z.string().nullish(),
  request: z.looseObject({ query: z.string().optional() }).optional(),
  output: z.looseObject({
    text: z.string().nullish(),
    structured: z.unknown().optional(),
    grounding: z.array(z.looseObject({ field: z.string().optional(), citations: z.array(CitationSchema).optional() })).optional(),
  }).nullish(),
  error: z.unknown().optional(),
});

export const AgentRunResponseSchema = AgentRunSchema.required({ id: true, status: true });

export const RunListSchema = z.looseObject({
  data: z.array(AgentRunResponseSchema), hasMore: z.boolean().optional(), nextCursor: z.string().nullish(),
});

export const RequestBodySchema = z.record(z.string(), z.unknown());
export const QuerySchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.undefined()]));

export type ExaConfig = z.infer<typeof ExaConfigSchema>;
export type ExaResult = z.infer<typeof ExaResultSchema>;
export type ExaStatus = z.infer<typeof ExaStatusSchema>;
export type Cost = z.infer<typeof CostSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;

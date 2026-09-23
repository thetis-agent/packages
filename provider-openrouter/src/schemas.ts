import { z } from "zod";

export const ModelsResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.string().min(1), name: z.string().optional() })),
});

export const ProviderErrorSchema = z.looseObject({
  message: z.string().optional(),
  metadata: z.looseObject({ reason: z.string().optional() }).optional(),
});

const ToolDeltaSchema = z.looseObject({
  index: z.number().int().nonnegative().optional(),
  id: z.string().optional(),
  function: z.looseObject({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
});

const DeltaSchema = z.looseObject({
  content: z.unknown().optional(),
  reasoning: z.string().nullish(),
  reasoning_content: z.string().nullish(),
  tool_calls: z.array(ToolDeltaSchema).nullish(),
});

export const StreamChunkSchema = z.looseObject({
  error: ProviderErrorSchema.optional(),
  choices: z.array(z.looseObject({ delta: DeltaSchema.nullish(), finish_reason: z.string().nullish() })).optional(),
  usage: z.record(z.string(), z.unknown()).nullish(),
});

export const ToolArgumentsSchema = z.record(z.string(), z.unknown());

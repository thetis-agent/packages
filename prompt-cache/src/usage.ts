// Flatten the finite metrics reported by OpenRouter and Anthropic into provider usage events.
import { z } from "zod";

const MetricSchema = z.number().optional().catch(undefined);
const UsageSchema = z.looseObject({
  input_tokens: MetricSchema,
  output_tokens: MetricSchema,
  cache_read_input_tokens: MetricSchema,
  cache_creation_input_tokens: MetricSchema,
  prompt_tokens_details: z.object({ cached_tokens: MetricSchema, cache_write_tokens: MetricSchema }).catch({}).default({}),
  completion_tokens_details: z.object({ reasoning_tokens: MetricSchema }).catch({}).default({}),
});

export function normalizeUsage(raw: unknown): Record<string, number> {
  const parsed = UsageSchema.safeParse(raw);
  if (!parsed.success) return {};
  const usage = parsed.data;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    const metric = MetricSchema.parse(value);
    if (metric !== undefined) out[key] = metric;
  }
  const read = usage.prompt_tokens_details.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  const write = usage.prompt_tokens_details.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0;
  out.cache_read_tokens = read;
  out.cache_write_tokens = write;
  if (usage.completion_tokens_details.reasoning_tokens !== undefined) out.reasoning_tokens = usage.completion_tokens_details.reasoning_tokens;
  if (out.prompt_tokens === undefined && usage.input_tokens !== undefined) out.prompt_tokens = usage.input_tokens + read + write;
  if (out.completion_tokens === undefined && usage.output_tokens !== undefined) out.completion_tokens = usage.output_tokens;
  const total = out.prompt_tokens ?? 0;
  out.cache_read_ratio = total > 0 ? Math.round((read / total) * 1000) / 1000 : 0;
  return out;
}

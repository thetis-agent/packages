// One shape for cache accounting, whatever the API reported.
//
// OpenRouter: usage.prompt_tokens_details.cached_tokens / cache_write_tokens, usage.cost.
// Anthropic:  usage.cache_read_input_tokens / cache_creation_input_tokens, input_tokens, output_tokens.
// The result is flat numbers, which is what a `usage` provider event carries.

export function normalizeUsage(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  const u = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(u)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;

  const prompt = nested(u, "prompt_tokens_details");
  const completion = nested(u, "completion_tokens_details");
  const read = num(prompt.cached_tokens) ?? num(u.cache_read_input_tokens) ?? 0;
  const write = num(prompt.cache_write_tokens) ?? num(u.cache_creation_input_tokens) ?? 0;
  out.cache_read_tokens = read;
  out.cache_write_tokens = write;
  if (num(completion.reasoning_tokens) !== undefined) out.reasoning_tokens = completion.reasoning_tokens as number;

  if (out.prompt_tokens === undefined && num(u.input_tokens) !== undefined) out.prompt_tokens = (u.input_tokens as number) + read + write;
  if (out.completion_tokens === undefined && num(u.output_tokens) !== undefined) out.completion_tokens = u.output_tokens as number;
  const prompt_total = out.prompt_tokens ?? 0;
  out.cache_read_ratio = prompt_total > 0 ? Math.round((read / prompt_total) * 1000) / 1000 : 0;
  return out;
}

function nested(u: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = u[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

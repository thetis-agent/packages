// The cache policy: what the harness decides per call, and what a provider is allowed to act on.
//
// Providers differ in kind, not only in syntax. Anthropic caches nothing unless the request marks
// where; OpenAI, DeepSeek, Grok, Moonshot and Groq cache long prefixes on their own; Gemini caches
// implicitly on recent models and bills storage for explicit marks. So the strategy is per vendor,
// resolved from the model id, and a policy carries only knobs a provider can clamp.

import { z } from "zod";
import { parseSchema } from "@thetis/runtime/lib/validation";

const CacheTtlSchema = z.enum(["5m", "1h"]);
const CacheStrategySchema = z.enum(["breakpoints", "automatic", "off"]);
const HintModeSchema = z.enum(["ignore", "tune", "override"]);
const CacheOverrideSchema = z.object({
  strategy: CacheStrategySchema.optional(),
  ttl: CacheTtlSchema.optional(),
  systemTtl: CacheTtlSchema.optional(),
  anchorStride: z.number().optional(),
  maxBreakpoints: z.number().optional(),
});
const CacheHintSchema = CacheOverrideSchema.extend({ version: z.literal(1).optional(), affinity: z.string().min(1).max(128).optional() });
const CachePolicySchema = CacheOverrideSchema.required().extend({ version: z.literal(1), affinity: CacheHintSchema.shape.affinity });
const CacheHintInputSchema = z.object({
  strategy: CacheHintSchema.shape.strategy.catch(undefined),
  ttl: CacheHintSchema.shape.ttl.catch(undefined),
  systemTtl: CacheHintSchema.shape.systemTtl.catch(undefined),
  anchorStride: CacheHintSchema.shape.anchorStride.catch(undefined),
  maxBreakpoints: CacheHintSchema.shape.maxBreakpoints.catch(undefined),
  affinity: CacheHintSchema.shape.affinity.catch(undefined),
});
export const CacheConfigSchema = z.object({
  enabled: z.boolean().optional(),
  ttl: z.string().optional(),
  systemTtl: z.string().optional(),
  anchorStride: z.number().optional(),
  maxBreakpoints: z.number().optional(),
  explicitVendors: z.array(z.string()).optional(),
  overrides: z.record(z.string(), CacheOverrideSchema).optional(),
  diagnostics: z.boolean().optional(),
  affinity: z.boolean().optional(),
  hints: HintModeSchema.optional(),
});

export type CacheTtl = z.infer<typeof CacheTtlSchema>;
export type CacheStrategy = z.infer<typeof CacheStrategySchema>;
export type HintMode = z.infer<typeof HintModeSchema>;
export type CacheOverride = z.infer<typeof CacheOverrideSchema>;
export type CacheHint = z.infer<typeof CacheHintSchema>;
export type CachePolicy = z.infer<typeof CachePolicySchema>;
export type CacheConfig = z.infer<typeof CacheConfigSchema>;

export function readCacheConfig(raw: unknown): CacheConfig {
  return parseSchema(CacheConfigSchema, raw, "prompt-cache configuration");
}

export const MAX_BREAKPOINTS = 4;
export const DEFAULT_TTL: CacheTtl = "5m";
export const DEFAULT_SYSTEM_TTL: CacheTtl = "1h";
export const DEFAULT_ANCHOR_STRIDE = 8;
export const DEFAULT_EXPLICIT_VENDORS = ["anthropic"];

const TTLS = new Set<string>(["5m", "1h"]);

/** `vendor/model` ids name their vendor; a bare id is its own vendor, which is how a direct endpoint looks. */
export function vendorOf(model: string): string {
  return (model.split("/")[0] ?? "").trim().toLowerCase();
}

/** Builds the policy for one model from the package configuration. */
export function resolvePolicy(raw: unknown, model: string): CachePolicy {
  const config = readCacheConfig(raw);
  const vendor = vendorOf(model);
  const explicit = (config.explicitVendors ?? DEFAULT_EXPLICIT_VENDORS).map((v) => v.toLowerCase());
  const base: CachePolicy = {
    version: 1,
    strategy: config.enabled === false ? "off" : explicit.includes(vendor) ? "breakpoints" : "automatic",
    ttl: ttl(config.ttl, DEFAULT_TTL),
    systemTtl: ttl(config.systemTtl, DEFAULT_SYSTEM_TTL),
    anchorStride: int(config.anchorStride, DEFAULT_ANCHOR_STRIDE),
    maxBreakpoints: int(config.maxBreakpoints, MAX_BREAKPOINTS),
  };
  const override = matchOverride(config.overrides ?? {}, model, vendor);
  const merged: CachePolicy = { ...base, ...override };
  if (config.enabled === false) merged.strategy = "off";
  return normalize(merged);
}

/** The sparse hint a step attaches: only what its configuration names for this model. */
export function resolveHint(raw: unknown, model: string): CacheHint {
  const config = readCacheConfig(raw);
  const hint: CacheHint = { version: 1 };
  if (config.enabled === false) hint.strategy = "off";
  else if (config.explicitVendors) hint.strategy = config.explicitVendors.map((v) => v.toLowerCase()).includes(vendorOf(model)) ? "breakpoints" : "automatic";
  if (config.ttl !== undefined) hint.ttl = ttl(config.ttl, DEFAULT_TTL);
  if (config.systemTtl !== undefined) hint.systemTtl = ttl(config.systemTtl, DEFAULT_SYSTEM_TTL);
  if (config.anchorStride !== undefined) hint.anchorStride = int(config.anchorStride, DEFAULT_ANCHOR_STRIDE);
  if (config.maxBreakpoints !== undefined) hint.maxBreakpoints = int(config.maxBreakpoints, MAX_BREAKPOINTS);
  const override = matchOverride(config.overrides ?? {}, model, vendorOf(model));
  return { ...hint, ...override };
}

/** Validates a hint that crossed the fence. Unknown or malformed fields are dropped; nothing usable gives undefined. */
export function readHint(raw: unknown): CacheHint | undefined {
  const result = CacheHintInputSchema.safeParse(raw);
  if (!result.success) return undefined;
  const hint = result.data;
  for (const key of Object.keys(hint) as (keyof typeof hint)[]) if (hint[key] === undefined) delete hint[key];
  return Object.keys(hint).length ? hint : undefined;
}

/**
 * Combines the provider's policy with a hint. `ignore` keeps the policy. `tune` lets the hint set the
 * lifetimes, the stride, the budget and the affinity, never the strategy: whether caching happens
 * stays with whoever pays. `override` lets the hint replace everything it names.
 */
export function applyHint(policy: CachePolicy, hint: CacheHint | undefined, mode: HintMode = "tune"): CachePolicy {
  if (!hint || mode === "ignore") return policy;
  const { strategy, version, ...knobs } = hint;
  const merged: CachePolicy = { ...policy, ...defined(knobs) };
  if (mode === "override" && strategy) merged.strategy = strategy;
  return normalize(merged);
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Clamps every knob into the range a provider accepts. */
export function normalize(p: CachePolicy): CachePolicy {
  const out: CachePolicy = { ...p };
  out.anchorStride = Math.max(0, Math.min(1000, Math.floor(out.anchorStride)));
  out.maxBreakpoints = Math.max(1, Math.min(MAX_BREAKPOINTS, Math.floor(out.maxBreakpoints)));
  if (!TTLS.has(out.ttl)) out.ttl = DEFAULT_TTL;
  if (!TTLS.has(out.systemTtl)) out.systemTtl = DEFAULT_SYSTEM_TTL;
  // A 1h conversation entry behind a 5m system entry is rejected upstream; lift the system entry instead.
  if (out.ttl === "1h" && out.systemTtl === "5m") out.systemTtl = "1h";
  return out;
}

function matchOverride(overrides: Record<string, CacheOverride>, model: string, vendor: string): CacheOverride {
  let best: { key: string; value: CacheOverride } | undefined;
  for (const [key, value] of Object.entries(overrides)) {
    const k = key.toLowerCase();
    if (!(k === vendor || model.toLowerCase().startsWith(k))) continue;
    if (!best || k.length > best.key.length) best = { key: k, value };
  }
  return best?.value ?? {};
}

function ttl(v: unknown, fallback: CacheTtl): CacheTtl {
  return CacheTtlSchema.safeParse(v).data ?? fallback;
}

function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// The cache policy: what the harness decides per call, and what a provider is allowed to act on.
//
// Providers differ in kind, not only in syntax. Anthropic caches nothing unless the request marks
// where; OpenAI, DeepSeek, Grok, Moonshot and Groq cache long prefixes on their own; Gemini caches
// implicitly on recent models and bills storage for explicit marks. So the strategy is per vendor,
// resolved from the model id, and a policy carries only knobs a provider can clamp.

export type CacheTtl = "5m" | "1h";
export type CacheStrategy = "breakpoints" | "automatic" | "off";

/** The resolved policy a provider acts on. The provider owns it; a hint may tune it. */
export interface CachePolicy {
  version: 1;
  strategy: CacheStrategy;
  /** Lifetime asked for the conversation breakpoints. */
  ttl: CacheTtl;
  /** Lifetime asked for the system-prefix breakpoint. Never shorter than `ttl`: a longer entry must precede shorter ones. */
  systemTtl: CacheTtl;
  /** Positions between the stable anchor breakpoints. 0 disables anchors. */
  anchorStride: number;
  /** Upper bound on breakpoints in one request. Anthropic accepts at most 4. */
  maxBreakpoints: number;
  /** Opaque stable identifier the provider can pass upstream to keep related requests together. */
  affinity?: string;
}

/**
 * What a step attaches as `call.hints.cache`: only the knobs it wants to change, plus an affinity
 * token. The provider validates it on arrival and applies it according to its `hints` mode.
 */
export interface CacheHint extends CacheOverride {
  version?: 1;
  affinity?: string;
}

/** How a provider treats a hint: ignore it, let it tune the knobs, or let it replace the policy. */
export type HintMode = "ignore" | "tune" | "override";

/** Per-vendor or per-model override. Keys of `overrides` are matched as prefixes of the model id. */
export interface CacheOverride {
  strategy?: CacheStrategy;
  ttl?: CacheTtl;
  systemTtl?: CacheTtl;
  anchorStride?: number;
  maxBreakpoints?: number;
}

/** `config.packages["@thetis/prompt-cache"]`. */
export interface CacheConfig {
  enabled?: boolean;
  ttl?: string;
  systemTtl?: string;
  anchorStride?: number;
  maxBreakpoints?: number;
  /** Vendors that cache nothing unless told to. Every other vendor is left automatic. */
  explicitVendors?: string[];
  overrides?: Record<string, CacheOverride>;
  /** Record prefix fingerprints in the harness and log when a turn rewrites the cached prefix. */
  diagnostics?: boolean;
  /** Send a stable per-user token to the provider (OpenRouter: the `user` field). */
  affinity?: boolean;
  /** Provider side only: what a hint from the harness may do. Default `tune`. */
  hints?: HintMode;
}

export const MAX_BREAKPOINTS = 4;
export const DEFAULT_TTL: CacheTtl = "5m";
export const DEFAULT_SYSTEM_TTL: CacheTtl = "1h";
export const DEFAULT_ANCHOR_STRIDE = 8;
export const DEFAULT_EXPLICIT_VENDORS = ["anthropic"];

const TTLS = new Set<string>(["5m", "1h"]);
const STRATEGIES = new Set<string>(["breakpoints", "automatic", "off"]);

/** `vendor/model` ids name their vendor; a bare id is its own vendor, which is how a direct endpoint looks. */
export function vendorOf(model: string): string {
  return (model.split("/")[0] ?? "").trim().toLowerCase();
}

/** Builds the policy for one model from the package configuration. */
export function resolvePolicy(config: CacheConfig, model: string): CachePolicy {
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
export function resolveHint(config: CacheConfig, model: string): CacheHint {
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
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const hint: CacheHint = {};
  if (STRATEGIES.has(String(r.strategy))) hint.strategy = r.strategy as CacheStrategy;
  if (typeof r.ttl === "string" && TTLS.has(r.ttl)) hint.ttl = r.ttl as CacheTtl;
  if (typeof r.systemTtl === "string" && TTLS.has(r.systemTtl)) hint.systemTtl = r.systemTtl as CacheTtl;
  if (typeof r.anchorStride === "number" && Number.isFinite(r.anchorStride)) hint.anchorStride = r.anchorStride;
  if (typeof r.maxBreakpoints === "number" && Number.isFinite(r.maxBreakpoints)) hint.maxBreakpoints = r.maxBreakpoints;
  if (typeof r.affinity === "string" && r.affinity.length > 0 && r.affinity.length <= 128) hint.affinity = r.affinity;
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
  return typeof v === "string" && TTLS.has(v) ? (v as CacheTtl) : fallback;
}

function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

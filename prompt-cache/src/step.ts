// The `call`-phase step: advise the provider with a sparse hint (only what this package is configured
// to change, plus a per-user affinity token) and keep the prefix diagnostics in the harness. The
// provider owns the policy; see `applyHint`.

import { createHash } from "node:crypto";
import type { PackageStepContext, StepResult } from "@thetis/runtime/contracts";
import { diagnose, describe, fingerprint, CacheDiagnosticsSchema, type CacheDiagnostics } from "./fingerprint.js";
import { resolveHint, readCacheConfig } from "./policy.js";

export const HARNESS_KEY = "@thetis/prompt-cache";
export const HINT_KEY = "cache";

export async function cacheHints(ctx: PackageStepContext): Promise<StepResult> {
  const config = readCacheConfig(ctx.config);
  const hint = resolveHint(config, ctx.call.model);
  if (config.affinity !== false) hint.affinity = affinityOf(ctx.session.user);
  const call = { ...ctx.call, hints: { ...(ctx.call.hints ?? {}), [HINT_KEY]: hint } };
  if (config.diagnostics === false) return { call };

  const prev = CacheDiagnosticsSchema.safeParse(ctx.harness[HARNESS_KEY]).data;
  const next = fingerprint(ctx.call);
  const divergence = diagnose(prev, next);
  const turn = (prev?.turns ?? 0) + 1;
  const diagnostics: CacheDiagnostics = { ...next, turns: turn, divergences: (prev?.divergences ?? 0) + (divergence ? 1 : 0), last: prev?.last };
  if (divergence) {
    diagnostics.last = { ...divergence, turn };
    console.error(`prompt-cache: turn ${turn}: ${describe(divergence)}`);
  }
  return { call, harness: { ...ctx.harness, [HARNESS_KEY]: diagnostics } };
}

/** A stable token per user that does not spell the user id out. */
export function affinityOf(user: string): string {
  return `thetis:${createHash("sha256").update(user).digest("hex").slice(0, 16)}`;
}

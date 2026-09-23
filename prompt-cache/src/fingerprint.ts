// Client-side cache diagnostics. The provider's usage numbers say *that* the prefix broke; a
// fingerprint of the previous call says *where*. Every turn hashes the head (model, system, tools)
// and each outgoing message; the next turn checks that the previous call is still a prefix.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProviderCall } from "@thetis/runtime/contracts";

const FingerprintSchema = z.object({ head: z.string(), messages: z.array(z.string()) });
const DivergenceSchema = z.object({ kind: z.enum(["head", "rewrite", "truncate"]), at: z.number().int().nonnegative().optional() });
export const CacheDiagnosticsSchema = FingerprintSchema.extend({
  turns: z.number().int().nonnegative(),
  divergences: z.number().int().nonnegative(),
  last: DivergenceSchema.extend({ turn: z.number().int().nonnegative() }).optional(),
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;
export type Divergence = z.infer<typeof DivergenceSchema>;
export type DivergenceKind = Divergence["kind"];
export type CacheDiagnostics = z.infer<typeof CacheDiagnosticsSchema>;

export function fingerprint(call: ProviderCall): Fingerprint {
  const tools = call.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return {
    head: hash(JSON.stringify({ model: call.model, system: call.system ?? "", tools })),
    messages: call.messages.map((m) => hash(JSON.stringify(m))),
  };
}

/** Compares this call with the previous one. Undefined means the previous call is a prefix of this one. */
export function diagnose(prev: Fingerprint | undefined, next: Fingerprint): Divergence | undefined {
  if (!prev) return undefined;
  if (prev.head !== next.head) return { kind: "head" };
  const n = Math.min(prev.messages.length, next.messages.length);
  for (let i = 0; i < n; i++) if (prev.messages[i] !== next.messages[i]) return { kind: "rewrite", at: i };
  if (next.messages.length < prev.messages.length) return { kind: "truncate", at: next.messages.length };
  return undefined;
}

export function describe(d: Divergence): string {
  switch (d.kind) {
    case "head":
      return "model, system prompt or tool list changed; the whole prefix is re-written";
    case "rewrite":
      return `message ${d.at} changed; the prefix is re-written from there`;
    case "truncate":
      return `history was cut to ${d.at} messages; the prefix is re-written from there`;
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

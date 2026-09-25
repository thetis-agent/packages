// How big the next request is, and how big it may get. The window comes from configuration first, the
// provider's descriptor second, a configured default last. The count comes from the provider when it
// describes the projection that is about to be sent, and from the estimate otherwise: a count taken
// before the last compaction describes a history that no longer exists, and trusting it is how a
// compaction loop starts.
import { z } from "zod";
import type { Message, ModelDescriptor, StepEnv } from "@thetis/runtime/contracts";
import type { CompactionState, Config } from "./schemas.js";
import { estimate } from "./select.js";

/** The one field this package reads off a descriptor beyond its id; not every provider reports it. */
const DescriptorWindowSchema = z.looseObject({ id: z.string(), contextLength: z.number().positive().optional() });

/**
 * The window compaction plans against. A configured `windows` entry for the model (longest key wins) is
 * taken as it is. Otherwise `window` is a ceiling on what the provider reports: a model that reports less
 * gets its own figure, and one that reports more (a 1M Claude model) is planned as if it had `window`. The
 * ceiling is the whole point of the setting: the number a person sees on the configuration page is the
 * number compaction works to, and a model's real window is at most a quality and cost choice, never the
 * one thing that decides when a conversation is summarized.
 */
export function windowFor(model: string, config: Pick<Config, "window" | "windows">, descriptors: ModelDescriptor[]): number {
  let best: { key: string; window: number } | undefined;
  for (const [key, window] of Object.entries(config.windows ?? {})) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) best = { key, window };
  }
  if (best) return best.window;
  const found = descriptors.find((d) => d.id === model);
  const reported = found ? DescriptorWindowSchema.safeParse(found).data?.contextLength : undefined;
  return reported === undefined ? config.window : Math.min(reported, config.window);
}

/** What harness-core leaves under its own key after every turn; only the fields this package reads. */
export const LastCallSchema = z.looseObject({
  model: z.string(),
  messages: z.number().int().nonnegative(),
  at: z.string(),
  usage: z.record(z.string(), z.number()).optional(),
});
export type LastCall = z.infer<typeof LastCallSchema>;

export function readLastCall(harness: Record<string, unknown> | undefined): LastCall | undefined {
  const own = harness?.["@thetis/harness-core"] as { lastCall?: unknown } | undefined;
  return LastCallSchema.safeParse(own?.lastCall).data;
}

export interface Measure {
  used: number;
  /** True when no trustworthy provider count existed and `used` is the estimate alone. */
  estimated: boolean;
  /** When the provider count was taken, when one was used. */
  usedAt?: string;
}

/**
 * The size of `projected` as it would be sent for `model`. The provider's count is trusted when it is for
 * the same model, was taken after the projection last changed, and counted no more messages than the
 * projection now has; the messages it did not see are added by estimate. Otherwise the estimate stands alone.
 */
export function measure(projected: Message[], model: string, state: CompactionState, lastCall: LastCall | undefined): Measure {
  const prompt = lastCall?.usage?.prompt_tokens;
  const changedAt = state.projectedAt ?? state.last?.at;
  const trusted =
    lastCall !== undefined &&
    typeof prompt === "number" && Number.isFinite(prompt) &&
    lastCall.model === model &&
    lastCall.messages <= projected.length &&
    (changedAt === undefined || lastCall.at > changedAt);
  if (!trusted) return { used: estimate(projected), estimated: true };
  return { used: prompt + estimate(projected.slice(lastCall.messages)), estimated: false, usedAt: lastCall.at };
}

/** The count between rounds: the previous round's prompt count plus what the loop appended since. */
export function measureRound(messages: Message[], usage: Record<string, number> | undefined, priced: number): Measure {
  const prompt = usage?.prompt_tokens;
  if (typeof prompt !== "number" || !Number.isFinite(prompt) || priced > messages.length) return { used: estimate(messages), estimated: true };
  return { used: prompt + estimate(messages.slice(priced)), estimated: false };
}

const DESCRIPTOR_TTL_MS = 5 * 60 * 1000;
const descriptorCache = new Map<string, { at: number; models: ModelDescriptor[] }>();

/**
 * The fence's model list, kept for five minutes. The kernel caches too, but the list is hundreds of entries
 * and the round hook runs every round. A failing `models()` is an empty list: the window then comes from
 * configuration, and nothing about compaction depends on the call succeeding.
 */
export async function descriptorsFor(env: Pick<StepEnv, "root" | "kernel">, now = Date.now()): Promise<ModelDescriptor[]> {
  const key = env.root;
  const cached = descriptorCache.get(key);
  if (cached && now - cached.at < DESCRIPTOR_TTL_MS) return cached.models;
  let models: ModelDescriptor[] = [];
  try {
    const choices = await env.kernel.models();
    models = Array.isArray(choices?.models) ? choices.models : [];
  } catch {
    models = [];
  }
  descriptorCache.set(key, { at: now, models });
  return models;
}

/** For tests, and for a fence that wants a fresh list before the five minutes are up. */
export function forgetDescriptors(): void {
  descriptorCache.clear();
}

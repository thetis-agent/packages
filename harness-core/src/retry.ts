// The round retry: what the loop does when one request to the model fails in a way that asking again could
// fix. The harness owns the round -- it holds the streamed half of the reply, the watch, the events -- so it
// is the one layer that can throw a half round away cleanly and send the same request again. A provider only
// labels its errors (`retryable`, `kind`, `status`, `retryAfterMs`); the policy is here, in one place, for
// every provider.
//
// The retried request is the same `call` object, byte for byte: no round hook runs again, nothing is added to
// `call.messages`. By the time an upstream is streaming it has already read and cached the prompt, so the
// second attempt reads the whole prefix from the cache and pays only for the reply again. No tool of the cut
// round has run: tool calls arrive only with a finished stream, and tools run after it.
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { Message, ProviderCall, UiCommandEnv, UiCommandResult } from "@thetis/runtime/contracts";
import { textContent } from "@thetis/runtime/lib/content";

/** Why a model call failed, in the words the turn record and the pages use. */
export type FailureKind = "connection" | "rate-limit" | "overloaded" | "timeout" | "credits" | "context" | "output-limit" | "filter" | "auth" | "other";

const KINDS: readonly FailureKind[] = ["connection", "rate-limit", "overloaded", "timeout", "credits", "context", "output-limit", "filter", "auth", "other"];

/** What a provider's `error` event says besides its message. Every field is optional: a provider that labels nothing loses nothing. */
export interface FailureLabel {
  retryable?: boolean;
  kind?: FailureKind;
  status?: number;
  retryAfterMs?: number;
}

/** A failed request: the message, and whatever the provider said about it. */
export interface Failure extends FailureLabel {
  message: string;
}

/** The labels of one provider `error` event, read leniently: a field of the wrong shape is simply not there. */
export function labelOf(event: Record<string, unknown>): FailureLabel {
  const out: FailureLabel = {};
  if (typeof event.retryable === "boolean") out.retryable = event.retryable;
  if (typeof event.kind === "string" && (KINDS as readonly string[]).includes(event.kind)) out.kind = event.kind as FailureKind;
  if (typeof event.status === "number" && Number.isFinite(event.status)) out.status = event.status;
  if (typeof event.retryAfterMs === "number" && Number.isFinite(event.retryAfterMs) && event.retryAfterMs >= 0) out.retryAfterMs = event.retryAfterMs;
  return out;
}

/** The numbers. Exported so the manifest, the README and the tests cannot quietly disagree with the code. */
export const RETRY_DEFAULTS = {
  /** How many times one failed round is sent again. The waits are 2, 4, 8, 16, 32 s with the defaults. */
  retryAttempts: 5,
  /** The first wait. Each later one doubles, with a fifth either way of jitter. */
  retryBaseMs: 2_000,
  /** The longest one wait grows to by doubling. A Retry-After the provider asked for may be longer. */
  retryMaxMs: 60_000,
  /** The most a turn spends waiting between retries, all rounds together. A wait that does not fit ends the retrying. */
  retryBudgetMs: 300_000,
} as const;

export interface RetryConfig {
  retryAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  retryBudgetMs: number;
}

const positive = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);

/** `retryAttempts` may be 0, which means never ask again; the three times fall back to the default when they are not a positive number. */
export function retryConfig(config: Record<string, unknown>): RetryConfig {
  const attempts = config.retryAttempts;
  return {
    retryAttempts: typeof attempts === "number" && Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : RETRY_DEFAULTS.retryAttempts,
    retryBaseMs: positive(config.retryBaseMs) ?? RETRY_DEFAULTS.retryBaseMs,
    retryMaxMs: positive(config.retryMaxMs) ?? RETRY_DEFAULTS.retryMaxMs,
    retryBudgetMs: positive(config.retryBudgetMs) ?? RETRY_DEFAULTS.retryBudgetMs,
  };
}

/**
 * What the loop does about one failure:
 * - `full`: a transient failure of the line or the upstream -- a dropped or stalled stream, a rate limit, an
 *   overloaded or failing upstream. Sent again up to `retryAttempts` times.
 * - `once`: a reply that came back unusable, where a second sample usually differs -- an empty reply, tool
 *   arguments that are not JSON, a content filter stop. Sent again once.
 * - `longer`: the reply hit the output limit. The same request would stop at the same place, so it is sent once
 *   more with the limit raised and a one-line note to write large things in parts.
 * - `none`: the request itself is wrong (too long for the window, no credit, no access, no such model), or a
 *   failure nobody labelled and whose words say nothing transient. A later Retry may still help, after a fix.
 */
export interface Verdict {
  plan: "full" | "once" | "longer" | "none";
  kind: FailureKind;
  retryable: boolean;
  retryAfterMs?: number;
}

const TRANSIENT_KINDS = new Set<FailureKind>(["connection", "rate-limit", "overloaded", "timeout"]);
const FINAL_KINDS = new Set<FailureKind>(["credits", "context", "auth"]);

/**
 * The kind a failure's words point at, for a provider that labels nothing and for the kernel's own refusals.
 * Only wording that says the line or the upstream failed counts as transient; anything else is `other`.
 */
export function kindFromMessage(message: string): FailureKind {
  if (/output limit|max_tokens/i.test(message)) return "output-limit";
  if (/content filter/i.test(message)) return "filter";
  if (/rate.?limit|\b429\b|in_flight_budget/i.test(message)) return "rate-limit";
  if (/overloaded|\b(502|503|529)\b|temporarily unavailable|upstream error/i.test(message)) return "overloaded";
  if (/timed? ?out|timeout|\b(408|504)\b|sent nothing for|no response from/i.test(message)) return "timeout";
  if (/fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network|connection (closed|reset|dropped|refused)|terminated|stream failed/i.test(message)) return "connection";
  if (/\b402\b|credits?\b/i.test(message)) return "credits";
  if (/context (length|window)|too long|maximum context/i.test(message)) return "context";
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|api ?key/i.test(message)) return "auth";
  return "other";
}

/** The verdict on one failure: what the provider said when it said it, the words otherwise. */
export function classify(failure: Failure): Verdict {
  const kind = failure.kind ?? kindFromMessage(failure.message);
  const wait = failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {};
  if (kind === "output-limit") return { plan: "longer", kind, retryable: false };
  if (kind === "filter") return { plan: "once", kind, retryable: failure.retryable ?? false };
  if (FINAL_KINDS.has(kind)) return { plan: "none", kind, retryable: false };
  if (failure.retryable === false) return { plan: "none", kind, retryable: false };
  if (TRANSIENT_KINDS.has(kind)) return { plan: "full", kind, retryable: true, ...wait };
  // A provider that said "worth another try" about something that is not the line: one more sample.
  if (failure.retryable === true) return { plan: "once", kind, retryable: true, ...wait };
  return { plan: "none", kind, retryable: false };
}

/**
 * The wait before retry `n` (1 for the first): `retryBaseMs` doubled per retry, capped at `retryMaxMs`, with a
 * fifth either way of jitter so that many turns cut by one outage do not all come back in the same second. A
 * wait the provider asked for (Retry-After) is honoured when it is longer.
 */
export function backoffMs(cfg: RetryConfig, n: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const base = Math.min(cfg.retryMaxMs, cfg.retryBaseMs * 2 ** Math.max(0, n - 1));
  const jittered = Math.round(base * (0.8 + 0.4 * random()));
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** How often a backoff wait looks for a "retry now" request. */
export const RETRY_POLL_MS = 500;

/**
 * Where a "retry now" request waits: one small file under the person's home. A file rather than
 * `env.storage()`, for the reason `@thetis/compaction` gives for its requests: the page's command runs under
 * the gateway's environment and the step under this package's, and the home is the one place both reach at
 * the same path. Relative to the home.
 */
export function retryRequestPath(session: string): string {
  // Session ids are kernel-issued; check at the filesystem boundary as well, since the id becomes a path.
  if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("invalid session id");
  return `harness-core/retry/${session}.json`;
}

/** Takes a pending "retry now" request, if there is one. Removing the file is the reading of it, so one click is one retry. */
export async function takeRetryRequest(home: string, session: string): Promise<boolean> {
  try {
    await unlink(resolve(home, retryRequestPath(session)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits `ms` before the next attempt. Ends early, with `now`, when a "retry now" request appears, and with
 * `stopped` the moment the turn's signal aborts: a Stop is never held up by a backoff.
 */
export async function backoffWait(signal: AbortSignal, home: string, session: string, ms: number): Promise<"elapsed" | "now" | "stopped"> {
  const end = Date.now() + ms;
  for (;;) {
    if (signal.aborted) return "stopped";
    if (await takeRetryRequest(home, session)) return "now";
    const left = end - Date.now();
    if (left <= 0) return signal.aborted ? "stopped" : "elapsed";
    await sleep(Math.min(RETRY_POLL_MS, left), signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** The most output a raised limit asks for. A model allows less than this or about this; none allows more. */
export const OUTPUT_LIMIT_CAP = 128_000;

/** The one line the retried request carries after an output-limit stop, for that attempt only. */
export const OUTPUT_LIMIT_NOTE = "[Harness note: your last reply hit the output limit and was discarded. Write large files in parts: several smaller writes or edits, not one.]";

/**
 * The request to send after an output-limit stop: the same call with `max_tokens` doubled (up to
 * `OUTPUT_LIMIT_CAP`) when the limit is known, and the note appended as a user message. A copy: the loop's
 * own `call.messages` never carries the note, so the next round's request is the conversation as it is.
 * The limit is known from `call.params.max_tokens`, or from the provider's own message ("output limit of
 * 32768 tokens").
 */
export function withLongerLimit(call: ProviderCall, failure: string): ProviderCall {
  const set = call.params?.max_tokens;
  const said = /output limit of (\d+) tokens/.exec(failure);
  const limit = typeof set === "number" && set > 0 ? set : said ? Number(said[1]) : undefined;
  const raised = limit !== undefined ? Math.min(OUTPUT_LIMIT_CAP, limit * 2) : undefined;
  const note: Message = { role: "user", content: textContent(OUTPUT_LIMIT_NOTE) };
  return {
    ...call,
    messages: [...call.messages, note],
    params: raised !== undefined && limit !== undefined && raised > limit ? { ...call.params, max_tokens: raised } : call.params,
  };
}

/**
 * `retry-now`: the page's "Retry now" button while a round waits to be sent again. It writes the request file;
 * the waiting loop sees it within half a second, removes it and sends at once. Nothing is checked about the
 * turn: a request that arrives when nothing is waiting is removed at the start of the next wait.
 */
export async function uiRetryNow(args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const session = typeof args.session === "string" && args.session ? args.session : env.session;
  if (!session) throw new Error("no conversation is open");
  await env.writeFile(retryRequestPath(session), JSON.stringify({ at: new Date().toISOString() }));
  return { data: { requested: true, session } };
}

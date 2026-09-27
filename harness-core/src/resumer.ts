// The resumer: at fence open -- at boot, and after every apply of this workspace -- it continues the turns a
// restart, an apply, a crash or a drain cut short, so nobody has to come back and type "continue". A resume
// is a turn with no input (`sessions.send(id, [])`): it runs over the saved conversation and appends nothing,
// and the `resume` step and `callModel` take care of a cut reply and of tools that never ran.
//
// What it resumes is narrow on purpose:
// - only why ∈ restart | reload | crash | yield: a turn the person stopped, a workflow's budget cut and a
//   provider failure are somebody's decision or need somebody's fix, and each has its own button;
// - only root conversations: a subagent's parent decides about its child (`resume_subagent`);
// - only a chain's first resume: a turn that is cut again while resuming is left for a person;
// - only recent ones: a turn cut hours ago is not what anybody is waiting for;
// - two at a time, two seconds apart, so a restart does not start every cut turn at the same moment.
// A conversation that is busy, or that somebody resumed meanwhile, is skipped.
import type { ServiceEnv, ServiceHandle } from "@thetis/runtime/contracts";
import { z } from "zod";

/** The numbers. Exported so the manifest, the README and the tests cannot quietly disagree with the code. */
export const RESUME_DEFAULTS = {
  autoResume: true,
  /** A cut turn older than this is left for a person. */
  resumeMaxAgeMs: 1_800_000,
} as const;

/** The reasons a turn was cut that the resumer continues by itself. */
export const AUTO_RESUME_WHY = ["restart", "reload", "crash", "yield"] as const;

/** How many resumes run at once, and the least time between two starting. */
export const RESUME_LANES = 2;
export const RESUME_GAP_MS = 2_000;
/** The wait after the fence opens before the first look: the fence is still being put into service. */
export const RESUME_START_DELAY_MS = 2_000;

export interface ResumerConfig {
  autoResume: boolean;
  resumeMaxAgeMs: number;
}

export function resumerConfig(config: Record<string, unknown>): ResumerConfig {
  const age = config.resumeMaxAgeMs;
  return {
    autoResume: config.autoResume !== false,
    resumeMaxAgeMs: typeof age === "number" && Number.isFinite(age) && age > 0 ? age : RESUME_DEFAULTS.resumeMaxAgeMs,
  };
}

const InterruptedSchema = z.looseObject({
  turn: z.string().optional(),
  at: z.string(),
  why: z.string().optional(),
  resumes: z.number().optional(),
});
const SummarySchema = z.looseObject({ id: z.string(), parent: z.string().optional(), running: z.boolean().optional(), interrupted: InterruptedSchema.optional() });
const RecordSchema = z.looseObject({ status: z.string().optional(), turn: z.unknown().optional(), interrupted: InterruptedSchema.optional() });

type Interrupted = z.infer<typeof InterruptedSchema>;

/** Whether one cut turn is the resumer's to continue, at `now`. */
export function resumable(interrupted: Interrupted | undefined, cfg: ResumerConfig, now: number): boolean {
  if (!interrupted?.why || !(AUTO_RESUME_WHY as readonly string[]).includes(interrupted.why)) return false;
  if ((interrupted.resumes ?? 0) >= 1) return false;
  const at = Date.parse(interrupted.at);
  return Number.isFinite(at) && now - at < cfg.resumeMaxAgeMs;
}

/** The conversations to resume, newest cut first, from what `sessions.list()` answered. */
export function pick(summaries: unknown[], cfg: ResumerConfig, now: number): string[] {
  const picked: { id: string; at: number }[] = [];
  for (const raw of summaries) {
    const s = SummarySchema.safeParse(raw).data;
    if (!s || s.parent || s.running || !resumable(s.interrupted, cfg, now)) continue;
    picked.push({ id: s.id, at: Date.parse(s.interrupted!.at) });
  }
  return picked.sort((a, b) => b.at - a.at).map((p) => p.id);
}

const isBusy = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === "busy" || /already has a turn in progress/.test(err instanceof Error ? err.message : String(err));

export interface ResumeRun {
  resumed: string[];
  skipped: string[];
  failed: { id: string; error: string }[];
}

/**
 * One pass: list, pick, and resume, `RESUME_LANES` at a time with `RESUME_GAP_MS` between two starts. Each
 * pick is read again just before its turn starts, because somebody may have resumed it meanwhile; a record
 * that is running, or no longer carries the same cut, is skipped, and so is a `busy` refusal. Never throws.
 */
export async function resumeOnce(env: Pick<ServiceEnv, "kernel" | "log">, cfg: ResumerConfig, opts: { gapMs?: number; stopped?: () => boolean; now?: () => number } = {}): Promise<ResumeRun> {
  const run: ResumeRun = { resumed: [], skipped: [], failed: [] };
  const gap = opts.gapMs ?? RESUME_GAP_MS;
  const now = opts.now ?? Date.now;
  let queue: string[];
  try {
    queue = pick(await env.kernel.sessions.list(), cfg, now());
  } catch (err) {
    env.log(`resumer: could not list the conversations: ${message(err)}`);
    return run;
  }
  let lastStart = -Infinity;
  const turnStarts = async (): Promise<void> => {
    // Starts are spaced whichever lane asks: a lane reserves its slot before it waits for it.
    const at = Math.max(now(), lastStart + gap);
    lastStart = at;
    const wait = at - now();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait).unref?.());
  };
  const lane = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (opts.stopped?.()) return;
      await turnStarts();
      if (opts.stopped?.()) return;
      try {
        const record = RecordSchema.safeParse(await env.kernel.sessions.inspect(id)).data;
        if (!record || record.status === "running" || record.turn || !resumable(record.interrupted, cfg, now())) {
          run.skipped.push(id);
          continue;
        }
        env.log(`resumer: continuing ${id} (cut by ${record.interrupted!.why} at ${record.interrupted!.at})`);
        await env.kernel.sessions.send(id, [], () => {});
        run.resumed.push(id);
      } catch (err) {
        if (isBusy(err)) run.skipped.push(id);
        else {
          run.failed.push({ id, error: message(err) });
          env.log(`resumer: could not continue ${id}: ${message(err)}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: RESUME_LANES }, lane));
  return run;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The service. It answers at once -- a service start is bounded, and resuming runs for as long as the resumed
 * turns do -- and makes its one pass after `RESUME_START_DELAY_MS`. Stopping it starts nothing new; a turn it
 * already started is the kernel's like any other, and a restart cuts and records it as one.
 */
export async function resumer(env: ServiceEnv): Promise<ServiceHandle> {
  const cfg = resumerConfig(env.config ?? {});
  if (!cfg.autoResume) return {};
  let stopped = false;
  const timer = setTimeout(() => {
    void resumeOnce(env, cfg, { stopped: () => stopped }).then(
      (run) => {
        if (run.resumed.length || run.failed.length) env.log(`resumer: continued ${run.resumed.length}, skipped ${run.skipped.length}, failed ${run.failed.length}`);
      },
      (err) => env.log(`resumer: ${message(err)}`),
    );
  }, RESUME_START_DELAY_MS);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

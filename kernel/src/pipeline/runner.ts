import type { KernelConfig } from "../config.js";
import type { FencePool } from "../fence/pool.js";
import type { PackageManager } from "../packages/manager.js";
import type { SessionStore } from "../sessions/store.js";
import type { Message, SessionRecord, StepContext, StepResult, Userspace } from "../types.js";
import { KernelError, newId } from "../util.js";
import { Enumerator, isBuiltin } from "./enumerator.js";
import { checkCancelled, type Emit, type ProviderCallStep } from "./provider-call.js";

const ROLES = new Set(["system", "user", "assistant", "tool"]);

/** Runs one turn: enumerate, dispatch each step into the fence, apply mutations, persist. */
export class PipelineRunner {
  constructor(
    private readonly config: KernelConfig,
    private readonly enumerator: Enumerator,
    private readonly providerCall: ProviderCallStep,
    private readonly packages: PackageManager,
    private readonly fences: FencePool,
    private readonly store: SessionStore,
  ) {}

  /** An aborted `signal` ends the turn with an `error` event of code `cancelled`; whatever was applied before is still saved. */
  async runTurn(us: Userspace, session: SessionRecord, input: Message[], emit: Emit, signal?: AbortSignal): Promise<SessionRecord> {
    const turn = { id: newId("t"), input };
    const info = { id: session.id, user: session.user, parent: session.parent };
    const packages = this.packages.installed(us);
    const ctx: StepContext = {
      session: info,
      turn,
      conversation: [...session.conversation, ...input],
      call: { model: this.config.model, messages: [], tools: [], params: {} },
      harness: session.harness,
      packages,
      config: {},
    };
    emit({ type: "turn.start", turn: turn.id, session: session.id });
    try {
      const plan = await this.enumerator.enumerate(us, info, packages);
      for (const step of plan) {
        checkCancelled(signal);
        emit({ type: "step.start", step });
        const started = Date.now();
        const result = isBuiltin(step)
          ? await this.providerCall.run(us, ctx, emit, signal)
          : await this.fences.request(us, "step", { package: step.package, export: step.export, ctx: { ...ctx, config: this.config.packages[step.package] ?? {} } }, undefined, signal);
        this.apply(ctx, result, step.id ?? step.export);
        emit({ type: "step.end", step, ms: Date.now() - started });
      }
    } catch (err) {
      const code = err instanceof KernelError ? err.code : undefined;
      emit({ type: "error", message: err instanceof Error ? err.message : String(err), code });
    } finally {
      session.conversation = ctx.conversation;
      session.harness = ctx.harness;
      session.turns += 1;
      this.store.save(us, session);
      emit({ type: "turn.end", turn: turn.id, session: session.id });
    }
    return session;
  }

  /** Validates a step's mutations before they touch the variables. Invalid results are rejected whole. */
  private apply(ctx: StepContext, raw: unknown, stepId: string): void {
    if (raw == null) return;
    if (typeof raw !== "object") throw new KernelError(`step ${stepId} returned a non-object result`, "step");
    const r = raw as StepResult;
    if (r.conversation !== undefined) {
      if (!Array.isArray(r.conversation) || !r.conversation.every(isMessage)) throw new KernelError(`step ${stepId} returned an invalid conversation`, "step");
      ctx.conversation = r.conversation;
    }
    if (r.call !== undefined) {
      if (typeof r.call !== "object" || typeof r.call.model !== "string" || !Array.isArray(r.call.messages)) throw new KernelError(`step ${stepId} returned an invalid call`, "step");
      ctx.call = { ...r.call, tools: Array.isArray(r.call.tools) ? r.call.tools : [], params: r.call.params ?? {} };
    }
    if (r.harness !== undefined) {
      if (typeof r.harness !== "object" || Array.isArray(r.harness)) throw new KernelError(`step ${stepId} returned an invalid harness`, "step");
      ctx.harness = r.harness;
    }
  }
}

function isMessage(m: unknown): m is Message {
  const x = m as Message;
  return !!x && typeof x === "object" && ROLES.has(x.role) && typeof x.content === "string";
}

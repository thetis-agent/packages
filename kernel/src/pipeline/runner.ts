import type { Fences, Message, SessionRecord, StepContext, StepRef, StepResult, TurnOptions, Userspace } from "@thetis/contracts";
import { CodedError, errorMessage } from "@thetis/lib/error";
import { newId, now } from "@thetis/lib/ids";
import type { Journal } from "@thetis/lib/journal";
import type { JsonDirStore } from "@thetis/lib/json-store";
import type { KernelConfig } from "../config.js";
import type { PackageManager } from "../packages/manager.js";
import type { Settings } from "../settings.js";
import { Enumerator, isBuiltin } from "./enumerator.js";
import { checkCancelled, type Emit, type ProviderCallStep } from "./provider-call.js";

const ROLES = new Set(["system", "user", "assistant", "tool"]);

/** Runs one turn: enumerate, dispatch each step into the fence, apply mutations, persist. */
export class PipelineRunner {
  constructor(
    private readonly config: KernelConfig,
    private readonly settings: Settings,
    private readonly enumerator: Enumerator,
    private readonly providerCall: ProviderCallStep,
    private readonly packages: PackageManager,
    private readonly fences: Fences,
    private readonly store: JsonDirStore<SessionRecord>,
    private readonly journal: Journal,
  ) {}

  /** An aborted `signal` ends the turn with an `error` event of code `cancelled`; whatever was applied before is still saved. */
  async runTurn(us: Userspace, session: SessionRecord, input: Message[], emitOut: Emit, signal?: AbortSignal, opts: TurnOptions = {}): Promise<SessionRecord> {
    const turn = { id: newId("t"), input };
    const started = Date.now();
    // What the providers reported this turn, summed; it is package-reported, so it is journaled under that name.
    const reported: Record<string, number> = {};
    let failure: { message: string; code?: string } | undefined;
    const emit: Emit = (event) => {
      if (event.type === "usage") for (const [k, v] of Object.entries(event.usage)) reported[k] = (reported[k] ?? 0) + v;
      if (event.type === "error") failure = { message: event.message, code: event.code };
      emitOut(event);
    };
    const info = { id: session.id, user: session.user, parent: session.parent };
    const packages = this.packages.installed(us);
    const ctx: StepContext = {
      session: info,
      turn,
      conversation: [...session.conversation, ...input],
      call: { model: opts.model || this.config.model, messages: [], tools: [], params: {} },
      harness: session.harness,
      packages,
      config: {},
    };
    emit({ type: "turn.start", turn: turn.id, session: session.id });
    this.journal.append({ kind: "turn.start", actor: session.user, target: session.id, data: { turn: turn.id } });
    try {
      const plan = await this.enumerator.enumerate(us, info, packages);
      for (const step of plan) {
        checkCancelled(signal);
        emit({ type: "step.start", step });
        const started = Date.now();
        const result = isBuiltin(step) ? await this.providerCall.run(us, ctx, emit, signal) : await this.runStep(us, step, ctx, signal);
        this.apply(ctx, result, step.id ?? step.export);
        emit({ type: "step.end", step, ms: Date.now() - started });
      }
    } catch (err) {
      const code = err instanceof CodedError ? err.code : undefined;
      emit({ type: "error", message: errorMessage(err), code });
    } finally {
      session.conversation = ctx.conversation;
      session.harness = ctx.harness;
      session.turns += 1;
      session.updatedAt = now();
      this.store.save(us.sessions, session);
      emit({ type: "turn.end", turn: turn.id, session: session.id });
      const data = { turn: turn.id, ms: Date.now() - started, ...(failure ? { error: failure } : {}), reported };
      this.journal.append({ kind: "turn.end", actor: session.user, target: session.id, data });
    }
    return session;
  }

  /** A package step runs inside the fence with its own configuration; the rest of the context is the turn's. */
  private async runStep(us: Userspace, step: StepRef, ctx: StepContext, signal?: AbortSignal): Promise<unknown> {
    const config = await this.settings.effective(us, step.package);
    return this.fences.request(us, "step", { package: step.package, export: step.export, ctx: { ...ctx, config } }, undefined, signal);
  }

  /** Validates a step's mutations before they touch the variables. Invalid results are rejected whole. */
  private apply(ctx: StepContext, raw: unknown, stepId: string): void {
    if (raw == null) return;
    if (typeof raw !== "object") throw new CodedError(`step ${stepId} returned a non-object result`, "step");
    const r = raw as StepResult;
    if (r.conversation !== undefined) {
      if (!Array.isArray(r.conversation) || !r.conversation.every(isMessage)) throw new CodedError(`step ${stepId} returned an invalid conversation`, "step");
      ctx.conversation = r.conversation;
    }
    if (r.call !== undefined) {
      const valid = typeof r.call === "object" && typeof r.call.model === "string" && Array.isArray(r.call.messages);
      if (!valid) throw new CodedError(`step ${stepId} returned an invalid call`, "step");
      ctx.call = { ...r.call, tools: Array.isArray(r.call.tools) ? r.call.tools : [], params: r.call.params ?? {} };
    }
    if (r.harness !== undefined) {
      if (typeof r.harness !== "object" || Array.isArray(r.harness)) throw new CodedError(`step ${stepId} returned an invalid harness`, "step");
      ctx.harness = r.harness;
    }
  }
}

function isMessage(m: unknown): m is Message {
  const x = m as Message;
  return !!x && typeof x === "object" && ROLES.has(x.role) && typeof x.content === "string";
}

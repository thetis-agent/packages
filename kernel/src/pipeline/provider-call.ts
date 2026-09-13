import type { KernelConfig } from "../config.js";
import type { FencePool } from "../fence/pool.js";
import type { ProviderRegistry } from "../providers.js";
import type { Message, ProviderEvent, StepContext, StepResult, ToolCall, ToolSpec, TurnEvent, Userspace } from "../types.js";
import { KernelError } from "../util.js";

export type Emit = (event: TurnEvent) => void;

export function isCancelled(err: unknown): boolean {
  return (err as { code?: string })?.code === "cancelled";
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new KernelError("turn cancelled", "cancelled");
}

/**
 * The one step the kernel runs itself: execute call, append the assistant message,
 * run any requested tools inside the caller's fence, and loop until the model stops.
 */
export class ProviderCallStep {
  constructor(
    private readonly config: KernelConfig,
    private readonly providers: ProviderRegistry,
    private readonly fences: FencePool,
  ) {}

  /**
   * An aborted `signal` stops the loop at the next checkpoint: mid-stream, between tool calls, or between rounds.
   * Text streamed before the cancel is kept as a partial assistant message so the conversation stays coherent.
   */
  async run(us: Userspace, ctx: StepContext, emit: Emit, signal?: AbortSignal): Promise<StepResult> {
    const conversation = [...ctx.conversation];
    const call = { ...ctx.call, messages: ctx.call.messages.length ? [...ctx.call.messages] : [...conversation] };
    const provider = await this.providers.resolve(us, call.model);
    const partial = { text: "" };
    try {
      for (let round = 0; round <= this.config.maxToolRounds; round++) {
        const { message: assistant, usage } = await this.callOnce(provider, call, emit, partial, signal);
        conversation.push(assistant);
        call.messages.push(assistant);
        emit({ type: "message", message: assistant, usage });
        if (!assistant.toolCalls?.length) break;
        for (const tc of assistant.toolCalls) {
          checkCancelled(signal);
          const result = await this.runTool(us, ctx, call.tools, tc, emit, signal);
          conversation.push(result);
          call.messages.push(result);
        }
      }
    } catch (err) {
      if (isCancelled(err) && partial.text) conversation.push({ role: "assistant", content: partial.text });
      if (isCancelled(err)) ctx.conversation = conversation;
      throw err;
    }
    return { conversation, call };
  }

  private async callOnce(provider: Awaited<ReturnType<ProviderRegistry["resolve"]>>, call: StepContext["call"], emit: Emit, partial: { text: string }, signal?: AbortSignal): Promise<{ message: Message; usage?: Record<string, number> }> {
    partial.text = "";
    const toolCalls: ToolCall[] = [];
    let failure: string | undefined;
    let usage: Record<string, number> | undefined;
    checkCancelled(signal);
    await this.providers.call(provider, call, (e: ProviderEvent) => {
      if (e.type === "text") (partial.text += e.delta), emit({ type: "text", delta: e.delta });
      else if (e.type === "tool_call") toolCalls.push(e.call), emit({ type: "tool.call", call: e.call });
      else if (e.type === "usage") (usage = e.usage), emit({ type: "usage", usage: e.usage });
      else if (e.type === "error") failure = e.message;
    }, signal);
    if (failure) throw new KernelError(`provider error: ${failure}`, "provider");
    const msg: Message = { role: "assistant", content: partial.text };
    partial.text = "";
    if (toolCalls.length) msg.toolCalls = toolCalls;
    return { message: msg, usage };
  }

  private async runTool(us: Userspace, ctx: StepContext, tools: ToolSpec[], tc: ToolCall, emit: Emit, signal?: AbortSignal): Promise<Message> {
    const spec = tools.find((t) => t.name === tc.name);
    let result: string;
    try {
      if (!spec) throw new KernelError(`unknown tool: ${tc.name}`, "tool");
      const payload = { package: spec.package, export: spec.export, name: tc.name, args: tc.args, session: ctx.session, config: this.config.packages[spec.package] ?? {} };
      const raw = await this.fences.request(us, "tool", payload, undefined, signal);
      result = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
    } catch (err) {
      if (isCancelled(err)) throw err;
      result = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    emit({ type: "tool.result", id: tc.id, name: tc.name, result });
    return { role: "tool", content: result, toolCallId: tc.id, name: tc.name };
  }
}

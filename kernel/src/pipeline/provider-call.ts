import type { Fences, Message, ProviderEvent, StepContext, StepResult, ToolCall, ToolSpec, TurnEvent, Userspace } from "@thetis/contracts";
import { CodedError, errorCode, errorMessage } from "@thetis/lib/error";
import type { KernelConfig } from "../config.js";
import type { ProviderRegistry, ResolvedProvider } from "../providers.js";

export type Emit = (event: TurnEvent) => void;

/** Gives every tool call of the last assistant message a result when the turn ended before the tool ran. */
function closeDangling(conversation: Message[], reason: string): void {
  const last = [...conversation].reverse().find((m) => m.role === "assistant");
  if (!last?.toolCalls?.length) return;
  const answered = new Set(conversation.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  for (const tc of last.toolCalls) if (!answered.has(tc.id)) conversation.push({ role: "tool", content: `error: ${reason}`, toolCallId: tc.id, name: tc.name });
}

export function isCancelled(err: unknown): boolean {
  return errorCode(err) === "cancelled";
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CodedError("turn cancelled", "cancelled");
}

/**
 * The one step the kernel runs itself: execute call, append the assistant message,
 * run any requested tools inside the caller's fence, and loop until the model stops.
 */
export class ProviderCallStep {
  constructor(
    private readonly config: KernelConfig,
    private readonly providers: ProviderRegistry,
    private readonly fences: Fences,
  ) {}

  /**
   * An aborted `signal` stops the loop at the next checkpoint: mid-stream, between tool calls, or between rounds.
   * Whatever the turn did before it stopped, by cancel or by failure, is kept: text streamed so far becomes a
   * partial assistant message, and a tool call that never ran gets a result saying so, so the record stays a
   * conversation the provider will accept on the next turn. Sixteen tool calls are not worth losing to one refusal.
   */
  async run(us: Userspace, ctx: StepContext, emit: Emit, signal?: AbortSignal): Promise<StepResult> {
    const conversation = [...ctx.conversation];
    const call = { ...ctx.call, messages: ctx.call.messages.length ? [...ctx.call.messages] : [...conversation] };
    const provider = await this.providers.resolve(us, call.model);
    const partial = { text: "" };
    try {
      for (;;) {
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
      if (partial.text) conversation.push({ role: "assistant", content: partial.text });
      closeDangling(conversation, isCancelled(err) ? "the turn was stopped before this tool ran" : "the turn failed before this tool ran");
      ctx.conversation = conversation;
      throw err;
    }
    return { conversation, call };
  }

  private async callOnce(
    provider: ResolvedProvider,
    call: StepContext["call"],
    emit: Emit,
    partial: { text: string },
    signal?: AbortSignal,
  ): Promise<{ message: Message; usage?: Record<string, number> }> {
    partial.text = "";
    const toolCalls: ToolCall[] = [];
    let failure: string | undefined;
    let usage: Record<string, number> | undefined;
    checkCancelled(signal);
    const onEvent = (e: ProviderEvent) => {
      if (e.type === "text") {
        partial.text += e.delta;
        emit({ type: "text", delta: e.delta });
      } else if (e.type === "tool_call") {
        toolCalls.push(e.call);
        emit({ type: "tool.call", call: e.call });
      } else if (e.type === "usage") {
        usage = e.usage;
        emit({ type: "usage", usage: e.usage });
      } else if (e.type === "error") failure = e.message;
    };
    await this.providers.call(provider, call, onEvent, signal);
    if (failure) throw new CodedError(`provider error: ${failure}`, "provider");
    const msg: Message = { role: "assistant", content: partial.text };
    partial.text = "";
    if (toolCalls.length) msg.toolCalls = toolCalls;
    return { message: msg, usage };
  }

  private async runTool(us: Userspace, ctx: StepContext, tools: ToolSpec[], tc: ToolCall, emit: Emit, signal?: AbortSignal): Promise<Message> {
    const spec = tools.find((t) => t.name === tc.name);
    let result: string;
    try {
      if (!spec) throw new CodedError(`unknown tool: ${tc.name}`, "tool");
      const config = this.config.packages[spec.package] ?? {};
      const payload = { package: spec.package, export: spec.export, name: tc.name, args: tc.args, session: ctx.session, config };
      const raw = await this.fences.request(us, "tool", payload, undefined, signal);
      result = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
    } catch (err) {
      if (isCancelled(err)) throw err;
      result = `error: ${errorMessage(err)}`;
    }
    emit({ type: "tool.result", id: tc.id, name: tc.name, result });
    return { role: "tool", content: result, toolCallId: tc.id, name: tc.name };
  }
}

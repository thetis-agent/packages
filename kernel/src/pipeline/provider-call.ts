import type { KernelConfig } from "../config.js";
import type { FencePool } from "../fence/pool.js";
import type { ProviderRegistry } from "../providers.js";
import type { Message, ProviderEvent, StepContext, StepResult, ToolCall, ToolSpec, TurnEvent, Userspace } from "../types.js";
import { KernelError } from "../util.js";

export type Emit = (event: TurnEvent) => void;

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

  async run(us: Userspace, ctx: StepContext, emit: Emit): Promise<StepResult> {
    const conversation = [...ctx.conversation];
    const call = { ...ctx.call, messages: ctx.call.messages.length ? [...ctx.call.messages] : [...conversation] };
    const provider = await this.providers.resolve(us, call.model);
    for (let round = 0; round <= this.config.maxToolRounds; round++) {
      const assistant = await this.callOnce(provider, call, emit);
      conversation.push(assistant);
      call.messages.push(assistant);
      emit({ type: "message", message: assistant });
      if (!assistant.toolCalls?.length) break;
      for (const tc of assistant.toolCalls) {
        const result = await this.runTool(us, ctx, call.tools, tc, emit);
        conversation.push(result);
        call.messages.push(result);
      }
    }
    return { conversation, call };
  }

  private async callOnce(provider: Awaited<ReturnType<ProviderRegistry["resolve"]>>, call: StepContext["call"], emit: Emit): Promise<Message> {
    let text = "";
    const toolCalls: ToolCall[] = [];
    let failure: string | undefined;
    await this.providers.call(provider, call, (e: ProviderEvent) => {
      if (e.type === "text") (text += e.delta), emit({ type: "text", delta: e.delta });
      else if (e.type === "tool_call") toolCalls.push(e.call), emit({ type: "tool.call", call: e.call });
      else if (e.type === "usage") emit({ type: "usage", usage: e.usage });
      else if (e.type === "error") failure = e.message;
    });
    if (failure) throw new KernelError(`provider error: ${failure}`, "provider");
    const msg: Message = { role: "assistant", content: text };
    if (toolCalls.length) msg.toolCalls = toolCalls;
    return msg;
  }

  private async runTool(us: Userspace, ctx: StepContext, tools: ToolSpec[], tc: ToolCall, emit: Emit): Promise<Message> {
    const spec = tools.find((t) => t.name === tc.name);
    let result: string;
    try {
      if (!spec) throw new KernelError(`unknown tool: ${tc.name}`, "tool");
      const payload = { package: spec.package, export: spec.export, name: tc.name, args: tc.args, session: ctx.session, config: this.config.packages[spec.package] ?? {} };
      const raw = await this.fences.request(us, "tool", payload);
      result = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
    } catch (err) {
      result = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    emit({ type: "tool.result", id: tc.id, name: tc.name, result });
    return { role: "tool", content: result, toolCallId: tc.id, name: tc.name };
  }
}

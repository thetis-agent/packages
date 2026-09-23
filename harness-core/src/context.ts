import { contentText } from "@thetis/runtime/lib/content";
// Context snapshots live in the person's home beside the gateway's own UI records. Only the latest
// request is kept; the small usage ledger survives reopening the page, failures and interrupted turns.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PackageStepContext, ProviderCall } from "@thetis/runtime/contracts";
import { parseSchema } from "@thetis/runtime/lib/validation";
import { SnapshotSchema, summarizeRequest, type LastCall, type Snapshot, type UsageTurn } from "./schemas.js";

export class ContextRecorder {
  private pending = Promise.resolve();
  private readonly entry: UsageTurn;

  private constructor(private readonly ctx: PackageStepContext, private readonly file: string, private readonly snapshot: Snapshot) {
    this.entry = { id: ctx.turn.id, firstMessage: Math.max(0, ctx.conversation.length - ctx.turn.input.length), at: new Date().toISOString(), calls: 0, status: "running", usage: {} };
    snapshot.usage.push(this.entry);
  }

  static async open(ctx: PackageStepContext): Promise<ContextRecorder> {
    // Session ids are kernel-issued. Check at the filesystem boundary as well.
    if (!/^[a-zA-Z0-9_-]+$/.test(ctx.session.id)) throw new Error("invalid context session id");
    const file = resolve(ctx.env.cwd, "harness-core/context", `${ctx.session.id}.json`);
    let snapshot: Snapshot = { usage: [] };
    try {
      snapshot = parseSchema(SnapshotSchema, JSON.parse(await readFile(file, "utf8")), "harness context snapshot");
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) console.warn("Could not read previous context:", err);
    }
    return new ContextRecorder(ctx, file, snapshot);
  }

  get lastCall(): LastCall | undefined { return this.snapshot.lastCall; }

  async start(call: ProviderCall): Promise<void> {
    const system = [call.system ?? "", ...call.messages.filter((message) => message.role === "system").map((message) => contentText(message.content))].filter(Boolean).join("\n\n");
    this.snapshot.lastCall = {
      model: call.model, system, systemChars: system.length, tools: call.tools.map((t) => t.name),
      messages: call.messages.length, at: new Date().toISOString(), turn: this.ctx.turn.id,
      format: "provider-call", request: { ...structuredClone(call) },
    };
    this.entry.calls++;
    await this.save();
  }

  request(body: Record<string, unknown>, at: string): void {
    const previous = this.snapshot.lastCall!;
    const summary = summarizeRequest(body);
    this.snapshot.lastCall = {
      ...previous, ...summary, model: summary.model ?? previous.model, systemChars: summary.system.length,
      at, format: "wire", request: body,
    };
    void this.save();
  }

  usage(usage: Record<string, number>): void {
    for (const [key, value] of Object.entries(usage)) {
      if (Number.isFinite(value) && !key.endsWith("_ratio")) this.entry.usage[key] = (this.entry.usage[key] ?? 0) + value;
    }
    if (this.snapshot.lastCall) this.snapshot.lastCall.usage = { ...usage };
    void this.save();
  }

  async finish(status: UsageTurn["status"]): Promise<void> {
    this.entry.status = status;
    await this.save();
  }

  private save(): Promise<void> {
    const data = JSON.stringify(this.snapshot);
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, this.file);
      this.ctx.emit({ type: "context.updated" });
    }).catch((err) => {
      // Diagnostics must never interrupt the person's work. A failed capture leaves the previous atomic
      // snapshot readable, and the after-step still records the small summary in the session itself.
      console.warn("Could not save context:", err);
    });
    return this.pending;
  }
}

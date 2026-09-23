import { z } from "zod";

export const LastCallSchema = z.looseObject({
  model: z.string(),
  system: z.string(),
  systemChars: z.number().int().nonnegative(),
  tools: z.array(z.string()),
  messages: z.number().int().nonnegative(),
  at: z.string(),
  turn: z.string().optional(),
  format: z.enum(["wire", "provider-call"]).optional(),
  request: z.record(z.string(), z.unknown()).optional(),
  usage: z.record(z.string(), z.number()).optional(),
});
export type LastCall = z.infer<typeof LastCallSchema>;

const UsageTurnSchema = z.looseObject({
  id: z.string(),
  firstMessage: z.number().int().nonnegative(),
  at: z.string(),
  calls: z.number().int().nonnegative(),
  status: z.enum(["running", "complete", "failed", "cancelled"]),
  usage: z.record(z.string(), z.number()),
});
export type UsageTurn = z.infer<typeof UsageTurnSchema>;

export const SnapshotSchema = z.looseObject({ lastCall: LastCallSchema.optional(), usage: z.array(UsageTurnSchema) });
export type Snapshot = z.infer<typeof SnapshotSchema>;

const WireTextSchema = z.object({ text: z.string().catch("").default("") }).catch({ text: "" });
const WireMessageSchema = z.object({
  role: z.string().optional().catch(undefined),
  content: z.union([z.string(), z.array(WireTextSchema)]).optional().catch(undefined),
}).catch({});
const WireToolSchema = z.object({
  name: z.string().optional().catch(undefined),
  function: z.object({ name: z.string().optional().catch(undefined) }).optional().catch(undefined),
}).catch({});
const WireSummarySchema = z.object({
  model: z.string().optional().catch(undefined),
  messages: z.array(WireMessageSchema).catch([]).default([]),
  tools: z.array(WireToolSchema).catch([]).default([]),
});

/** Read only display fields; the complete provider-specific request is kept separately. */
export function summarizeRequest(body: Record<string, unknown>): { model?: string; system: string; messages: number; tools: string[] } {
  const summary = WireSummarySchema.parse(body);
  const system = summary.messages.filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text).filter(Boolean).join("\n")).join("\n\n");
  return { model: summary.model, system, messages: summary.messages.length, tools: summary.tools.map((tool) => tool.function?.name ?? tool.name ?? "?") };
}

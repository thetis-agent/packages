// Small HTTP helpers shared by the route modules.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { parseSchema } from "@thetis/runtime/lib/validation";

const JsonBodySchema = z.record(z.string(), z.unknown());

export const BODY_LIMIT = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * The body as it arrived, byte for byte. `readBody` decodes to UTF-8, which is right for JSON and ruinous
 * for anything else: an uploaded image would come back as replacement characters and be corrupt before any
 * route saw it. The size is counted as the chunks arrive and the read is abandoned the moment it is over
 * `limit`, so a body nobody asked for is never held in memory whole. `what` names the thing in the refusal,
 * because the sentence is shown to the person who chose the file.
 */
export async function readBytes(req: IncomingMessage, limit = BODY_LIMIT, what = "the body"): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `${what} is larger than ${Math.round(limit / 1024)} KB.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBytes(req)).toString("utf8");
}

export function readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
export function readJson<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.output<S>>;
export async function readJson(req: IncomingMessage, schema: z.ZodType = JsonBodySchema): Promise<unknown> {
  const text = await readBody(req);
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  try {
    return parseSchema(schema, value, "invalid JSON body");
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "invalid JSON body");
  }
}

/** A string field of a JSON body, trimmed; a missing one is an error naming the field. */
export function field(body: Record<string, unknown>, name: string, opts: { optional?: boolean; pattern?: RegExp } = {}): string {
  const raw = body[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    if (opts.optional) return "";
    throw new HttpError(400, `${name} is required`);
  }
  if (opts.pattern && !opts.pattern.test(value)) throw new HttpError(400, `${name} is not valid`);
  return value;
}

// Small HTTP helpers shared by the route modules.
import type { IncomingMessage, ServerResponse } from "node:http";

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

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
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

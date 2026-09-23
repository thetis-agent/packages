import type { z } from "zod";
import { parseSchema } from "@thetis/runtime/lib/validation";

export function parseJson<S extends z.ZodType>(schema: S, text: string, context: string): z.output<S> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (cause) { throw new Error(`${context}: invalid JSON`, { cause }); }
  return parseSchema(schema, value, context);
}

export function parseJsonLines<S extends z.ZodType>(schema: S, text: string, context: string): z.output<S>[] {
  return text.split("\n").flatMap((line, index) => line.trim() ? [parseJson(schema, line, `${context} line ${index + 1}`)] : []);
}

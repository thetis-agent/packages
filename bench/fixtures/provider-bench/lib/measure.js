// What can be read off a ProviderCall without knowing anything about the mechanism that built it.
import { createHash } from "node:crypto";

export const bytes = (s) => (s ? Buffer.byteLength(s, "utf8") : 0);
export const sha = (s) => createHash("sha256").update(s ?? "").digest("hex").slice(0, 16);

/** Tool schemas as the provider would serialise them: the shape the model is actually charged for. */
export function toolsText(tools) {
  return JSON.stringify((tools ?? []).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
}

/**
 * A tool's stable name for a gold set: the package that owns it and the tool's own name. Gold written against
 * `read_path` alone would silently match a different package's tool of the same name; written against the
 * owner too, a move or a rename breaks loudly instead.
 */
export function toolId(tool) {
  const owner = String(tool.package ?? "").split("/").pop() || "unknown";
  return `${owner}/${tool.name}`;
}

/** What each tool costs on its own, so waste can be charged to the tools that caused it. */
export function toolBytes(tools) {
  const out = {};
  for (const tool of tools ?? []) {
    out[toolId(tool)] = bytes(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  }
  return out;
}

export function messagesText(messages) {
  return JSON.stringify((messages ?? []).map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls })));
}

/** How many leading bytes two strings share. Under prompt caching this, not the total, is what is free. */
export function commonPrefix(a, b) {
  if (!a || !b) return 0;
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return Buffer.byteLength(a.slice(0, i), "utf8");
}

/**
 * Which capabilities actually reached the prompt, found by their canary tokens rather than by asking the
 * package. A mechanism may reformat a body however it likes; the canary is the part it must keep.
 */
export function canariesIn(text, canaries) {
  const found = [];
  if (!text) return found;
  for (const [id, token] of Object.entries(canaries ?? {})) if (token && text.includes(token)) found.push(id);
  return found.sort();
}

/**
 * Which capability ids are named anywhere in the prompt or the tool schemas. A body carries a canary; a
 * catalogue entry or a tool enum carries only the id. Mentioned-but-no-canary is what `offered` looks like
 * from outside, and it is checkable without knowing the mechanism.
 */
export function idsIn(text, ids) {
  const found = [];
  if (!text) return found;
  for (const id of ids) if (id && text.includes(id)) found.push(id);
  return found.sort();
}

/** The non-ASCII share of a string: a tripwire for an arm whose bytes buy unusually many tokens. */
export function nonAsciiRatio(text) {
  const total = bytes(text);
  if (!total) return 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.round(((total - ascii) / total) * 1000) / 1000;
}

/** `bench/<run>/<arm>/<task>/<attempt>` — the addressing the bench puts in `call.model`, out of the query. */
export function parseAddress(model) {
  const parts = String(model ?? "").split("/");
  if (parts[0] !== "bench" || parts.length < 5) return null;
  return { run: parts[1], arm: parts[2], task: parts[3], attempt: Number(parts[4]) || 0 };
}

export function measure(call, canaries, previousSystem) {
  const system = call.system ?? "";
  const tools = toolsText(call.tools);
  const messages = messagesText(call.messages);
  const ids = Object.keys(canaries ?? {});
  const prefix = `${system}\n${tools}`;
  return {
    bytes: {
      system: bytes(system),
      tools: bytes(tools),
      messages: bytes(messages),
      hints: bytes(JSON.stringify(call.hints ?? null)),
      total: bytes(system) + bytes(tools) + bytes(messages),
    },
    sha: { system: sha(system), tools: sha(tools), prefix: sha(prefix) },
    prefixBytes: previousSystem === undefined ? bytes(prefix) : commonPrefix(previousSystem, prefix),
    prefixText: prefix,
    toolNames: (call.tools ?? []).map((t) => t.name).sort(),
    toolIds: (call.tools ?? []).map(toolId).sort(),
    toolBytes: toolBytes(call.tools),
    canaryDirect: canariesIn(system, canaries),
    idsMentioned: idsIn(`${system}\n${tools}`, ids),
    // What a round trip actually produced. A mechanism that keeps its corpus behind a search tool can only
    // show it is reachable by returning it; saying so in a claim is not the same thing.
    idsReturned: idsIn(messages, ids),
    canaryReturned: canariesIn(messages, canaries),
    nonAsciiRatio: nonAsciiRatio(system),
    hintKeys: Object.keys(call.hints ?? {}).sort(),
  };
}

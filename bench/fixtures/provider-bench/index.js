// The measuring provider. It never reaches the network. It reads the fully assembled call — the only place
// where system, tools, messages and hints are all final — records what it sees, and answers from a script.
//
// Two channels carry the measurements out: every number rides the `usage` event the kernel already forwards,
// and the detail is appended to an NDJSON file the host runner reads. Neither needs a kernel change.
import { appendFileSync, readFileSync } from "node:fs";
import { measure, parseAddress } from "./lib/measure.js";
import { replyFor } from "./lib/script.js";

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

/**
 * With `upstream` set, this provider stops answering and starts forwarding: a real provider does the talking
 * and this one only measures. That keeps one place where the assembled call is recorded whether or not a
 * model is in the loop, instead of two implementations that could drift apart.
 */
async function upstreamOf(config) {
  if (!config.upstream) return null;
  const module = await import(config.upstream.package);
  const factory = module[config.upstream.export ?? "createProvider"];
  if (typeof factory !== "function") throw new Error(`${config.upstream.package} has no provider factory`);
  return factory(config.upstream.config ?? {});
}

export function createProvider(config) {
  const script = config.script ? readJson(config.script, {}) : config.inlineScript ?? {};
  const canaries = config.canaries ?? {};
  const ceiling = Number(config.maxCostUsd) || 0;
  const spent = { usd: 0 };
  let upstream;
  // The agent caches one provider instance per (package, config), so this map lives for the whole run.
  // That is what makes prefix stability measurable without any external state.
  const rounds = new Map();
  const lastPrefix = new Map();

  return {
    async models() {
      return [{ id: "*" }];
    },
    /** What has been spent so far, for a runner that wants to stop between tasks rather than mid-turn. */
    spent() {
      return spent.usd;
    },
    async *call(call, signal, context) {
      const at = parseAddress(call.model) ?? { run: "adhoc", arm: "adhoc", task: "adhoc", attempt: 0 };
      const key = `${at.run}/${at.arm}/${at.task}/${at.attempt}`;
      const round = rounds.get(key) ?? 0;
      rounds.set(key, round + 1);

      const seen = measure(call, canaries, lastPrefix.get(key));
      lastPrefix.set(key, seen.prefixText);
      const { prefixText, ...record } = seen;

      if (config.capture) {
        appendFileSync(config.capture, `${JSON.stringify({ ...at, model: call.model, round, at: Date.now(), ...record })}\n`);
      }

      yield {
        type: "usage",
        usage: {
          bench_round: round,
          bench_bytes_system: record.bytes.system,
          bench_bytes_tools: record.bytes.tools,
          bench_bytes_messages: record.bytes.messages,
          bench_bytes_total: record.bytes.total,
          bench_tools_n: record.toolNames.length,
          bench_direct_n: record.canaryDirect.length,
          bench_prefix_bytes: record.prefixBytes,
        },
      };

      if (config.upstream) {
        // The ceiling is enforced here rather than by the runner, because here is where the money is spent and
        // a turn already in flight cannot be called back.
        if (ceiling && spent.usd >= ceiling) {
          yield { type: "error", message: `bench cost ceiling reached: $${spent.usd.toFixed(4)} of $${ceiling.toFixed(2)}` };
          return;
        }
        upstream ??= await upstreamOf(config);
        // The address rode in `call.model` so the query text could stay untouched. The real provider needs a
        // real model id, so it is put back here, at the only boundary that knows about both.
        const forwarded = { ...call, model: config.upstream.model };
        for await (const event of upstream.call(forwarded, signal, context)) {
          if (event.type === "usage" && Number.isFinite(event.usage?.cost)) spent.usd += event.usage.cost;
          yield event;
        }
        // No second capture line: the measurement was written above, and the spend is already in the usage
        // events the real provider emitted, which the runner sums.
        return;
      }

      const reply = replyFor(script, at.task, round, call);
      if (reply.latencyMs) await new Promise((r) => setTimeout(r, reply.latencyMs));
      if (reply.toolCall) {
        yield { type: "tool_call", call: { id: `bc-${round}`, name: reply.toolCall.name, args: reply.toolCall.args ?? {} } };
        return;
      }
      yield { type: "text", delta: reply.text ?? "done" };
    },
  };
}

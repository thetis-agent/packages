// The harness writes an atomic snapshot before each call and as usage arrives. Inspect the session
// first to authorize it, then read that person's snapshot. Older sessions retain their saved summary
// and the usage already recorded by the web gateway.

/** The key `@thetis/harness-core` keeps its per-session state under. */
const HARNESS = "@thetis/harness-core";

export async function uiContext(_args, env) {
  if (!env.session) throw new Error("no conversation is open");
  const record = await env.kernel.sessions.inspect(env.session);
  if (!/^[a-zA-Z0-9_-]+$/.test(env.session)) throw new Error("invalid context session id");
  const snapshot = await readJson(env, `harness-core/context/${env.session}.json`);
  const legacy = lastCallOf(record.harness);
  const captured = isRecord(snapshot?.lastCall) ? snapshot.lastCall : null;
  const lastCall = captured && (!legacy || Date.parse(captured.at) >= Date.parse(legacy.at)) ? captured : legacy;
  const status = record.status ?? "idle";
  const usage = (Array.isArray(snapshot?.usage) ? snapshot.usage : []).filter(isRecord).map((entry) => ({
    ...entry,
    status: entry.status === "running" && !(status === "running" && entry.id === record.turn?.id) ? "interrupted" : entry.status,
  }));
  const gateway = await readJson(env, `gateway-web/sessions/${env.user}/${env.session}.json`);
  const before = usage.length ? Math.min(...usage.map((entry) => entry.firstMessage ?? 0)) : Infinity;
  const historical = historicalUsage(record.conversation ?? [], gateway?.usage, before);
  return { data: {
    turns: record.turns, status,
    started: status === "running" || record.turns > 0 || Boolean(record.conversation?.length),
    lastCall, usage: [...historical, ...usage],
  } };
}

async function readJson(env, path) {
  try { return JSON.parse(await env.readFile(path)); }
  catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

function historicalUsage(conversation, usage, before) {
  const turns = [];
  let turn;
  for (let i = 0; i < Math.min(conversation.length, before); i++) {
    if (conversation[i].role === "user") {
      turn = { id: `history-${i}`, firstMessage: i, status: "complete", calls: 0, usage: {} };
      turns.push(turn);
    }
    const reported = usage?.[i];
    if (!turn || !isRecord(reported)) continue;
    turn.calls++;
    for (const [key, value] of Object.entries(reported)) {
      if (typeof value === "number" && Number.isFinite(value) && !key.endsWith("_ratio")) turn.usage[key] = (turn.usage[key] ?? 0) + value;
    }
  }
  return turns.filter((turn) => turn.calls);
}

function lastCallOf(harness) {
  const own = isRecord(harness) ? harness[HARNESS] : null;
  const lastCall = isRecord(own) ? own.lastCall : null;
  return isRecord(lastCall) ? lastCall : null;
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

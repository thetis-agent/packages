/** Prove a browser that loses its connection comes back to the whole conversation; ADR 0019, KS-004.
 *
 * `wire.ts` has advertised `cursor-replay` since the lifted wire landed, and nothing exercised it end
 * to end: a reconnect re-opened every tab from scratch and whatever ran while the socket was down was
 * gone. This walks the real thing — a real provider service, a real person environment, a real
 * gateway process and a real WebSocket — through the three cases that matter:
 *
 *   - the socket is pulled out from under a turn that is still streaming, and the reconnection picks
 *     up mid-reply. The reply text from before the cut and after it is concatenated and compared
 *     against what the provider was scripted to say, which is the one assertion that catches both a
 *     lost event and a replayed one drawn twice;
 *   - a whole turn runs with nobody connected at all (submitted straight through the environment, the
 *     way inherited kernel control submits one), and the reconnection gets all of it;
 *   - a position the environment cannot reach is refused, and the gateway falls back to a plain
 *     subscription carrying the saved transcript, marked so the surface can say so once.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serviceFixture } from '@/test/provider-service.ts';
import { environmentProcess } from '@/test/environment-process.ts';
import { gatewayProcess } from '@/test/gateway-process.ts';
import { webClient } from '@/test/web-client.ts';

const first = 'FIRST_TURN ';
const second = 'SECOND_TURN ';
const words = 120;

type Client = Awaited<ReturnType<typeof webClient>>;
/** What app.js keeps as frames arrive: the reply so far, the furthest position drawn, and enough
 *  bookkeeping for a step to assert that a replay actually delivered something. */
type Seen = { at: number | undefined; text: string; cursors: number[]; deltas: number };
function watching(): Seen { return { at: undefined, text: '', cursors: [], deltas: 0 }; }

/** Reads frames until `stop` says the interesting one has arrived, collecting reply text and the
 *  furthest position drawn — exactly the two things app.js keeps per conversation. */
async function readUntil(client: Client, stop: (frame: Record<string, unknown>) => boolean, seen: Seen): Promise<Record<string, unknown>> {
  for (let count = 0; count < 512; count++) {
    const frame = await client.next();
    assert.notEqual(frame['type'], 'error', JSON.stringify(frame));
    if (frame['kind'] === 'delta') { seen.text += String(frame['text']); seen.deltas += 1; }
    const cursor = frame['cursor'];
    if (typeof cursor === 'number') { seen.cursors.push(cursor); seen.at = seen.at === undefined || cursor > seen.at ? cursor : seen.at; }
    if (stop(frame)) return frame;
  }
  throw new Error('The gateway never sent the frame this step was waiting for.');
}

/** Opens a fresh conversation and leaves a turn visibly streaming, then pulls the socket out from
 *  under it. The turn goes on running in the environment, which is the situation the whole capability
 *  exists for. Returns the conversation, with `seen` carrying what the surface had drawn. */
async function cutMidReply(socket: string, cookie: string, seen: Seen): Promise<string> {
  const opening = await webClient(socket, { cookie });
  try {
    await opening.send({ type: 'new' });
    const opened = await readUntil(opening, frame => frame['type'] === 'opened', seen);
    assert.equal(typeof opened['session'], 'string');
    assert.equal(opened['cursor'], 0, 'a conversation with no events yet is at the beginning');
    await opening.send({ type: 'send', id: opened['session'], text: 'Say the first thing.' });
    await readUntil(opening, frame => frame['kind'] === 'delta', seen);
    assert.ok(seen.text.length > 0);
    return String(opened['session']);
  } finally { opening.close(); }
}

await test('a connection dropped mid-reply resumes where it left off, drawing nothing twice', async () => {
  const shared = await serviceFixture(1, { scripts: [Array.from({ length: words }, () => ({ type: 'delta.text', text: first }))] });
  assert.ok((await shared.process.probe()).ok);
  const environment = await environmentProcess(shared, 'alice', true); assert.ok((await environment.process.probe()).ok);
  const gateway = await gatewayProcess(shared, environment, 'alice', 'gateway-web'); assert.ok((await gateway.process.probe()).ok);
  const cookie = `thetis_session=${shared.mintSession('alice')}`;
  const seen = watching();
  try {
    const id = await cutMidReply(gateway.socket, cookie, seen);
    const cut = seen.at; assert.ok(typeof cut === 'number');
    const resumed = await webClient(gateway.socket, { cookie });
    try {
      await resumed.send({ type: 'open', id, from: cut });
      const opened = await readUntil(resumed, frame => frame['type'] === 'opened', seen);
      assert.equal(opened['gap'], undefined, 'a position still inside the window must be honoured, not fallen back from');
      assert.equal(opened['history'], undefined, 'a resumed subscription must not resend the saved transcript over the rows already on screen');
      const before = seen.cursors.length; const drawn = seen.deltas;
      await readUntil(resumed, frame => frame['kind'] === 'turn-finished', seen);
      assert.ok(seen.cursors.slice(before).every(cursor => cursor > cut), 'every replayed frame must come after the position the surface asked to continue from');
      assert.ok(seen.deltas > drawn, 'the cut has to land mid-reply for this to be testing anything');
      assert.equal(seen.text, first.repeat(words), 'the reply either side of the cut must join up with nothing lost and nothing drawn twice');
    } finally { resumed.close(); }
  } finally { await gateway.close(); await environment.close(); await shared.close(); }
});

await test('a turn that ran with nobody connected arrives whole, and an unreachable position falls back to the saved transcript', async () => {
  const shared = await serviceFixture(1, { scripts: [
    Array.from({ length: words }, () => ({ type: 'delta.text', text: first })),
    Array.from({ length: words }, () => ({ type: 'delta.text', text: second }))
  ] }); assert.ok((await shared.process.probe()).ok);
  const environment = await environmentProcess(shared, 'alice', true); assert.ok((await environment.process.probe()).ok);
  const gateway = await gatewayProcess(shared, environment, 'alice', 'gateway-web'); assert.ok((await gateway.process.probe()).ok);
  const cookie = `thetis_session=${shared.mintSession('alice')}`;
  const seen = watching();
  try {
    const id = await cutMidReply(gateway.socket, cookie, seen);
    const settling = await webClient(gateway.socket, { cookie });
    try { await settling.send({ type: 'open', id, from: seen.at }); await readUntil(settling, frame => frame['kind'] === 'turn-finished', seen); }
    finally { settling.close(); }

    // Submitted straight through the environment, the way inherited kernel control submits one:
    // nothing is listening on the wire at all while this turn runs.
    const away = seen.at; assert.ok(typeof away === 'number');
    const submitted = await environment.process.invoke('session.submit', { conversation: id, input: { text: 'Say the second thing.', attachments: [] } });
    assert.ok(submitted.ok, JSON.stringify(submitted));
    seen.text = '';
    const late = await webClient(gateway.socket, { cookie });
    try {
      await late.send({ type: 'open', id, from: away });
      await readUntil(late, frame => frame['type'] === 'opened', seen);
      const finished = await readUntil(late, frame => frame['kind'] === 'turn-finished', seen);
      assert.equal(finished['stopped_by'], 'answer');
      assert.equal(seen.text, second.repeat(words), 'a turn that ran while the surface was away must arrive whole when it comes back');
    } finally { late.close(); }

    const stale = await webClient(gateway.socket, { cookie });
    try {
      await stale.send({ type: 'open', id, from: 10000000 });
      const opened = await readUntil(stale, frame => frame['type'] === 'opened', seen);
      assert.equal(opened['gap'], true, 'a refused resume must fall back rather than leaving the conversation stopped');
      assert.ok(opened['history'], 'the fallback has to carry the saved transcript, because there is nothing to replay onto');
      assert.equal(typeof opened['cursor'], 'number');
      assert.ok(JSON.stringify(opened['history']).includes(second.trim()));
    } finally { stale.close(); }
  } finally { await gateway.close(); await environment.close(); await shared.close(); }
});

/** The per-turn ledger reads `model.end`, which only reaches this wire because `lib/session/index.ts`
 *  admits it. That the frame arrives at all, carrying the provider's own counters rather than an
 *  estimate, is the premise the whole usage chip rests on. */
await test('a finished turn reports the provider counters the usage chip is built from', async () => {
  const shared = await serviceFixture(1, { scripts: [[{ type: 'delta.text', text: 'Counted.' }]] }); assert.ok((await shared.process.probe()).ok);
  const environment = await environmentProcess(shared, 'alice', true); assert.ok((await environment.process.probe()).ok);
  const gateway = await gatewayProcess(shared, environment, 'alice', 'gateway-web'); assert.ok((await gateway.process.probe()).ok);
  const cookie = `thetis_session=${shared.mintSession('alice')}`;
  const client = await webClient(gateway.socket, { cookie });
  try {
    const seen = watching();
    await client.send({ type: 'new' });
    const opened = await readUntil(client, frame => frame['type'] === 'opened', seen);
    const id = String(opened['session']);
    await client.send({ type: 'send', id, text: 'Count something.' });
    const ended = await readUntil(client, frame => frame['kind'] === 'model-end', seen);
    const usage: unknown = ended['usage'];
    assert.ok(usage !== null && typeof usage === 'object');
    const counters = usage as Record<string, unknown>;
    assert.equal(typeof counters['in'], 'number'); assert.equal(typeof counters['out'], 'number'); assert.equal(typeof counters['cost'], 'number');
    assert.equal(ended['stop'], 'end');
    const finished = await readUntil(client, frame => frame['kind'] === 'turn-finished', seen);
    assert.equal(typeof finished['iterations'], 'number'); assert.equal(typeof finished['compactions'], 'number');
  } finally { client.close(); await gateway.close(); await environment.close(); await shared.close(); }
});

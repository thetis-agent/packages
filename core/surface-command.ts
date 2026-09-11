/** Answer one declared surface command from the package that declared it; ADR 0051.
 *
 * A contributed panel may send only what its own package named in its `surface` block, and the web
 * gateway is what checks that list (gateway-web/surface-request.ts) — this file is the other end of
 * the route, where the named package actually answers. Nothing new was invented for it to answer
 * with: a package that contributes a panel already has a `call` hook shape it understands, so the
 * request becomes the `callRequest` a tool call would have been and the reply is the `callAnswer`
 * one returns. That keeps a contributor's answering code one function rather than a second protocol.
 *
 * Two things are checked here regardless of what the gateway checked. The conversation must be the
 * one this connection is already subscribed to, which is free: the connection carries exactly one
 * subscription (control.ts), so the route is the binding rather than a list to consult. And the
 * named package must actually be mounted here with a hook to run, because a person's environment is
 * not obliged to hold every package whose panel the gateway happened to serve.
 *
 * What is deliberately not checked here is the declared verb list; ADR 0051 §Consequences records
 * why, and that it is a single point of enforcement rather than two.
 */
import { randomUUID } from 'node:crypto';
import type { Handler } from '@/lib/socket/index.ts';
import type { Stage } from '@/lib/events/stages.ts';
import { frozen } from '@/lib/events/stages.ts';
import type { CallAnswer } from '@/contracts/turn-events/types.ts';
import { SpillSink } from '@/lib/spill/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Schemas } from '@/lib/schema/index.ts';
import type { Clock } from '@/lib/events/index.ts';

/** Far below a tool call's own budget: a panel command answers a person who is waiting for it. */
export const commandLimits = { deadlineMs: 20000, resultBytes: 262144 };

/** `opened` reads the conversation this connection subscribed to, which is `undefined` until it has. */
export function surfaceCommand(stages: readonly Stage[], schemas: Schemas, clock: Clock, space: string, opened: () => string | undefined): Handler {
  const valid = schemas.validator<CallAnswer>('turn-events', 'callAnswer');
  return async params => {
    const conversation = params['conversation']; const name = params['package']; const verb = params['verb']; const args = params['args'];
    if (typeof conversation !== 'string' || typeof name !== 'string' || typeof verb !== 'string' || !isObject(args)) return failure('invalid-args', 'That panel sent something this environment cannot read.');
    if (conversation !== opened()) return failure('forbidden', 'That panel is not showing this conversation.');
    const stage = stages.find(item => (item.source.split('@')[0] ?? item.source) === name);
    if (!stage?.call) return failure('not-found', 'That panel is not allowed to do this.');
    const id = randomUUID(); const controller = new AbortController();
    const request = { id, name: verb, args, mode: { readOnly: false, deny: [] }, roots: [], deadlineMs: commandLimits.deadlineMs, budget: { resultBytes: commandLimits.resultBytes } };
    // The sink exists because the hook signature has one, not because a panel command streams: a
    // package that writes to it gets an artifact in the person's own space exactly as a tool would,
    // and one that ignores it — which every panel command should — costs nothing to abandon.
    const sink = new SpillSink(space, id);
    try {
      const answer: unknown = await Promise.race([
        stage.call(frozen(request), sink, controller.signal),
        clock.wait(commandLimits.deadlineMs, controller.signal).then(() => undefined)
      ]);
      if (!valid(answer) || answer.id !== id) return failure('protocol', 'That did not finish. Nothing was changed.');
      return { ok: true, value: answer };
    } catch { return failure('io', 'That did not work. Nothing was changed.'); }
    finally { controller.abort(); await sink.abort(); }
  };
}

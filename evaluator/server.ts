/** Accept bounded evaluation requests while keeping private rows off the query surface; ADR 0014 §5. */
import type { Factory } from '../../lib/service/index.ts';
import { failure } from '../../lib/result/index.ts';
import { socketFrames, send } from '../../lib/ndjson/socket.ts';
import schema from '../../contracts/evaluator/schema.json' with { type: 'json' };
import type { Startup, Request } from '../../lib/evaluation/types.ts';
import { calculate } from '../../lib/evaluation/index.ts';
import { Evaluator } from './run.ts';
import { delegated } from './execution.ts';

export const handler: Factory = (settings, schemas, peer) => {
  schemas.compile(schema);
  const startup = schemas.compile<Startup>({ $ref: `${schema.$id}#/$defs/startup` });
  const request = schemas.compile<Request>({ $ref: `${schema.$id}#/$defs/request` });
  const secret = process.env['EVALUATOR_SEED'];
  if (!secret) return Promise.resolve(failure('gap', 'evaluator 1.0.0 requires secret/evaluator.seed *. Nothing in this profile provides it.'));
  if (!startup(settings)) return Promise.resolve(failure('invalid-args', 'The evaluation settings do not match their schema.'));
  const evaluator = new Evaluator(); const execution = delegated(peer, settings, schemas);
  return Promise.resolve({ ok: true, value: async connection => {
    try {
      for await (const frame of socketFrames(connection.socket)) {
        if (!frame.ok) return frame;
        if (!request(frame.value) || frame.value.candidate !== settings.plan.identities.candidate) return await send(connection.socket, failure('invalid-args', 'The evaluation request does not match its authorized candidate.'));
        connection.admitted();
        const result = await evaluator.run({ plan: settings.plan, cases: settings.cases, coreChanged: settings.coreChanged, ...(settings.providerChanged !== undefined ? { providerChanged: settings.providerChanged } : {}), stoplist: new Set(settings.stoplist), secret, ...(settings.ablations !== undefined ? { ablations: settings.ablations } : {}), ...(settings.previousDefaultScorer ? { previousDefaultScorer: settings.previousDefaultScorer } : {}) }, execution);
        if (!result.ok) return await send(connection.socket, result);
        const stored = await peer.call('results.submit', result.value); if (!stored.ok) return await send(connection.socket, stored);
        const summary = await calculate(result.value, settings.plan); if (!summary.ok) return await send(connection.socket, summary);
        return await send(connection.socket, { ok: true, value: { candidate: settings.plan.identities.candidate, summary: summary.value.summary } });
      }
      return failure('io', 'The evaluation request ended before a frame arrived.');
    } catch { return failure('io', 'The evaluation connection failed.'); }
    finally { connection.socket.end(); }
  } });
};

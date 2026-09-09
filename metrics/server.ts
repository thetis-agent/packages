/** Query only kernel-authorized log scopes and expose aggregates without promotion authority; ADR 0017 §4. */
import type { Factory } from '../../lib/service/index.ts';
import { socketFrames, send } from '../../lib/ndjson/socket.ts';
import { failure } from '../../lib/result/index.ts';
import { calculate } from '../../lib/evaluation/index.ts';
import evaluation from '../../contracts/evaluator/schema.json' with { type: 'json' };
import metrics from '../../contracts/metrics/schema.json' with { type: 'json' };
import type { Request } from '../../contracts/metrics/types.ts';

export const handler: Factory = (_settings, schemas, peer) => {
  schemas.compile(evaluation); const request = schemas.compile<Request>(metrics);
  return Promise.resolve({ ok: true, value: async connection => {
    try {
      for await (const frame of socketFrames(connection.socket)) {
        if (!frame.ok) return frame;
        if (!request(frame.value)) return await send(connection.socket, failure('invalid-args', 'The metrics request does not match its contract.'));
        connection.admitted();
        switch (frame.value.method) {
          case 'summary': {
            const computed = await calculate(frame.value.submission, frame.value.plan);
            return await send(connection.socket, computed.ok ? { ok: true, value: computed.value.summary } : computed);
          }
          case 'logs': return await send(connection.socket, await peer.call('env.logs', { target: frame.value.target, from: frame.value.from ?? 0, limit: frame.value.limit ?? 100 }));
        }
      }
      return failure('io', 'The metrics request ended before a frame arrived.');
    } catch { return failure('io', 'The metrics connection failed.'); }
    finally { connection.socket.end(); }
  } });
};

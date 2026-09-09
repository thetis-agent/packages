/** Delegate verified run and snapshot operations without granting namespace authority to evaluation code; ADR 0017. */
import type { Peer } from '../../lib/socket/index.ts';
import type { Schemas } from '../../lib/schema/index.ts';
import { failure } from '../../lib/result/index.ts';
import type { Result } from '../../lib/result/index.ts';
import schema from '../../contracts/evaluator/schema.json' with { type: 'json' };
import type { Startup, Outcome, ScoreOutcome } from '../../lib/evaluation/types.ts';
import type { Execution, TurnJob, CheckJob } from './run.ts';

export function delegated(peer: Peer, settings: Startup, schemas: Schemas): Execution {
  schemas.compile(schema);
  const outcome = schemas.compile<Outcome>({ $ref: `${schema.$id}#/$defs/outcome` });
  const scored = schemas.compile<ScoreOutcome>({ $ref: `${schema.$id}#/$defs/scoreOutcome` });
  return {
    async turn(job: TurnJob): Promise<Result<Outcome>> {
      if (!peer.supports('install.run')) return failure('unsupported', 'install.run was not negotiated.');
      const release = settings.releases[job.pins]; if (!release) return failure('not-found', 'The evaluation arm has no verified release.');
      const response = await peer.call('install', { ...release, operation: 'evaluation.run', ...job }, 600000);
      if (!response.ok) return response;
      return outcome(response.value) ? { ok: true, value: response.value } : failure('invalid-args', 'The evaluation run returned invalid observed rows.');
    },
    async score(job: CheckJob): Promise<Result<ScoreOutcome>> {
      if (!peer.supports('snapshot.score')) return failure('unsupported', 'snapshot.score was not negotiated.');
      const response = await peer.call('snapshot', { target: job.snapshot, operation: 'evaluation.score', ...job }, 10000);
      if (!response.ok) return response;
      return scored(response.value) ? { ok: true, value: response.value } : failure('invalid-args', 'The outcome check returned an invalid result.');
    },
    async release(snapshot: string): Promise<Result<void>> {
      const response = await peer.call('prune', { id: snapshot, operation: 'evaluation.release' });
      return response.ok ? { ok: true, value: undefined } : response;
    }
  };
}

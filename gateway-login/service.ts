/** Start the designated password authority only with inherited control; KS-006–007, ADR 0018 §2. */
import { serve } from '../../lib/service/index.ts';
import { clock } from '../../lib/events/index.ts';
import { PasswordAuthority } from './authority.ts';
import { connection } from './server.ts';

const result = await serve(async (_settings, schemas, peer) => {
  const authority = await PasswordAuthority.open('/state/accounts.json', schemas, clock, params => peer.call('identity.assert', params));
  return authority.ok ? { ok: true, value: connection(authority.value) } : authority;
}, result => { if (!result.ok) process.stderr.write(`${JSON.stringify(result)}\n`); }, ['identity.assert']);
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }

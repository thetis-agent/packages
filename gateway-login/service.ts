/** Start the designated password authority only with inherited control; KS-006–007, ADR 0018 §2, ADR 0038. */
import { fileURLToPath } from 'node:url';
import { serve } from '../../lib/service/index.ts';
import { clock } from '../../lib/events/index.ts';
import { load } from '../../lib/assets/index.ts';
import { PasswordAuthority } from './authority.ts';
import { connection } from './server.ts';

const assetsRoot = fileURLToPath(new URL('./assets', import.meta.url));
const manifestPath = fileURLToPath(new URL('./assets.json', import.meta.url));

const result = await serve(async (_settings, schemas, peer) => {
  const authority = await PasswordAuthority.open('/state/accounts.json', schemas, clock, params => peer.call('identity.assert', params));
  if (!authority.ok) return authority;
  const table = await load(assetsRoot, manifestPath, schemas);
  if (!table.ok) return table;
  return { ok: true, value: connection(authority.value, table.value) };
}, result => { if (!result.ok) process.stderr.write(`${JSON.stringify(result)}\n`); }, ['identity.assert']);
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }

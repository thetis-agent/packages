/** Keep the web gateway scoped by inherited identity and a direct environment mount; ADR 0009, ADR 0019. */
import { fileURLToPath } from 'node:url';
export const stages = {};
/* `attachmentBytes`/`attachments`/`attachmentTypes` bound what one person may attach to one message, and
 * they are here rather than beside the code that enforces them because four places have to agree about
 * them: http.ts refuses an oversized or wrong-typed upload, wire.ts refuses a message that names too many,
 * schema.json caps the inbound array, and the served composer states the numbers to the person before
 * either refusal can happen. `attachmentTypes` is an allow-list of whole mime types, never a prefix match:
 * `image/svg+xml` is an image that carries script, and a prefix match would admit it. Every entry must be
 * `image/<subtype>` with a subtype that is a safe file suffix, because the stored file is named
 * `<sha256>.<subtype>` and read back by that suffix alone — see attachments.ts. */
export const settings = { messageBytes: 1048576, pending: 8, streams: 8, turnMs: 600000, headerBytes: 16384, pendingIdentity: 8, openingFrames: 256,
  attachmentBytes: 8388608, attachments: 8, attachmentTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] };
export const spawn = [{ id: 'web', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: {}, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'person', network: 'none' }];

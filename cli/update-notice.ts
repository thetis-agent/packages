/** Print the update-status service's line only when it is granted and reports one; ADR 0048. */
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import { isObject } from '@/lib/schema/index.ts';

export const updateNoticePath = '/services/update-status/current.sock';
export const noticeLimits = { deadlineMs: 1000 };

function line(value: unknown): string | undefined {
  if (!isObject(value) || value['known'] !== true || value['verified'] !== true) return undefined;
  const available = value['available']; const checkedAt = value['checkedAt'];
  if (typeof available !== 'string' || typeof checkedAt !== 'number') return undefined;
  const time = new Date(checkedAt).toISOString().slice(11, 16);
  return `update: ${available} available (verified ${time})`;
}

/** Absence, refusal or an unknown status is silence, not an error: the granted service is optional. */
export async function updateNotice(path: string = updateNoticePath): Promise<string | undefined> {
  const connected = await connect(path); if (!connected.ok) return undefined;
  connected.value.setTimeout(noticeLimits.deadlineMs, () => { connected.value.destroy(); });
  try {
    const sent = await send(connected.value, { method: 'status' }); if (!sent.ok) return undefined;
    for await (const frame of socketFrames(connected.value)) {
      if (!frame.ok || !isObject(frame.value) || frame.value['ok'] !== true) return undefined;
      return line(frame.value['value']);
    }
    return undefined;
  } catch { return undefined; }
  finally { connected.value.end(); }
}

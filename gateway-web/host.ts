/** Report what the machine this gateway shares is doing, for the foot of the page; ADR 0019.
 *
 * Two figures, both the host's rather than this process's: a person glancing at the bar wants to
 * know whether the machine is busy, not whether the web gateway is. Memory is reported as
 * *available* against total rather than free against total, because free ignores reclaimable page
 * cache and reads alarmingly low on a perfectly healthy machine — available is the honest figure
 * for headroom, and the only place it can be had is /proc/meminfo's own MemAvailable line, which is
 * why this reads the file rather than asking the runtime. Where there is no procfs to read, the
 * runtime's figure for free memory stands in; it understates headroom, which is the safe direction
 * for a number nobody should act on without looking further.
 *
 * Load is the one-minute average against the cores actually schedulable here.
 *
 * Whatever cannot be answered is left out rather than sent as a zero. An omitted field hides its
 * item on the bar; a zero would draw an empty meter, which reads as a measurement.
 */
import { readFile } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';

/** Named per house rule; /proc/meminfo is a few kilobytes at most, and a bound costs nothing. */
export const hostLimits = { meminfoBytes: 65536 };

function kilobytes(meminfo: string, field: string): number {
  const found = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'mu').exec(meminfo);
  return found?.[1] === undefined ? 0 : Number(found[1]) * 1024;
}

async function memory(): Promise<{ total: number; available: number }> {
  const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '');
  const total = kilobytes(meminfo.slice(0, hostLimits.meminfoBytes), 'MemTotal');
  const available = kilobytes(meminfo.slice(0, hostLimits.meminfoBytes), 'MemAvailable');
  return total > 0 && available > 0 ? { total, available } : { total: totalmem(), available: freemem() };
}

export async function host(): Promise<Record<string, number>> {
  const value: Record<string, number> = {};
  const { total, available } = await memory();
  if (Number.isFinite(total) && total > 0 && Number.isFinite(available) && available > 0 && available <= total) {
    value['memTotal'] = total; value['memAvailable'] = available;
  }
  // A load average is a Unix construct; win32 answers [0, 0, 0], which would draw a perfectly idle
  // machine rather than an unmeasured one, so that platform reports no load at all.
  const load = loadavg()[0]; const cores = availableParallelism();
  if (process.platform !== 'win32' && typeof load === 'number' && Number.isFinite(load) && load >= 0 && cores > 0) {
    value['load1'] = Math.round(load * 100) / 100; value['cpus'] = cores;
  }
  return value;
}

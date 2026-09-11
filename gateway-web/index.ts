/** Keep the web gateway scoped by inherited identity and a direct environment mount; ADR 0009, ADR 0019. */
import { fileURLToPath } from 'node:url';
export const stages = {};
export const settings = { messageBytes: 1048576, pending: 8, streams: 8, turnMs: 600000, headerBytes: 16384, pendingIdentity: 8, openingFrames: 256 };
export const spawn = [{ id: 'web', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: {}, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'person', network: 'none' }];

/** What the surface calls itself, and the one colour it is drawn in.
 *
 * Whose name this is matters: Thetis is the runtime — the version in the status bar, the packages, the
 * generations — while the thing a person talks to is named by `agentName` and defaults to the same
 * word, so an unconfigured deployment still reads coherently. Only text about the agent is renamed. */
export interface Brand { agentName: string; accent: string }

/** The declared defaults, repeated from this package's manifest `settings` block.
 *
 * They are repeated rather than read because a spawned gateway is handed its target's profile, not the
 * materialized manifest settings: `lib/schema/settings.ts`'s `configured` fills declared defaults into
 * `entries[].settings`, and those only travel with an environment target. Keep the two in step — the
 * manifest is the declaration a deployment validates against, this is what runs when it says nothing. */
export const brandDefaults: Brand = { agentName: 'Thetis', accent: '#7c9cff' };

const accentPattern = /^#[0-9a-fA-F]{6}$/u;

function text(value: unknown, fallback: string, limit: number): string {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= limit ? value.trim() : fallback;
}

/** Read the branding out of the profile this process was spawned with, falling back on anything odd.
 *
 * Bad configuration must not cost a person their surface: a name of the wrong type or a colour that is
 * not a colour reverts to the default rather than refusing to start, because the deployment already
 * validated these against the manifest schema and anything reaching here past that is a surprise. */
export function brand(profile: unknown): Brand {
  const supplied = typeof profile === 'object' && profile !== null ? (profile as Record<string, unknown>)['settings'] : undefined;
  const values = typeof supplied === 'object' && supplied !== null ? supplied as Record<string, unknown> : {};
  const accent = values['accent'];
  return {
    agentName: text(values['agentName'], brandDefaults.agentName, 48),
    accent: typeof accent === 'string' && accentPattern.test(accent) ? accent : brandDefaults.accent,
  };
}

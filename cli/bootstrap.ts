/** Keep bootstrap process authority in the caller's generation driver; KS-009, GN-002. */
import { assembleDeployment, writeDeployment } from '../../lib/profile/orchestrate.ts';
import type { Services } from '../../lib/profile/orchestrate.ts';
import { writeProfile } from '../../lib/profile/bootstrap.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import type { Deployment } from '../../lib/deployment/types.ts';

export async function run(recipe: unknown, services: Services, schemas: Schemas, output: { deployment: string; profile: string }): Promise<Result<Deployment>> {
  const assembled = await assembleDeployment(recipe, services, schemas); if (!assembled.ok) return assembled;
  const pinned = await writeProfile(assembled.value.profile, output.profile); if (!pinned.ok) return pinned;
  const written = await writeDeployment(output.deployment, assembled.value.deployment);
  return written.ok ? { ok: true, value: assembled.value.deployment } : written;
}

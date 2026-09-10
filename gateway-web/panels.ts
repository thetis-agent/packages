/** Compose the panels packages contribute to this person's surface; contract/surface, ADR 0038 §1.
 *
 * Discovery is a readdir of the sibling packages this target's profile actually materialized, never a
 * list in code (AGENTS.md). It stays inside the person's own gateway: a contributed panel is served by
 * the target that already serves the surface, so no deployment-scope process reaches into a person's
 * sandbox and the boundary rule ADR 0038 declined to weaken is untouched.
 *
 * A contributor is any sibling whose manifest provides `panel/<id>` or `renderer/<kind>`. Its assets
 * are its own `assets.json`, loaded by the same bounded loader the surface uses for its own, and every
 * path it claims must sit under `/surface/<its package name>/` — the schema fixes the shape and the
 * check below ties the segment to the package, which is what stops one contributor serving over
 * another. A malformed contributor is refused by name rather than skipped: a panel that silently fails
 * to appear is worse than a gateway that says which package is wrong.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { load, merge } from '@/lib/assets/index.ts';
import type { Table } from '@/lib/assets/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Surface, Panel, Renderer } from '@/contracts/surface/types.ts';

export const limits = { packages: 256, manifestBytes: 65536 };

export interface Contribution { panels: Panel[]; renderers: Renderer[] }
export interface Composed { table: Table; contribution: Contribution }

/** The directory holding this package and its siblings, in whatever layout the profile mounted. */
export function siblingRoot(): string {
  return fileURLToPath(new URL('../', import.meta.url));
}

function contributes(manifest: Record<string, unknown>): boolean {
  const provides = manifest['provides'];
  return isObject(provides) && Object.keys(provides).some(name => name.startsWith('panel/') || name.startsWith('renderer/'));
}

/** Every served path a contributor claims must sit under its own name, so no two can collide. */
function owned(name: string, table: Table, surface: Surface): Result<void, 'invalid-args'> {
  const prefix = `/surface/${name}/`;
  for (const asset of table.assets) {
    if (!asset.path.startsWith(prefix)) return failure('invalid-args', `${name} serves ${asset.path}, which is outside ${prefix}.`);
  }
  const served = new Set(table.assets.map(asset => asset.path));
  for (const entry of [...surface.panels ?? [], ...surface.renderers ?? []]) {
    if (!entry.entry.startsWith(prefix)) return failure('invalid-args', `${name} declares ${entry.entry}, which is outside ${prefix}.`);
    if (!served.has(entry.entry)) return failure('invalid-args', `${name} declares ${entry.entry}, which its asset manifest does not serve.`);
  }
  return { ok: true, value: undefined };
}

async function contributor(root: string, name: string, schemas: Schemas): Promise<Result<{ table: Table; surface: Surface } | undefined>> {
  let manifest: unknown;
  try { manifest = JSON.parse((await readFile(join(root, name, 'package.json'))).subarray(0, limits.manifestBytes).toString('utf8')); }
  catch { return { ok: true, value: undefined }; }
  if (!isObject(manifest) || !contributes(manifest)) return { ok: true, value: undefined };
  const valid = schemas.validator<Surface>('surface', 'surface');
  const declared = manifest['surface'];
  if (!valid(declared)) return failure('invalid-args', `${name} provides a surface name but its surface block does not match contract/surface.`);
  const directory = join(root, name);
  const table = await load(directory, join(directory, 'assets.json'), schemas);
  if (!table.ok) return table;
  const own = owned(name, table.value, declared); if (!own.ok) return own;
  return { ok: true, value: { table: table.value, surface: declared } };
}

/** Joins this surface's own table with every contributor's, in a stable order. */
export async function compose(own: Table, schemas: Schemas, root = siblingRoot()): Promise<Result<Composed>> {
  let names: string[];
  try { names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort(); }
  catch { return { ok: true, value: { table: own, contribution: { panels: [], renderers: [] } } }; }
  if (names.length > limits.packages) return failure('budget', 'The package directory exceeds its entry limit.');
  const tables: Table[] = [own]; const panels: Panel[] = []; const renderers: Renderer[] = [];
  for (const name of names) {
    const found = await contributor(root, name, schemas); if (!found.ok) return found;
    if (!found.value) continue;
    tables.push(found.value.table);
    panels.push(...found.value.surface.panels ?? []);
    renderers.push(...found.value.surface.renderers ?? []);
  }
  const joined = merge(tables); if (!joined.ok) return joined;
  const claimed = new Set<string>();
  for (const panel of panels) {
    if (claimed.has(panel.id)) return failure('invalid-args', `Two packages contribute the panel ${panel.id}.`);
    claimed.add(panel.id);
  }
  return { ok: true, value: { table: joined.value, contribution: { panels, renderers } } };
}

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
 * another. A contributor that is malformed or unreadable is refused **by name and skipped**, never
 * fatally: ADR 0016 settles the shape, leaving a package that cannot initialize inert with its gap
 * reported, "never the environment down". A surface that refused to start because one contributed
 * panel was unreadable would take the whole conversation with it, which is strictly worse than a
 * missing tab beside a named refusal.
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
export interface Refusal { name: string; message: string }
export interface Composed { table: Table; contribution: Contribution; refused: Refusal[] }

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

/** Joins this surface's own table with every contributor's, in a stable order. Only this surface's
 *  own table is load-bearing: every contributor problem is collected in `refused` and skipped. */
export async function compose(own: Table, schemas: Schemas, root = siblingRoot()): Promise<Composed> {
  const empty: Composed = { table: own, contribution: { panels: [], renderers: [] }, refused: [] };
  let names: string[];
  try { names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort(); }
  catch { return empty; }
  if (names.length > limits.packages) return { ...empty, refused: [{ name: root, message: 'The package directory exceeds its entry limit.' }] };
  const tables: Table[] = [own]; const panels: Panel[] = []; const renderers: Renderer[] = []; const refused: Refusal[] = [];
  const claimed = new Set<string>();
  for (const name of names) {
    const found = await contributor(root, name, schemas);
    if (!found.ok) { refused.push({ name, message: found.error.message }); continue; }
    if (!found.value) continue;
    const taken = (found.value.surface.panels ?? []).find(panel => claimed.has(panel.id));
    if (taken) { refused.push({ name, message: `Another package already contributes the panel ${taken.id}.` }); continue; }
    const joined = merge([...tables, found.value.table]);
    if (!joined.ok) { refused.push({ name, message: joined.error.message }); continue; }
    tables.push(found.value.table);
    for (const panel of found.value.surface.panels ?? []) claimed.add(panel.id);
    panels.push(...found.value.surface.panels ?? []);
    renderers.push(...found.value.surface.renderers ?? []);
  }
  const joined = merge(tables);
  if (!joined.ok) return { ...empty, refused: [...refused, { name: root, message: joined.error.message }] };
  return { table: joined.value, contribution: { panels, renderers }, refused };
}

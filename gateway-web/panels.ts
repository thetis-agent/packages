/** Compose the panels packages contribute to this person's surface; contract/surface, ADR 0038 §1.
 *
 * Discovery is a readdir of the sibling packages this target's profile actually materialized, never a
 * list in code (AGENTS.md). It stays inside the person's own gateway: a contributed panel is served by
 * the target that already serves the surface, so no deployment-scope process reaches into a person's
 * sandbox and the boundary rule ADR 0038 declined to weaken is untouched.
 *
 * Two packages may draw the same row kind and neither is refused for it: the browser asks each in
 * turn and takes the first that returns a node, so a package draws its own tool's rows and declines
 * everybody else's (lib/dispatch.js). A panel *id* is still one package's, because a tab is a place
 * on screen and two cannot have it.
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
 *
 * A contributor may also declare `commands`: the verbs its panels may send back to its own service
 * (ADR 0051). They are collected here, per package, and handed to `surface-request.ts`, which is what
 * checks a request against them. A declaration the host could not honour is refused by name like
 * everything else above, and for the same reason — a command silently dropped is a panel that fails
 * at the person's click with nothing anywhere saying why.
 */
import { readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { load, merge } from '@/lib/assets/index.ts';
import type { Table } from '@/lib/assets/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Surface, Panel, Renderer, Command } from '@/contracts/surface/types.ts';

export const limits = { packages: 256, manifestBytes: 65536 };

/** What one contributing package may ask its own service to do, by verb; contract/surface, ADR 0051.
 *  Kept beside the panels rather than sent with them: the browser never needs the list, because the
 *  host is what checks it, and a list the browser holds is a list a panel could read. */
export interface Declared { package: string; commands: Command[] }
export interface Contribution { panels: Panel[]; renderers: Renderer[]; declared: Declared[] }
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

/** A declaration is refused for the same reason an asset outside a package's own segment is: it is a
 *  package saying something the host cannot honour, and a panel whose command is silently dropped is
 *  a panel that fails at the person's click with nothing to read. A verb declared twice has no single
 *  answer, and a command with no panel on this surface has nothing that could ever send it. */
function declares(name: string, surface: Surface): Result<void, 'invalid-args'> {
  const commands = surface.commands ?? [];
  if (!commands.length) return { ok: true, value: undefined };
  if (!(surface.panels ?? []).length) return failure('invalid-args', `${name} declares a command but contributes no panel to send it.`);
  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.verb)) return failure('invalid-args', `${name} declares ${command.verb} more than once.`);
    seen.add(command.verb);
  }
  return { ok: true, value: undefined };
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
  // Bounded before the bytes are allocated, not after: a sibling directory is not necessarily a
  // reviewed package, and reading an arbitrarily large file to then trim it is the allocation this
  // gateway must not make.
  const path = join(root, name, 'package.json');
  // A sibling directory with no manifest is simply not a package, and never a refusal. Once one
  // exists, every later failure is named: a manifest that is unreadable, oversized or malformed is
  // a package that meant to say something, and skipping it silently is how a panel goes missing
  // with no way to find out why.
  try { await access(path); } catch { return { ok: true, value: undefined }; }
  const bytes = await readBounded(path, limits.manifestBytes);
  if (!bytes.ok) return failure('invalid-args', `${name} has a package manifest that could not be read within ${String(limits.manifestBytes)} bytes.`);
  let manifest: unknown;
  try { manifest = JSON.parse(bytes.value.toString('utf8')); }
  catch { return failure('invalid-args', `${name} has a package manifest that is not valid JSON.`); }
  if (!isObject(manifest) || !contributes(manifest)) return { ok: true, value: undefined };
  const valid = schemas.validator<Surface>('surface', 'surface');
  const declared = manifest['surface'];
  if (!valid(declared)) return failure('invalid-args', `${name} provides a surface name but its surface block does not match contract/surface.`);
  const directory = join(root, name);
  const table = await load(directory, join(directory, 'assets.json'), schemas);
  if (!table.ok) return table;
  const own = owned(name, table.value, declared); if (!own.ok) return own;
  const says = declares(name, declared); if (!says.ok) return says;
  return { ok: true, value: { table: table.value, surface: declared } };
}

/** Joins this surface's own table with every contributor's, in a stable order. Only this surface's
 *  own table is load-bearing: every contributor problem is collected in `refused` and skipped. */
export async function compose(own: Table, schemas: Schemas, root = siblingRoot()): Promise<Composed> {
  const empty: Composed = { table: own, contribution: { panels: [], renderers: [], declared: [] }, refused: [] };
  let names: string[];
  try { names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort(); }
  catch { return empty; }
  if (names.length > limits.packages) return { ...empty, refused: [{ name: root, message: 'The package directory exceeds its entry limit.' }] };
  const tables: Table[] = [own]; const panels: Panel[] = []; const renderers: Renderer[] = []; const declared: Declared[] = []; const refused: Refusal[] = [];
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
    if (found.value.surface.commands?.length) declared.push({ package: name, commands: found.value.surface.commands });
  }
  const joined = merge(tables);
  if (!joined.ok) return { ...empty, refused: [...refused, { name: root, message: joined.error.message }] };
  return { table: joined.value, contribution: { panels, renderers, declared }, refused };
}

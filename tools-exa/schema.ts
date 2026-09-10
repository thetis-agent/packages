/** Keep API shapes tied to the reviewed Exa specification; EXA-001, EXA-002. */
import { readFile } from 'node:fs/promises';
import { isObject } from '@/lib/schema/index.ts';
import type { Schemas, Validator } from '@/lib/schema/index.ts';
export class ApiSchemas {
  readonly #document: Record<string, unknown>;
  readonly #schemas: Schemas;
  private constructor(document: Record<string, unknown>, schemas: Schemas) { this.#document = document; this.#schemas = schemas; }
  static async load(schemas: Schemas): Promise<ApiSchemas> {
    await schemas.load();
    const raw: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
    if (!isObject(raw)) throw new Error('The committed Exa schema is invalid.');
    return new ApiSchemas(raw, schemas);
  }
  validator<T>(name: string): Validator<T> { return this.#schemas.definition<T>(this.#document, name); }
  definition(name: string): Record<string, unknown> {
    const defs = this.#document['$defs'];
    if (!isObject(defs) || !isObject(defs[name])) throw new Error('The Exa tool schema is absent.');
    const expanded = expand(defs[name], defs);
    if (!isObject(expanded)) throw new Error('The Exa tool schema is not an object.');
    return expanded;
  }
}
function expand(value: unknown, definitions: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(item => expand(item, definitions));
  if (!isObject(value)) return value;
  if (typeof value['$ref'] === 'string') {
    const name = value['$ref'].replace('#/$defs/', '');
    if (!(name in definitions)) throw new Error('An Exa schema reference is absent.');
    return expand(definitions[name], definitions);
  }
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, expand(item, definitions)]));
}

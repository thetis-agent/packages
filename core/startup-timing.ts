/** Temporary startup phase measurement; GN-001. */
export const timing: Record<string, unknown> = { imports: 0, schemas: 0, peer: 0, initialized: 0 };
export function diagnostics(): Record<string, unknown> {
  const loaded: unknown = Reflect.get(process, 'moduleLoadList');
  const modules: unknown[] = Array.isArray(loaded) ? loaded : [];
  return { memory: process.memoryUsage(), parser: modules.filter((name): name is string => typeof name === 'string' && /amaro/u.test(name)) };
}

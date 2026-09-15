// Shared by the bench's example mechanisms. Not a contract: each of these is a fixture standing in for a
// real package, and a real one would keep its own state however it liked.
export const KEY = "@thetis/bench";

let cached = null;

/** The corpus as the bench left it, at the one path every importer is told about. */
export async function loadCorpus(env) {
  if (!cached) cached = JSON.parse(await env.readFile("bench/corpus.json"));
  return cached;
}

/**
 * Leave a claim, an import record, or both, without disturbing what anyone else put there. The kernel
 * replaces `harness` rather than merging it, so the spread is not optional.
 */
export function mark(ctx, self, importRecord, claim) {
  const prev = ctx.harness[KEY] ?? {};
  return {
    harness: {
      ...ctx.harness,
      [KEY]: {
        ...prev,
        ...(importRecord ? { imports: { ...(prev.imports ?? {}), [self]: importRecord } } : {}),
        ...(claim ? { claims: { ...(prev.claims ?? {}), [self]: { package: self, ...claim } } } : {}),
      },
    },
  };
}

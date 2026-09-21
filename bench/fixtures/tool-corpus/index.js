// bench: write each corpus record as a package under the home and install it, once. Every arm runs this, so
// the floor attaches every corpus tool and a routing arm has the same set to scope. Idempotent: a record whose
// package is installed is skipped, and the install is a link plus a registry record, no build.
import { dirOf, manifestOf, MODULE } from "./lib/manifest.js";

const CORPUS_PATH = "bench/corpus.json";
const KEY = "@thetis/bench";
const SELF = "@thetis/bench-tool-corpus";

export async function importCorpus(ctx) {
  let corpus;
  try {
    corpus = JSON.parse(await ctx.env.readFile(CORPUS_PATH));
  } catch {
    return;
  }
  if (!Array.isArray(corpus?.records) || !corpus.records.length) return;
  const scope = ctx.session.user;
  const installed = new Set((await ctx.env.kernel.packages.list()).map((p) => p.name));
  const t0 = Date.now();
  let added = 0;
  for (const record of corpus.records) {
    if (!record || typeof record.id !== "string" || !Array.isArray(record.tools)) continue;
    const manifest = manifestOf(record, scope);
    if (installed.has(manifest.name)) continue;
    const dir = `packages/${dirOf(record)}`;
    await ctx.env.writeFile(`${dir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    await ctx.env.writeFile(`${dir}/index.js`, MODULE);
    await ctx.env.kernel.packages.install(dir);
    added++;
  }
  const prev = ctx.harness[KEY] && typeof ctx.harness[KEY] === "object" ? ctx.harness[KEY] : {};
  const record = { imported: corpus.records.length, representation: `${corpus.records.length} packages under packages/tg-*, one per group, each declaring its tools`, builtMs: added ? Date.now() - t0 : 0 };
  return { harness: { ...ctx.harness, [KEY]: { ...prev, imports: { ...(prev.imports ?? {}), [SELF]: record } } } };
}

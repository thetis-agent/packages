// Search over the index: a case-insensitive match on the name, the keywords, the description and the
// type. A match on the name ranks first, then keywords, then the description.

import type { IndexedPackage, MarketplaceIndex } from "./index-file.js";

export interface SearchOptions {
  type?: string;
  limit?: number;
}

export function search(index: MarketplaceIndex, query: string, opts: SearchOptions = {}): IndexedPackage[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { pkg: IndexedPackage; score: number }[] = [];
  for (const pkg of index.packages) {
    if (opts.type && pkg.type !== opts.type) continue;
    const score = terms.length ? terms.reduce((sum, term) => sum + scoreOf(pkg, term), 0) : 1;
    if (terms.length && terms.some((term) => scoreOf(pkg, term) === 0)) continue;
    scored.push({ pkg, score });
  }
  scored.sort((a, b) => b.score - a.score || a.pkg.name.localeCompare(b.pkg.name));
  return scored.slice(0, opts.limit ?? 100).map((s) => s.pkg);
}

function scoreOf(pkg: IndexedPackage, term: string): number {
  if (pkg.name.toLowerCase().includes(term)) return 100;
  if (pkg.keywords.some((k) => k.toLowerCase().includes(term))) return 10;
  if (pkg.type.toLowerCase() === term) return 5;
  if (pkg.description.toLowerCase().includes(term)) return 1;
  return 0;
}

import { z } from "zod";

export const RegistrySchema = z.looseObject({ name: z.string(), url: z.string() });
export const RegistryStateSchema = RegistrySchema.extend({ commit: z.string().optional(), error: z.string().optional() });
const StepSchema = z.looseObject({ id: z.string(), phase: z.string() });
const BenchSchema = z.looseObject({ suites: z.array(z.string()), corpus: z.string().optional(), peerGroup: z.string().optional() });

export const IndexedPackageSchema = z.looseObject({
  name: z.string(), version: z.string(), type: z.string(), description: z.string(),
  keywords: z.array(z.string()), registry: z.string(), url: z.string(), dir: z.string(),
  commit: z.string(), source: z.string(), steps: z.array(StepSchema), tools: z.array(z.string()),
  service: z.boolean(), bench: BenchSchema.optional(), readme: z.boolean().optional(), readmeAssets: z.array(z.string()).optional(),
  /** What a person reads before installing: the manifest's label, who it is for, what it was copied from, what it needs, and what it adds. */
  label: z.string().optional(), audience: z.string().optional(), forkedFrom: z.looseObject({ name: z.string(), version: z.string() }).optional(),
  needs: z.array(z.looseObject({ key: z.string(), secret: z.boolean().optional(), help: z.string().optional() })).optional(),
  pages: z.number().optional(), skills: z.boolean().optional(),
});

export const MarketplaceIndexSchema = z.looseObject({
  version: z.literal(1), updatedAt: z.string(), registries: z.array(RegistryStateSchema), packages: z.array(IndexedPackageSchema),
});

export const IndexableManifestSchema = z.looseObject({
  name: z.string().min(1), version: z.string().min(1),
  description: z.string().optional(), keywords: z.array(z.string()).optional(),
  thetis: z.looseObject({
    type: z.string().min(1), steps: z.array(StepSchema).optional(),
    tools: z.array(z.looseObject({ name: z.string() })).optional(), service: z.unknown().optional(),
    bench: BenchSchema.optional(), label: z.unknown().optional(), audience: z.unknown().optional(), forkedFrom: z.unknown().optional(),
    config: z.unknown().optional(), ui: z.unknown().optional(), skills: z.unknown().optional(),
  }),
});

export type Registry = z.infer<typeof RegistrySchema>;
export type RegistryState = z.infer<typeof RegistryStateSchema>;
export type IndexedPackage = z.infer<typeof IndexedPackageSchema>;
export type MarketplaceIndex = z.infer<typeof MarketplaceIndexSchema>;

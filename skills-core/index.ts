/** A skills pack is data, not a stage (findings §1), but lib/package-loader still requires an
 * index.ts in every package directory (discover) and a `stages` object from it (load), so the pack
 * answers with no hooks rather than becoming a special case in the loader. Its skills reach a
 * retriever through the /packages/skills-core@<version> alias, not through this module. */
export const stages = {};

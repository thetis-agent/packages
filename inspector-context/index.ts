/** A surface-only package: it contributes an inspector, and takes no part in a turn.
 *
 * The whole of this package is its `surface` block and the assets under `surface/`, which
 * gateway-web/panels.ts discovers by manifest (contract/surface, ADR 0038 §1). This file exists
 * because discovery is a directory walk that resolves `index.ts` in every sibling
 * (lib/package-loader/index.ts) and refuses the whole registry if one is missing — a surface
 * contributor is still a package.
 *
 * `stages` is empty rather than absent so that a profile which does mount this package gets an inert
 * stage with no hooks, instead of the `does not export stages` refusal ADR 0016 would otherwise leave
 * in the log for a package that never meant to observe, offer or call anything.
 */
export const stages = {};

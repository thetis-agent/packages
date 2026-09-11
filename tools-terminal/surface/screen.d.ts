/** The shape of surface/screen.js, so the tests can exercise it under the workspace's strict flags.
 *
 * The module itself is browser JavaScript: the surface serves it as an asset and there is no build
 * step, so its types are declared here rather than erased from it (ADR 0037 builds artifacts from
 * `.ts` and skips `.d.ts`). Anything that drifts between the two is a test failure, which is the
 * point of the tests importing through this file rather than around it.
 */

export interface Line { chars: string[]; keys: string[] }
export interface Screen {
  lines: Line[];
  row: number;
  col: number;
  fg: number;
  bg: number;
  flags: number;
  saved: { row: number; col: number } | null;
  pending: string;
}
export interface Style { classes: string[]; literal: Record<string, string> }

export const limits: { lines: number; columns: number; render: number; tab: number };
export function blank(): Screen;
export function write(screen: Screen, chunk: string): Screen;
export function styleOf(key: string): Style;
export function hex(value: number): string;
export function textOf(screen: Screen): string;
/** Builds DOM, so it is exercised in a browser rather than here; declared for completeness. */
export function draw(screen: Screen): unknown;

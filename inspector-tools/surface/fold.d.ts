/** The shape of surface/fold.js, so the tests can exercise it under the workspace's strict flags.
 *
 * The module itself is browser JavaScript: the surface serves it as an asset and there is no build
 * step, so its types are declared here rather than erased from it (ADR 0037 builds artifacts from
 * `.ts` and skips `.d.ts`). Anything that drifts between the two is a test failure, which is the
 * point of the tests importing through this file rather than around it.
 */

/** One `{type:'event', session, kind, …}` frame as the surface delivers it (gateway-web assets/app.js). */
export interface Frame { readonly kind: string; readonly session?: string; readonly [field: string]: unknown }

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly schema: unknown;
  readonly readOnly: boolean;
  readonly endsTurn: boolean;
  readonly destructive: boolean;
  readonly derived: boolean;
  readonly data: readonly string[];
}

export interface Mode { readonly readOnly: boolean; readonly deny: readonly string[] }
export interface Offer { readonly tools: readonly Tool[]; readonly mode: Mode }
export interface State { offer: Offer | undefined; seen: Map<string, Tool> }

export interface Group { readonly source: string; readonly tools: readonly Tool[] }
/** `why` is one of `denied`, `read-only` or `gone`; view.js gives each a reading and a hint. */
export interface Withheld { readonly name: string; readonly entry: string; readonly why: string; readonly tool: Tool | undefined }
export interface Counts { readonly offered: number; readonly sources: number; readonly withheld: number }

export interface Described {
  readonly known: boolean;
  readonly mode: Mode;
  readonly sources: readonly Group[];
  readonly withheld: readonly Withheld[];
  readonly counts: Counts;
}

export declare const limits: { readonly tools: number; readonly conversations: number };
export declare const KINDS: readonly string[];
export declare function blank(): State;
export declare function forConversation(states: Map<string, State>, id: string): State;
export declare function apply(state: State, frame: Frame): State;
export declare function describe(state: State): Described;

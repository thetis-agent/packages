/** The shape of surface/fold.js, so panel.test.ts can exercise it under the workspace's strict flags.
 *
 * The module itself is browser JavaScript: the surface serves it as an asset and there is no build
 * step, so its types are declared here rather than erased from it (ADR 0037 builds artifacts from
 * `.ts`, and skips `.d.ts`). Anything that drifts between the two is a test failure, which is the
 * point of the tests importing through this file rather than around it.
 */

/** One `{type:'event', session, kind, …}` frame as the surface delivers it (gateway-web assets/app.js). */
export interface Frame { readonly kind: string; readonly session?: string; readonly [field: string]: unknown }

export interface Call { readonly stop: string; readonly usage: Readonly<Record<string, number>> }

export interface State {
  begin: Record<string, unknown> | undefined;
  context: Record<string, unknown> | undefined;
  calls: Call[];
  totals: Record<string, number>;
  forgotten: number;
}

export interface MessageRow { readonly index: number; readonly role: string; readonly text: string; readonly chars: number; readonly cut: boolean; readonly cached: boolean }
export interface ToolRow { readonly name: string; readonly description: string; readonly schema: unknown }

export interface RequestModel {
  readonly provider: string;
  readonly model: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly cachedThrough: number;
  readonly messages: readonly MessageRow[];
  readonly tools: readonly ToolRow[];
  readonly counts: { readonly messages: number; readonly tools: number };
  readonly hidden: number;
  /** The projection said it had to shorten this frame to fit lib/session/batch.ts's event budget. */
  readonly truncated: boolean;
}

export interface Group { readonly name: string; readonly count: number; readonly chars: number; readonly text: string }
export interface Budget { readonly total: number; readonly reserve: number; readonly used: number; readonly available: number; readonly share: number }
export interface PromptModel { readonly groups: readonly Group[]; readonly budget: Budget; readonly truncated: boolean }

export interface Counter { readonly name: string; readonly total: number }
export interface LedgerRow { readonly n: number; readonly stop: string; readonly usage: Readonly<Record<string, number>> }
export interface UsageModel { readonly counters: readonly Counter[]; readonly calls: readonly LedgerRow[]; readonly forgotten: number; readonly count: number }

export interface Described { readonly request: RequestModel | undefined; readonly prompt: PromptModel | undefined; readonly usage: UsageModel }

export declare const limits: { readonly calls: number; readonly rows: number; readonly chars: number; readonly conversations: number };
export declare const KINDS: readonly string[];
export declare function blank(): State;
export declare function forConversation(states: Map<string, State>, id: string): State;
export declare function apply(state: State, frame: Frame): State;
export declare function describe(state: State): Described;

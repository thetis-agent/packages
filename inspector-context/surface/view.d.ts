/** The shape of surface/view.js; see fold.d.ts for why the declaration is separate from the module.
 *
 * The node type is a parameter because the module never names one: it builds whatever the injected
 * helpers build, which is a real `Node` under `/lib/surface.js` and a recording stand-in under test.
 */
import type { Described, PromptModel, RequestModel, UsageModel } from './fold.js';

export interface SectionSpec { readonly title: string; readonly count?: number; readonly note?: string; readonly mono?: boolean }

export interface Dom<Node> {
  readonly el: (tag: string, props?: Readonly<Record<string, unknown>>, ...children: readonly unknown[]) => Node;
  readonly section: (spec: SectionSpec) => Node;
}

export declare const SEGMENTS: readonly { readonly id: string; readonly label: string }[];
export declare function segmented<Node>(active: string, pick: (id: string) => void, dom: Dom<Node>): Node;
export declare function requestBlocks<Node>(request: RequestModel | undefined, dom: Dom<Node>): Node[];
export declare function promptBlocks<Node>(prompt: PromptModel | undefined, dom: Dom<Node>): Node[];
export declare function usageBlocks<Node>(usage: UsageModel, dom: Dom<Node>): Node[];
export declare function blocks<Node>(segment: string, described: Described, dom: Dom<Node>): Node[];

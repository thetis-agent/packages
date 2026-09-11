/** The shape of surface/view.js; see fold.d.ts for why the declaration is separate from the module.
 *
 * The node type is a parameter because the module never names one: it builds whatever the injected
 * helpers build, which is a real `Node` under `/lib/surface.js` and a recording stand-in under test.
 */
import type { Described, Tool, Withheld } from './fold.js';

export interface SectionSpec {
  readonly title: string;
  readonly count?: number;
  readonly note?: string;
  readonly mono?: boolean;
  readonly open?: boolean;
  readonly onToggle?: (open: boolean) => void;
}

export interface Dom<Node> {
  readonly el: (tag: string, props?: Readonly<Record<string, unknown>>, ...children: readonly unknown[]) => Node;
  readonly section: (spec: SectionSpec) => Node;
  readonly collapsibleSection: (spec: SectionSpec, rows: readonly Node[]) => Node;
}

export declare const limits: { readonly chars: number; readonly denied: number };
export declare function card<Node>(dom: Dom<Node>, tool: Tool, count?: number): Node;
export declare function withheldCard<Node>(dom: Dom<Node>, row: Withheld): Node;
export declare function subtitle(described: Described): string | undefined;
export declare function blocks<Node>(described: Described, dom: Dom<Node>, open: Set<string>, usage?: Readonly<Record<string, number>>): Node[];

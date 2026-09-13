// Where the breakpoints go. Pure positional logic, shared by every wire adapter.
//
// Anthropic's cache is a prefix cache over tools -> system -> messages. A breakpoint writes one
// entry covering everything up to and including its block. A later request hashes its own prefix
// at each breakpoint and walks back at most twenty positions looking for an entry to read. A run of
// consecutive tool results collapses to one position, and so does a run of tool calls, but a turn
// that adds more than twenty positions still overshoots a lone mark at the end of the previous
// request. That window is the reason for the anchors below.

export interface Slot {
  role: string;
  /** Whether the wire form of this message can carry a marker (non-empty content). */
  markable: boolean;
}

export interface Plan {
  /** Mark the system prefix. */
  system: boolean;
  /** Indices into the slot list, ascending. */
  messages: number[];
}

export interface PlanOptions {
  hasSystem: boolean;
  anchorStride: number;
  max: number;
}

/**
 * Three kinds of position, in prefix order:
 * the system prefix, which never changes within a conversation and is the cheapest hit;
 * anchors on a fixed stride of positions, which hold still for several turns and so stay within the
 * lookback when a turn appends many positions; and the final message, which writes the newest prefix
 * for the next request to read back.
 */
export function planBreakpoints(slots: Slot[], opts: PlanOptions): Plan {
  const max = Math.max(1, Math.min(4, opts.max));
  const plan: Plan = { system: false, messages: [] };
  let budget = max;
  if (opts.hasSystem) {
    plan.system = true;
    budget--;
  }
  if (slots.length === 0 || budget === 0) return plan;

  const { positions, lastIndexOf } = collapse(slots);
  const lastPos = positions - 1;
  const wanted: number[] = [];

  const last = markableAtOrBefore(slots, lastIndexOf[lastPos]);
  if (last !== undefined) wanted.push(last);

  // Anchors land on multiples of the stride, so they hold still while the conversation grows around
  // them. Two of them keep a warm entry within reach even when the newest one has just moved.
  if (opts.anchorStride > 0) {
    let anchor = Math.floor(lastPos / opts.anchorStride) * opts.anchorStride;
    let taken = 0;
    while (taken < 2 && anchor > 0) {
      if (anchor < lastPos) {
        const idx = markableAtOrBefore(slots, lastIndexOf[anchor]);
        if (idx !== undefined) wanted.push(idx), taken++;
      }
      anchor -= opts.anchorStride;
    }
  }

  const unique = [...new Set(wanted)].sort((a, b) => a - b);
  // Keep the newest when there are too many: an older prefix is the one most likely still covered
  // by an entry the lookback can reach anyway.
  plan.messages = unique.slice(Math.max(0, unique.length - budget));
  return plan;
}

/** Position numbering with consecutive tool results collapsed. Returns the last slot index of each position. */
export function collapse(slots: Slot[]): { positions: number; lastIndexOf: number[] } {
  const lastIndexOf: number[] = [];
  let prevRole: string | undefined;
  for (let i = 0; i < slots.length; i++) {
    const role = slots[i].role;
    if (role === "tool" && prevRole === "tool") lastIndexOf[lastIndexOf.length - 1] = i;
    else lastIndexOf.push(i);
    prevRole = role;
  }
  return { positions: lastIndexOf.length, lastIndexOf };
}

function markableAtOrBefore(slots: Slot[], index: number): number | undefined {
  for (let i = index; i >= 0; i--) if (slots[i].markable) return i;
  return undefined;
}

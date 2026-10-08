/* The grid's geometry along one axis: where each row (or column) starts, as a prefix sum over the sizes
 * the tab sets and the default for the rest, and the reverse — which index a pixel offset falls in — by
 * binary search. 20,000 rows is a Float64Array of 20,001 numbers, rebuilt only when a size changes. Pure:
 * no DOM, so the node tests can use it. */

import { colName } from "./core/address.js";

export const ROW_H = 24;
export const COL_W = 100;
export const HEAD_H = 24; // the column letters
export const HEAD_W = 46; // the row numbers

/**
 * `count` indexes, `sizes` the tab's sparse map (keyed by `keyOf(i)`), `fallback` the default size.
 * Answers `{ count, total, start(i), size(i), end(i), at(px) }`; `start(count)` is the total.
 */
export function axis(count, sizes, fallback, keyOf) {
  const pos = new Float64Array(count + 1);
  const own = sizes && typeof sizes === "object" ? sizes : {};
  const any = Object.keys(own).length > 0;
  for (let i = 0; i < count; i++) {
    const s = any ? Number(own[keyOf(i)]) : NaN;
    pos[i + 1] = pos[i] + (Number.isFinite(s) && s > 0 ? s : fallback);
  }
  const total = pos[count];
  return {
    count,
    total,
    start: (i) => pos[Math.max(0, Math.min(count, i))],
    end: (i) => pos[Math.max(0, Math.min(count, i + 1))],
    size: (i) => pos[i + 1] - pos[i],
    /** The index whose span holds `px` (clamped to the axis). */
    at(px) {
      if (px <= 0) return 0;
      if (px >= total) return count - 1;
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pos[mid] <= px) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

export const rowAxis = (tab) => axis(tab.rows, tab.heights, ROW_H, (i) => String(i + 1));
export const colAxis = (tab) => axis(tab.cols, tab.widths, COL_W, colName);

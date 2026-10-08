/* The calculator: every cell's value in a workbook, formulas evaluated on demand and remembered for the
 * one computation. The page runs it after every edit and the tools after every write, so it is built
 * for speed: parsed trees are cached by formula text across calls (formula.js), cells are found by a
 * numeric key in one Map per tab, ranges walk only the cells that exist, and whole columns stop at the
 * tab's last used row. A chain of formulas deeper than the stack would allow is evaluated from the far
 * end first (a deferral, not a recursion), and a circular reference makes #CYCLE! of every cell on it. */
import { addr, parseAddr } from "./address.js";
import { parseCached } from "./formula.js";
import { FUNCTIONS } from "./functions.js";
import { compareValues, error, isError, Range, scalarOf, toNumber, toText } from "./values.js";

const W = 1024;
const TAB_SPAN = 33554432;
const DEPTH = 300;
const BLOCK = 64;

class Deferral {
  constructor(td, key) {
    this.td = td;
    this.key = key;
  }
}

function tabData(tab, index) {
  const grid = new Map();
  let maxRow = -1;
  let maxCol = -1;
  let formulas = 0;
  for (const a in tab.cells) {
    const p = parseAddr(a);
    if (!p) continue;
    const raw = tab.cells[a];
    grid.set(p.row * W + p.col, raw);
    if (p.row > maxRow) maxRow = p.row;
    if (p.col > maxCol) maxCol = p.col;
    if (typeof raw === "string" && raw[0] === "=") formulas++;
  }
  return { id: tab.id, name: tab.name, index, rows: tab.rows, cols: tab.cols, grid, maxRow, maxCol, formulas, byCol: null, blocks: null, values: new Map() };
}

function columnsOf(td) {
  if (td.byCol) return td.byCol;
  const byCol = new Map();
  for (const key of td.grid.keys()) {
    const c = key % W;
    let list = byCol.get(c);
    if (!list) byCol.set(c, (list = []));
    list.push((key - c) / W);
  }
  for (const list of byCol.values()) list.sort((a, b) => a - b);
  td.byCol = byCol;
  return byCol;
}

const lowerBound = (list, x) => {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const finish = (v, at) => {
  if (v instanceof Range) v = scalarOf(v, at);
  if (v === undefined) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return error("#NUM!", "The result is not a finite number.");
    if (Object.is(v, -0)) return 0;
  }
  if (typeof v === "string" && v.length > 32767) return error("#VALUE!", "The text is longer than 32,767 characters.");
  return v;
};

class Engine {
  constructor(workbook, now) {
    this.now = now;
    this.tabs = (workbook.tabs ?? []).map(tabData);
    this.byId = new Map(this.tabs.map((t) => [t.id, t]));
    this.byName = new Map(this.tabs.map((t) => [String(t.name).toLowerCase(), t]));
    this.visiting = new Set();
    this.path = [];
    this.pending = new Set();
    this.pendingList = [];
    this.root = -1;
    this.cycle = new Set();
    this.depth = 0;
  }

  tab(ref) {
    return this.byId.get(ref) ?? this.byName.get(String(ref).toLowerCase()) ?? null;
  }

  cellValue(td, r, c) {
    const key = r * W + c;
    const raw = td.grid.get(key);
    if (raw === undefined) return null;
    if (typeof raw === "string") {
      if (raw[0] === "=") {
        const v = td.values.get(key);
        return v !== undefined ? v : this.evalCell(td, key, raw);
      }
      if (raw[0] === "'") return raw.slice(1);
    }
    return raw;
  }

  eachIn(td, r1, c1, r2, c2, fn) {
    if (r2 > td.maxRow) r2 = td.maxRow;
    if (c2 > td.maxCol) c2 = td.maxCol;
    if (r1 > r2 || c1 > c2) return;
    const area = (r2 - r1 + 1) * (c2 - c1 + 1);
    if (area <= 64 || area <= td.grid.size / 4) {
      for (let r = r1; r <= r2; r++)
        for (let c = c1; c <= c2; c++) {
          if (!td.grid.has(r * W + c)) continue;
          if (fn(this.cellValue(td, r, c), r, c) === false) return;
        }
      return;
    }
    const byCol = columnsOf(td);
    if (c1 === c2) {
      const list = byCol.get(c1);
      if (!list) return;
      for (let k = lowerBound(list, r1); k < list.length && list[k] <= r2; k++) if (fn(this.cellValue(td, list[k], c1), list[k], c1) === false) return;
      return;
    }
    const keys = [];
    for (let c = c1; c <= c2; c++) {
      const list = byCol.get(c);
      if (!list) continue;
      for (let k = lowerBound(list, r1); k < list.length && list[k] <= r2; k++) keys.push(list[k] * W + c);
    }
    keys.sort((a, b) => a - b);
    for (const key of keys) {
      const c = key % W;
      const r = (key - c) / W;
      if (fn(this.cellValue(td, r, c), r, c) === false) return;
    }
  }

  /** The sum and count of the numbers in a block and its first error: `{ sum, count, err }`. Columns are
   * walked through their sorted rows in blocks of 64 whose totals are kept for the computation, so the
   * running totals people write (=SUM($A$1:A500) down a column) do not cost the square of the rows. */
  sumIn(td, r1, c1, r2, c2) {
    if (r2 > td.maxRow) r2 = td.maxRow;
    if (c2 > td.maxCol) c2 = td.maxCol;
    let sum = 0;
    let count = 0;
    let err = null;
    if (r1 > r2 || c1 > c2) return { sum, count, err };
    const byCol = columnsOf(td);
    if (!td.blocks) td.blocks = new Map();
    for (let c = c1; c <= c2; c++) {
      const rows = byCol.get(c);
      if (!rows) continue;
      let k = lowerBound(rows, r1);
      const hi = lowerBound(rows, r2 + 1);
      while (k < hi) {
        if (k % BLOCK === 0 && k + BLOCK <= hi) {
          const id = c * 65536 + k / BLOCK;
          let b = td.blocks.get(id);
          if (!b) {
            b = { sum: 0, count: 0, err: null };
            for (let j = k; j < k + BLOCK; j++) {
              const v = this.cellValue(td, rows[j], c);
              if (typeof v === "number") {
                b.sum += v;
                b.count++;
              } else if (b.err === null && isError(v)) b.err = v;
            }
            td.blocks.set(id, b);
          }
          sum += b.sum;
          count += b.count;
          if (err === null && b.err) err = b.err;
          k += BLOCK;
        } else {
          const v = this.cellValue(td, rows[k], c);
          if (typeof v === "number") {
            sum += v;
            count++;
          } else if (err === null && isError(v)) err = v;
          k++;
        }
      }
    }
    return { sum, count, err };
  }

  markCycle(fromId) {
    let at = this.path.indexOf(fromId);
    if (at >= 0) {
      for (let k = at; k < this.path.length; k++) this.cycle.add(this.path[k]);
      return;
    }
    at = this.pendingList.indexOf(fromId);
    for (let k = Math.max(0, at); k < this.pendingList.length; k++) this.cycle.add(this.pendingList[k]);
    for (const id of this.path) this.cycle.add(id);
  }

  evalCell(td, key, raw) {
    const id = td.index * TAB_SPAN + key;
    if (this.visiting.has(id) || (id !== this.root && this.pending.has(id))) {
      this.markCycle(id);
      return error("#CYCLE!", `${addr((key - (key % W)) / W, key % W)} depends on itself.`);
    }
    if (this.depth >= DEPTH) throw new Deferral(td, key);
    this.visiting.add(id);
    this.path.push(id);
    this.depth++;
    try {
      const row = (key - (key % W)) / W;
      const col = key % W;
      const parsed = parseCached(raw);
      const scope = { td, tabId: td.id, row, col, now: this.now };
      let v = parsed.error ? error("#ERROR!", parsed.error) : finish(this.ev(parsed.ast, scope), scope);
      if (this.cycle.has(id)) v = error("#CYCLE!", `${addr(row, col)} is part of a circular reference.`);
      td.values.set(key, v);
      return v;
    } finally {
      this.visiting.delete(id);
      this.path.pop();
      this.depth--;
    }
  }

  /** Evaluates one formula cell to the end, chasing deferrals from deep chains with a stack of its own. */
  force(td, key) {
    if (td.values.has(key)) return td.values.get(key);
    const stack = [[td, key]];
    while (stack.length) {
      const [t, k] = stack[stack.length - 1];
      const id = t.index * TAB_SPAN + k;
      if (t.values.has(k)) {
        stack.pop();
        if (this.pending.delete(id) && this.pendingList[this.pendingList.length - 1] === id) this.pendingList.pop();
        continue;
      }
      if (!this.pending.has(id)) {
        this.pending.add(id);
        this.pendingList.push(id);
      }
      this.root = id;
      try {
        this.evalCell(t, k, t.grid.get(k));
      } catch (e) {
        if (!(e instanceof Deferral)) throw e;
        this.depth = 0;
        const did = e.td.index * TAB_SPAN + e.key;
        if (this.pending.has(did)) {
          this.markCycle(did);
          e.td.values.set(e.key, error("#CYCLE!", "This cell is part of a circular reference."));
        } else stack.push([e.td, e.key]);
      }
    }
    this.root = -1;
    return td.values.get(key);
  }

  /** Runs fn, evaluating any cell a deferral asks for first and trying again. */
  settle(fn) {
    for (;;) {
      try {
        return fn();
      } catch (e) {
        if (!(e instanceof Deferral)) throw e;
        this.depth = 0;
        this.force(e.td, e.key);
      }
    }
  }

  ref(node, sc) {
    if (node.bad) return error("#REF!", "The reference is off the grid.");
    let td = sc.td;
    if (node.tab !== null) {
      td = this.byName.get(node.tab.toLowerCase());
      if (!td) return error("#REF!", `There is no tab named ${node.tab}.`);
    }
    if (node.kind === "cols") return new Range(this, td, 0, node.c1, Math.max(0, td.rows - 1), node.c2);
    if (node.kind === "rows") return new Range(this, td, node.r1, 0, node.r2, Math.max(0, td.cols - 1));
    return new Range(this, td, node.r1, node.c1, node.r2, node.c2);
  }

  /** One value of a node: a cell reference read straight from the grid, a range through implicit intersection. */
  val(node, sc) {
    if (node.t === "ref" && node.kind === "cell" && node.tab === null && !node.bad) return this.cellValue(sc.td, node.r1, node.c1);
    const v = this.ev(node, sc);
    return v instanceof Range ? scalarOf(v, sc) : v;
  }

  num(node, sc) {
    return toNumber(this.val(node, sc));
  }

  ev(node, sc) {
    switch (node.t) {
      case "num":
      case "str":
      case "bool":
        return node.v;
      case "err":
        return error(node.v);
      case "empty":
        return null;
      case "ref":
        return this.ref(node, sc);
      case "name":
        return error("#NAME?", `Unknown name ${node.name}.`);
      case "neg": {
        const v = this.num(node.a, sc);
        return isError(v) ? v : -v;
      }
      case "pos":
        return this.val(node.a, sc);
      case "pct": {
        const v = this.num(node.a, sc);
        return isError(v) ? v : v / 100;
      }
      case "bin":
        return this.bin(node, sc);
      case "range": {
        const a = this.ev(node.a, sc);
        if (isError(a)) return a;
        const b = this.ev(node.b, sc);
        if (isError(b)) return b;
        if (!(a instanceof Range) || !(b instanceof Range) || a.td !== b.td) return error("#VALUE!", "A range joins two references on the same tab.");
        return new Range(this, a.td, Math.min(a.r1, b.r1), Math.min(a.c1, b.c1), Math.max(a.r2, b.r2), Math.max(a.c2, b.c2));
      }
      case "fn":
        return this.call(node, sc);
      default:
        return error("#ERROR!", "The formula does not parse.");
    }
  }

  bin(node, sc) {
    const op = node.op;
    if (op === "&") {
      const a = toText(this.val(node.a, sc));
      if (isError(a)) return a;
      const b = toText(this.val(node.b, sc));
      if (isError(b)) return b;
      return a + b;
    }
    if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      const a = this.val(node.a, sc);
      if (isError(a)) return a;
      const b = this.val(node.b, sc);
      if (isError(b)) return b;
      const c = compareValues(a, b);
      switch (op) {
        case "=":
          return c === 0;
        case "<>":
          return c !== 0;
        case "<":
          return c < 0;
        case ">":
          return c > 0;
        case "<=":
          return c <= 0;
        default:
          return c >= 0;
      }
    }
    const a = this.num(node.a, sc);
    if (isError(a)) return a;
    const b = this.num(node.b, sc);
    if (isError(b)) return b;
    switch (op) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "/":
        return b === 0 ? error("#DIV/0!", "Division by zero.") : a / b;
      case "^": {
        if (a === 0 && b < 0) return error("#DIV/0!", "Zero to a negative power.");
        const v = Math.pow(a, b);
        return Number.isNaN(v) ? error("#NUM!", "The power has no real result.") : v;
      }
      default:
        return error("#ERROR!", `Unknown operator ${op}.`);
    }
  }

  call(node, sc) {
    const spec = FUNCTIONS[node.name];
    if (!spec) return error("#NAME?", `Unknown function ${node.name}.`);
    const args = node.args;
    if (args.length < spec.min || args.length > spec.max) return error("#N/A", `Wrong number of arguments: ${spec.help}.`);
    if (spec.takes === "lazy") return spec.fn(args.map((a) => () => this.ev(a, sc)), sc);
    const vals = new Array(args.length);
    for (let k = 0; k < args.length; k++) {
      const v = spec.takes === "refs" ? this.ev(args[k], sc) : this.val(args[k], sc);
      if (!spec.errors && isError(v)) return v;
      vals[k] = v;
    }
    return spec.fn(vals, sc);
  }
}

/** Every non-empty cell's value: `{ value(tabId, addr), all(tabId) → Map<addr, value>, errors }`, formulas
 * evaluated once each. `tabId` may also be a tab's name. */
export function compute(workbook, { now = new Date() } = {}) {
  const eng = new Engine(workbook, now);
  const errors = [];
  for (const td of eng.tabs) {
    if (!td.formulas) continue;
    for (const [key, raw] of td.grid) {
      if (typeof raw !== "string" || raw[0] !== "=") continue;
      const v = td.values.has(key) ? td.values.get(key) : eng.force(td, key);
      if (isError(v)) errors.push({ tab: td.id, row: (key - (key % W)) / W, col: key % W, value: v });
    }
  }
  errors.sort((a, b) => eng.byId.get(a.tab).index - eng.byId.get(b.tab).index || a.row - b.row || a.col - b.col);
  const alls = new Map();
  return {
    value(tabId, address) {
      const td = eng.tab(tabId);
      const p = parseAddr(address);
      if (!td || !p) return null;
      return eng.cellValue(td, p.row, p.col);
    },
    all(tabId) {
      const td = eng.tab(tabId);
      if (!td) return new Map();
      let m = alls.get(td.id);
      if (m) return m;
      m = new Map();
      for (const key of [...td.grid.keys()].sort((a, b) => a - b)) {
        const c = key % W;
        const r = (key - c) / W;
        m.set(addr(r, c), eng.cellValue(td, r, c));
      }
      alls.set(td.id, m);
      return m;
    },
    errors: errors.map((e) => ({ tab: e.tab, addr: addr(e.row, e.col), value: e.value })),
  };
}

/** The value of a formula that is not stored anywhere, as if it sat at `row`/`col` (default A1) of the tab. */
export function evaluate(workbook, tabId, formula, { now = new Date(), row = 0, col = 0 } = {}) {
  const eng = new Engine(workbook, now);
  const td = eng.tab(tabId) ?? eng.tabs[0];
  if (!td) return error("#REF!", "The workbook has no tab.");
  const src = String(formula);
  const parsed = parseCached(src[0] === "=" ? src : "=" + src);
  if (parsed.error) return error("#ERROR!", parsed.error);
  const scope = { td, tabId: td.id, row, col, now };
  return eng.settle(() => finish(eng.ev(parsed.ast, scope), scope));
}


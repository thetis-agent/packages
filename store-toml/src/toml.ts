// A TOML 1.0 reader and writer with no dependencies. The reader walks the text once with an explicit
// position and line, so every error names the line it happened on. The writer is canonical: keys sorted,
// scalars before sub-tables, one spelling per value. That is what makes stringify(parse(stringify(doc)))
// byte-stable, which a file-backed store wants so that an unchanged document is an unchanged file.
//
// Left out on purpose: datetimes are kept as the string they were written as (the store never produces
// them, and JSON has no such type), and integers beyond 2^53 lose precision because values are JS numbers.

export type Table = Record<string, unknown>;

/** A parse error. `line` is the line the problem was found on; the message ends with it too. */
export class TomlError extends SyntaxError {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} at line ${line}`);
    this.name = "TomlError";
  }
}

export function parse(text: string): Table {
  return new Parser(text).parse();
}

export function stringify(doc: Table): string {
  if (!isTable(doc)) throw new TypeError("a TOML document is an object");
  const lines: string[] = [];
  writeTable(lines, [], doc, null);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- reader

/**
 * How a table came to exist, which decides what may still be added to it. A `header` table (`[a]`, or an
 * element of `[[a]]`) can grow sub-tables by header but cannot be defined again. An `implicit` one exists
 * only because `[a.b]` named it on the way down; one later `[a]` may define it. A `dotted` one was made
 * by `a.b = 1`; more dotted keys in the same section and sub-table headers may extend it, a header may
 * not define it. An `inline` one is closed for good.
 */
type Origin = "header" | "implicit" | "dotted" | "inline";

interface Meta {
  origin: Origin;
  line: number;
}

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const BARE_TOKEN = /[0-9A-Za-z_+\-.]+/y;
// Offset and local date-times, local dates and local times, TOML 1.0 shapes (seconds required).
const DATETIME =
  /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?/y;
const DEC_INT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/;
const DEC_FLOAT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;
const HEX_INT = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
const OCT_INT = /^0o[0-7](?:_?[0-7])*$/;
const BIN_INT = /^0b[01](?:_?[01])*$/;
const SPECIAL_FLOAT = /^[+-]?(?:inf|nan)$/;

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

class Parser {
  private pos = 0;
  private line = 1;
  private readonly root: Table = {};
  private readonly meta = new WeakMap<object, Meta>();
  /** Arrays made by `[[x]]`, the only ones another `[[x]]` may append to. */
  private readonly tableArrays = new WeakSet<unknown[]>();

  constructor(private readonly text: string) {
    if (text.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  parse(): Table {
    this.meta.set(this.root, { origin: "header", line: 0 });
    let current = this.root;
    for (;;) {
      this.skipBlank();
      if (this.eof()) return this.root;
      if (this.peek() === "[") current = this.header();
      else this.pair(current);
      this.endOfLine();
    }
  }

  // -- text cursor

  private eof(): boolean {
    return this.pos >= this.text.length;
  }

  private peek(ahead = 0): string {
    return this.text[this.pos + ahead] ?? "";
  }

  private fail(message: string, line = this.line): never {
    throw new TomlError(message, line);
  }

  private describe(ch: string): string {
    if (ch === "") return "end of input";
    if (ch === "\n" || ch === "\r") return "end of line";
    return `\`${ch}\``;
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`expected \`${ch}\` but found ${this.describe(this.peek())}`);
    this.pos++;
  }

  /** Consumes one LF or CRLF. */
  private newline(): boolean {
    if (this.peek() === "\n") {
      this.pos++;
      this.line++;
      return true;
    }
    if (this.peek() === "\r" && this.peek(1) === "\n") {
      this.pos += 2;
      this.line++;
      return true;
    }
    return false;
  }

  private skipWs(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  private skipComment(): void {
    if (this.peek() !== "#") return;
    while (!this.eof() && this.peek() !== "\n" && this.peek() !== "\r") this.pos++;
  }

  /** Whitespace, comments and newlines: what may sit between statements and between array elements. */
  private skipBlank(): void {
    for (;;) {
      this.skipWs();
      this.skipComment();
      if (!this.newline()) return;
    }
  }

  /** After a statement: only a comment, then the end of the line or of the input. */
  private endOfLine(): void {
    this.skipWs();
    this.skipComment();
    if (this.eof() || this.newline()) return;
    this.fail(`unexpected ${this.describe(this.peek())} after the value`);
  }

  // -- keys

  private keyPath(): string[] {
    const path: string[] = [];
    for (;;) {
      this.skipWs();
      path.push(this.simpleKey());
      this.skipWs();
      if (this.peek() !== ".") return path;
      this.pos++;
    }
  }

  private simpleKey(): string {
    const ch = this.peek();
    if (ch === '"') return this.basicString();
    if (ch === "'") return this.literalString();
    BARE_KEY.lastIndex = this.pos;
    const m = BARE_KEY.exec(this.text);
    if (!m) this.fail(`expected a key but found ${this.describe(ch)}`);
    this.pos += m[0].length;
    return m[0];
  }

  // -- statements

  /** `[a.b]` or `[[a.b]]`. Returns the table the following pairs belong to. */
  private header(): Table {
    const line = this.line;
    this.expect("[");
    const isArray = this.peek() === "[";
    if (isArray) this.pos++;
    const path = this.keyPath();
    this.expect("]");
    if (isArray) this.expect("]");

    let table = this.root;
    for (const part of path.slice(0, -1)) table = this.headerChild(table, part, path);
    const last = path[path.length - 1] as string;
    const existing = own(table, last);
    const name = joinPath(path);

    if (isArray) {
      if (existing === undefined) {
        const arr: unknown[] = [];
        this.tableArrays.add(arr);
        define(table, last, arr);
        return this.pushElement(arr, line);
      }
      if (Array.isArray(existing)) {
        if (!this.tableArrays.has(existing)) this.fail(`\`${name}\` is a static array and cannot be appended to`, line);
        return this.pushElement(existing, line);
      }
      if (isTable(existing)) this.fail(`\`${name}\` is a table, not an array of tables`, line);
      this.fail(`\`${name}\` already holds a value`, line);
    }

    if (existing === undefined) {
      const t: Table = {};
      this.meta.set(t, { origin: "header", line });
      define(table, last, t);
      return t;
    }
    if (isTable(existing)) {
      const meta = this.meta.get(existing) as Meta;
      if (meta.origin === "implicit") {
        meta.origin = "header";
        meta.line = line;
        return existing;
      }
      if (meta.origin === "inline") this.fail(`\`${name}\` is an inline table and cannot be extended`, line);
      if (meta.origin === "dotted") this.fail(`table \`${name}\` was already defined by a dotted key at line ${meta.line}`, line);
      this.fail(`table \`${name}\` is already defined at line ${meta.line}`, line);
    }
    if (Array.isArray(existing)) this.fail(`\`${name}\` is an array, not a table`, line);
    this.fail(`\`${name}\` already holds a value`, line);
  }

  private pushElement(arr: unknown[], line: number): Table {
    const t: Table = {};
    this.meta.set(t, { origin: "header", line });
    arr.push(t);
    return t;
  }

  /** One step of a header path: descends into a table, or into the last element of an array of tables. */
  private headerChild(table: Table, part: string, path: string[]): Table {
    const existing = own(table, part);
    if (existing === undefined) {
      const t: Table = {};
      this.meta.set(t, { origin: "implicit", line: this.line });
      define(table, part, t);
      return t;
    }
    if (isTable(existing)) {
      if (this.meta.get(existing)?.origin === "inline") this.fail(`\`${part}\` in \`${joinPath(path)}\` is an inline table and cannot be extended`);
      return existing;
    }
    if (Array.isArray(existing)) {
      if (!this.tableArrays.has(existing)) this.fail(`\`${part}\` in \`${joinPath(path)}\` is a static array, not a table`);
      return existing[existing.length - 1] as Table;
    }
    this.fail(`\`${part}\` in \`${joinPath(path)}\` is not a table`);
  }

  /** `a.b.c = value` into `table`. */
  private pair(table: Table): void {
    const path = this.keyPath();
    this.expect("=");
    this.skipWs();
    const line = this.line;
    const value = this.value();
    let target = table;
    for (const part of path.slice(0, -1)) target = this.dottedChild(target, part, line);
    const last = path[path.length - 1] as string;
    if (own(target, last) !== undefined) this.fail(`duplicate key \`${joinPath(path)}\``, line);
    define(target, last, value);
  }

  /** One step of a dotted key: only tables that dotted keys made may be extended this way. */
  private dottedChild(table: Table, part: string, line: number): Table {
    const existing = own(table, part);
    if (existing === undefined) {
      const t: Table = {};
      this.meta.set(t, { origin: "dotted", line });
      define(table, part, t);
      return t;
    }
    if (isTable(existing)) {
      const meta = this.meta.get(existing) as Meta;
      if (meta.origin === "dotted") return existing;
      if (meta.origin === "inline") this.fail(`\`${part}\` is an inline table and cannot be extended`, line);
      this.fail(`\`${part}\` is a table defined at line ${meta.line} and cannot be extended by a dotted key`, line);
    }
    if (Array.isArray(existing)) this.fail(`\`${part}\` is an array, not a table`, line);
    this.fail(`\`${part}\` already holds a value`, line);
  }

  // -- values

  private value(): unknown {
    const ch = this.peek();
    if (ch === '"') return this.peek(1) === '"' && this.peek(2) === '"' ? this.multilineBasicString() : this.basicString();
    if (ch === "'") return this.peek(1) === "'" && this.peek(2) === "'" ? this.multilineLiteralString() : this.literalString();
    if (ch === "[") return this.array();
    if (ch === "{") return this.inlineTable();
    if (ch >= "0" && ch <= "9") {
      DATETIME.lastIndex = this.pos;
      const m = DATETIME.exec(this.text);
      if (m) {
        this.pos += m[0].length;
        return m[0];
      }
    }
    BARE_TOKEN.lastIndex = this.pos;
    const m = BARE_TOKEN.exec(this.text);
    if (!m) this.fail(`expected a value but found ${this.describe(ch)}`);
    const token = m[0];
    const value = this.scalar(token);
    if (value === undefined) this.fail(`invalid value \`${token}\``);
    this.pos += token.length;
    return value;
  }

  private scalar(token: string): unknown {
    if (token === "true") return true;
    if (token === "false") return false;
    if (SPECIAL_FLOAT.test(token)) {
      if (token.endsWith("nan")) return NaN;
      return token.startsWith("-") ? -Infinity : Infinity;
    }
    const plain = token.replace(/_/g, "");
    if (DEC_INT.test(token) || DEC_FLOAT.test(token)) return Number(plain);
    if (HEX_INT.test(token) || OCT_INT.test(token) || BIN_INT.test(token)) return Number(plain);
    return undefined;
  }

  private array(): unknown[] {
    const line = this.line;
    this.expect("[");
    const items: unknown[] = [];
    for (;;) {
      this.skipBlank();
      if (this.eof()) this.fail("unterminated array", line);
      if (this.peek() === "]") {
        this.pos++;
        return items;
      }
      items.push(this.value());
      this.skipBlank();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() === "]") {
        this.pos++;
        return items;
      }
      this.fail(`expected \`,\` or \`]\` in an array but found ${this.describe(this.peek())}`);
    }
  }

  private inlineTable(): Table {
    const line = this.line;
    this.expect("{");
    const table: Table = {};
    this.skipWs();
    if (this.peek() === "}") {
      this.pos++;
      this.meta.set(table, { origin: "inline", line });
      return table;
    }
    for (;;) {
      this.noNewlineInInlineTable();
      this.pair(table);
      this.skipWs();
      if (this.peek() === ",") {
        this.pos++;
        this.skipWs();
        if (this.peek() === "}") this.fail("an inline table cannot end with a comma");
        continue;
      }
      if (this.peek() === "}") {
        this.pos++;
        this.meta.set(table, { origin: "inline", line });
        return table;
      }
      this.noNewlineInInlineTable();
      this.fail(`expected \`,\` or \`}\` in an inline table but found ${this.describe(this.peek())}`);
    }
  }

  /** TOML 1.0 keeps an inline table on one line; a newline between its pairs is the usual mistake. */
  private noNewlineInInlineTable(): void {
    if (this.peek() === "\n" || this.peek() === "\r") this.fail("an inline table must stay on one line");
  }

  // -- strings

  private basicString(): string {
    this.expect('"');
    let out = "";
    for (;;) {
      const ch = this.peek();
      if (ch === "" || ch === "\n" || ch === "\r") this.fail("unterminated string");
      this.pos++;
      if (ch === '"') return out;
      if (ch === "\\") out += this.escape(false);
      else out += this.checkedChar(ch);
    }
  }

  private multilineBasicString(): string {
    const start = this.line;
    this.pos += 3;
    this.newline();
    let out = "";
    for (;;) {
      const ch = this.peek();
      if (ch === "") this.fail("unterminated multi-line string", start);
      if (ch === '"') {
        const run = this.quoteRun('"');
        if (run < 3) {
          out += '"'.repeat(run);
          continue;
        }
        // Up to two quotes may sit against the closing delimiter; more than that is left for the caller to trip on.
        const extra = Math.min(run, 5) - 3;
        this.pos -= run - 3 - extra;
        return out + '"'.repeat(extra);
      }
      if (this.newline()) {
        out += "\n";
        continue;
      }
      this.pos++;
      if (ch === "\\") out += this.escape(true);
      else out += this.checkedChar(ch);
    }
  }

  private literalString(): string {
    this.expect("'");
    let out = "";
    for (;;) {
      const ch = this.peek();
      if (ch === "" || ch === "\n" || ch === "\r") this.fail("unterminated string");
      this.pos++;
      if (ch === "'") return out;
      out += this.checkedChar(ch);
    }
  }

  private multilineLiteralString(): string {
    const start = this.line;
    this.pos += 3;
    this.newline();
    let out = "";
    for (;;) {
      const ch = this.peek();
      if (ch === "") this.fail("unterminated multi-line string", start);
      if (ch === "'") {
        const run = this.quoteRun("'");
        if (run < 3) {
          out += "'".repeat(run);
          continue;
        }
        const extra = Math.min(run, 5) - 3;
        this.pos -= run - 3 - extra;
        return out + "'".repeat(extra);
      }
      if (this.newline()) {
        out += "\n";
        continue;
      }
      this.pos++;
      out += this.checkedChar(ch);
    }
  }

  /** Consumes a run of `quote` and returns its length. */
  private quoteRun(quote: string): number {
    let n = 0;
    while (this.peek(n) === quote) n++;
    this.pos += n;
    return n;
  }

  /** Control characters other than tab are not allowed raw inside any string. */
  private checkedChar(ch: string): string {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && ch !== "\t") || code === 0x7f) this.fail(`control character U+${code.toString(16).padStart(4, "0").toUpperCase()} in a string`);
    return ch;
  }

  /** After a backslash. `multiline` allows the line-ending backslash. */
  private escape(multiline: boolean): string {
    const ch = this.peek();
    this.pos++;
    const simple = SIMPLE_ESCAPES[ch];
    if (simple !== undefined) return simple;
    if (ch === "u") return this.unicodeEscape(4);
    if (ch === "U") return this.unicodeEscape(8);
    if (multiline && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r")) {
      this.pos--;
      this.skipWs();
      if (!this.newline()) this.fail("a line-ending backslash must be followed by a newline");
      for (;;) {
        this.skipWs();
        if (!this.newline()) return "";
      }
    }
    this.fail(`invalid escape \`\\${ch}\``);
  }

  private unicodeEscape(digits: number): string {
    const hex = this.text.slice(this.pos, this.pos + digits);
    if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) this.fail(`\\${digits === 4 ? "u" : "U"} needs ${digits} hex digits`);
    const code = parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail(`\\${digits === 4 ? "u" : "U"}${hex} is not a Unicode scalar value`);
    this.pos += digits;
    return String.fromCodePoint(code);
  }
}

// ---------------------------------------------------------------- writer

const BARE_KEY_WHOLE = /^[A-Za-z0-9_-]+$/;

/**
 * Writes `table` under `header` (null for the root). Scalars and inline arrays come first, then every
 * sub-table as `[path]` and every array of tables as one `[[path]]` section per element, keys sorted.
 * Each element is written whole before the next, because `[path.sub]` after `[[path]]` means the last element.
 */
function writeTable(lines: string[], path: string[], table: Table, header: "table" | "array" | null): void {
  const keys = Object.keys(table).sort();
  const pairs = keys.filter((k) => !isSubTable(table[k]));
  const subs = keys.filter((k) => isSubTable(table[k]));

  if (header !== null) {
    if (lines.length > 0) lines.push("");
    const name = path.map(formatKey).join(".");
    lines.push(header === "table" ? `[${name}]` : `[[${name}]]`);
  }
  for (const k of pairs) lines.push(`${formatKey(k)} = ${formatValue(table[k], path.concat(k))}`);
  for (const k of subs) {
    const v = table[k];
    const sub = path.concat(k);
    if (isTable(v)) writeTable(lines, sub, v, "table");
    else for (const element of v as Table[]) writeTable(lines, sub, element, "array");
  }
}

/** A value that becomes its own section: an object, or a non-empty array holding only objects. */
function isSubTable(v: unknown): boolean {
  return isTable(v) || isArrayOfTables(v);
}

function isArrayOfTables(v: unknown): v is Table[] {
  return Array.isArray(v) && v.length > 0 && v.every(isTable);
}

function formatValue(v: unknown, where: string[]): string {
  switch (typeof v) {
    case "string":
      return v.includes("\n") ? formatMultilineString(v, where) : formatBasicString(v, where);
    case "number":
      return formatNumber(v);
    case "boolean":
      return v ? "true" : "false";
    case "object":
      if (Array.isArray(v)) return `[${v.map((item, i) => formatValue(item, where.concat(String(i)))).join(", ")}]`;
      if (v !== null) {
        const keys = Object.keys(v as Table).sort();
        if (keys.length === 0) return "{}";
        return `{ ${keys.map((k) => `${formatKey(k)} = ${formatValue((v as Table)[k], where.concat(k))}`).join(", ")} }`;
      }
    // falls through
    default:
      throw new TypeError(`cannot write a ${v === null ? "null" : typeof v} at \`${joinPath(where)}\``);
  }
}

function formatNumber(n: number): string {
  if (Number.isSafeInteger(n)) return String(n);
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  const s = String(n);
  // A float that JS prints without a point or exponent would read back as an integer; keep it a float.
  return /[.e]/.test(s) ? s : `${s}.0`;
}

function formatKey(k: string): string {
  return BARE_KEY_WHOLE.test(k) ? k : formatBasicString(k, [k]);
}

function formatBasicString(s: string, where: string[]): string {
  return `"${escapeString(s, false, where)}"`;
}

/** The opening delimiter's newline is trimmed by every reader, so the text starts on its own line. */
function formatMultilineString(s: string, where: string[]): string {
  return `"""\n${escapeString(s, true, where)}"""`;
}

function escapeString(s: string, multiline: boolean, where: string[]): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    const code = s.charCodeAt(i);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += multiline ? "\n" : "\\n";
    else if (ch === "\t") out += multiline ? "\t" : "\\t";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      out += ch + (s[i + 1] as string);
      i++;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // TOML text is Unicode; a lone surrogate has no spelling in it.
      throw new TypeError(`unpaired surrogate U+${code.toString(16).toUpperCase()} in the string at \`${joinPath(where)}\``);
    } else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------- shared

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(t: Table, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(t, key) ? t[key] : undefined;
}

/** A plain assignment would treat `__proto__` as the prototype; a defined property never does. */
function define(t: Table, key: string, value: unknown): void {
  Object.defineProperty(t, key, { value, writable: true, enumerable: true, configurable: true });
}

function joinPath(path: string[]): string {
  return path.map((p) => (BARE_KEY_WHOLE.test(p) ? p : JSON.stringify(p))).join(".");
}

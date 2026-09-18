import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, stringify, TomlError } from "../src/toml.js";

/** Asserts a parse fails as a TomlError on the given line, with the message naming what went wrong. */
function fails(text: string, line: number, message: RegExp): void {
  assert.throws(
    () => parse(text),
    (err: unknown) => {
      assert.ok(err instanceof TomlError, `expected a TomlError, got ${String(err)}`);
      assert.equal(err.line, line, `line of: ${err.message}`);
      assert.match(err.message, message);
      assert.match(err.message, new RegExp(`at line ${line}$`));
      return true;
    },
  );
}

/** The whole point of a canonical writer: what it writes reads back equal, and writes again identically. */
function roundTrips(doc: Record<string, unknown>): string {
  const text = stringify(doc);
  const back = parse(text);
  assert.deepEqual(back, doc);
  assert.equal(stringify(back), text, "byte-stable");
  return text;
}

// ------------------------------------------------------------ keys

test("keys: bare, quoted, dotted, and whitespace around dots", () => {
  const doc = parse(`
bare = 1
bare-key_2 = 2
1234 = 3
"quoted key" = 4
'literal key' = 5
"" = 6
a.b.c = 7
d . e = 8
"f.g".h = 9
`);
  assert.deepEqual(doc, {
    bare: 1,
    "bare-key_2": 2,
    "1234": 3,
    "quoted key": 4,
    "literal key": 5,
    "": 6,
    a: { b: { c: 7 } },
    d: { e: 8 },
    "f.g": { h: 9 },
  });
});

test("keys: dotted keys extend the table they made, across statements", () => {
  const doc = parse(`
fruit.apple.color = "red"
fruit.apple.taste.sweet = true
fruit.orange = 1
`);
  assert.deepEqual(doc, { fruit: { apple: { color: "red", taste: { sweet: true } }, orange: 1 } });
});

test("keys: a key named __proto__ is an ordinary key", () => {
  const doc = parse(`__proto__ = 1\n[x.__proto__]\ny = 2\n`);
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.deepEqual(Object.keys(doc), ["__proto__", "x"]);
  assert.equal((doc as Record<string, unknown>)["__proto__"], 1);
});

// ------------------------------------------------------------ strings

test("strings: basic with every escape", () => {
  const doc = parse(String.raw`s = "tab\t nl\n cr\r bs\b ff\f quote\" back\\ u\u00E9 U\U0001F389"`);
  assert.deepEqual(doc, { s: 'tab\t nl\n cr\r bs\b ff\f quote" back\\ ué U🎉' });
});

test("strings: literal keeps backslashes and quotes as they are", () => {
  const doc = parse(String.raw`s = 'C:\Users\nobody and a "quote"'`);
  assert.deepEqual(doc, { s: 'C:\\Users\\nobody and a "quote"' });
});

test("strings: multi-line basic trims the first newline, keeps the rest, and honours escapes", () => {
  const doc = parse('s = """\nRoses are red\nViolets are blue\\tend\\u0041\\n"""');
  assert.deepEqual(doc, { s: "Roses are red\nViolets are blue\tendA\n" });
});

test("strings: multi-line basic with the line-ending backslash", () => {
  const doc = parse(`s = """\\
    The quick brown \\
    fox jumps over \\
       the lazy dog."""
t = """
The quick brown \\


  fox."""`);
  assert.deepEqual(doc, { s: "The quick brown fox jumps over the lazy dog.", t: "The quick brown fox." });
});

test("strings: quotes against the closing delimiter of a multi-line string", () => {
  assert.deepEqual(parse('a = """Here are two quotation marks: "". Simple enough."""'), {
    a: 'Here are two quotation marks: "". Simple enough.',
  });
  assert.deepEqual(parse('a = """Here are three quotation marks: ""\\"."""'), {
    a: 'Here are three quotation marks: """.',
  });
  assert.deepEqual(parse('a = """"This," she said, "is just a pointless statement.""""'), {
    a: '"This," she said, "is just a pointless statement."',
  });
  assert.deepEqual(parse('a = """two at the end: """""'), { a: 'two at the end: ""' });
  assert.deepEqual(parse("a = '''two at the end: '''''"), { a: "two at the end: ''" });
});

test("strings: multi-line literal keeps everything, CRLF becomes LF", () => {
  const doc = parse("s = '''\r\nThe first newline is\r\ntrimmed. \\n stays. ''quotes''\r\n'''");
  assert.deepEqual(doc, { s: "The first newline is\ntrimmed. \\n stays. ''quotes''\n" });
});

test("strings: unicode in bare text", () => {
  assert.deepEqual(parse('s = "ünïcödé 日本語 🎉"'), { s: "ünïcödé 日本語 🎉" });
});

// ------------------------------------------------------------ numbers and booleans

test("numbers: integers in every base, with underscores", () => {
  const doc = parse(`
plus = +99
zero = 0
neg = -17
under = 1_000_000
hex = 0xDEAD_beef
oct = 0o755
bin = 0b1101_0110
`);
  assert.deepEqual(doc, { plus: 99, zero: 0, neg: -17, under: 1000000, hex: 0xdeadbeef, oct: 0o755, bin: 0b11010110 });
});

test("numbers: floats with fractions, exponents, inf and nan", () => {
  const doc = parse(`
a = +1.0
b = 3.1415
c = -0.01
d = 5e+22
e = 1e06
f = -2E-2
g = 6.626e-34
h = 224_617.445_991_228
i1 = inf
i2 = +inf
i3 = -inf
n1 = nan
n2 = -nan
`);
  assert.equal(doc.a, 1);
  assert.equal(doc.b, 3.1415);
  assert.equal(doc.c, -0.01);
  assert.equal(doc.d, 5e22);
  assert.equal(doc.e, 1e6);
  assert.equal(doc.f, -0.02);
  assert.equal(doc.g, 6.626e-34);
  assert.equal(doc.h, 224617.445991228);
  assert.equal(doc.i1, Infinity);
  assert.equal(doc.i2, Infinity);
  assert.equal(doc.i3, -Infinity);
  assert.ok(Number.isNaN(doc.n1));
  assert.ok(Number.isNaN(doc.n2));
});

test("numbers: leading zeros and stray underscores are refused", () => {
  fails("a = 007", 1, /invalid value `007`/);
  fails("a = 1__0", 1, /invalid value/);
  fails("a = _1", 1, /invalid value/);
  fails("a = 1_", 1, /invalid value/);
  fails("a = 0x", 1, /invalid value/);
  fails("a = .5", 1, /invalid value/);
  fails("a = 5.", 1, /invalid value/);
});

test("booleans", () => {
  assert.deepEqual(parse("t = true\nf = false"), { t: true, f: false });
  fails("t = True", 1, /invalid value `True`/);
});

// ------------------------------------------------------------ datetimes

test("datetimes are kept as the string they were written as", () => {
  const doc = parse(`
odt1 = 1979-05-27T07:32:00Z
odt2 = 1979-05-27T00:32:00-07:00
odt3 = 1979-05-27T00:32:00.999999-07:00
odt4 = 1979-05-27 07:32:00Z
ldt = 1979-05-27T07:32:00
ld = 1979-05-27
lt = 07:32:00.5
`);
  assert.deepEqual(doc, {
    odt1: "1979-05-27T07:32:00Z",
    odt2: "1979-05-27T00:32:00-07:00",
    odt3: "1979-05-27T00:32:00.999999-07:00",
    odt4: "1979-05-27 07:32:00Z",
    ldt: "1979-05-27T07:32:00",
    ld: "1979-05-27",
    lt: "07:32:00.5",
  });
});

// ------------------------------------------------------------ arrays and inline tables

test("arrays: multi-line, trailing comma, comments inside, mixed and nested", () => {
  const doc = parse(`
ints = [ 1, 2, 3 ]
empty = []
nested = [ [ 1, 2 ], ["a", "b", "c"] ]
mixed = [ 0.1, 0.2, "x", true, { y = 1 } ]
multi = [
  1,   # one
  2,   # two
  # a comment line
  3,
]
strings = [ "all", 'strings', """are the same""", '''type''' ]
`);
  assert.deepEqual(doc, {
    ints: [1, 2, 3],
    empty: [],
    nested: [
      [1, 2],
      ["a", "b", "c"],
    ],
    mixed: [0.1, 0.2, "x", true, { y: 1 }],
    multi: [1, 2, 3],
    strings: ["all", "strings", "are the same", "type"],
  });
});

test("arrays: an unterminated array names its first line", () => {
  fails("a = [\n  1,\n  2,\n", 1, /unterminated array/);
  fails("a = [1 2]", 1, /expected `,` or `]`/);
});

test("inline tables: nested, dotted keys inside, empty", () => {
  const doc = parse(`
name = { first = "Tom", last = "Preston-Werner" }
point = { x = 1, y = 2 }
animal = { type.name = "pug" }
empty = {}
deep = { a = { b = { c = [1, { d = 2 }] } } }
`);
  assert.deepEqual(doc, {
    name: { first: "Tom", last: "Preston-Werner" },
    point: { x: 1, y: 2 },
    animal: { type: { name: "pug" } },
    empty: {},
    deep: { a: { b: { c: [1, { d: 2 }] } } },
  });
});

test("inline tables: no trailing comma, no newlines", () => {
  fails("a = { x = 1, }", 1, /cannot end with a comma/);
  fails("a = { x = 1,\n y = 2 }", 1, /one line/);
  fails("a = {\n}", 1, /one line/);
});

// ------------------------------------------------------------ tables

test("tables: headers, nested headers, dotted headers, out-of-order definition", () => {
  const doc = parse(`
top = 1

[table]
key = "value"

[table.sub]
key = "sub"

[ dog . "tater.man" ]
type.name = "pug"

[x.y.z.w]
[x]
extra = 1

[fruit]
apple.color = "red"
apple.taste.sweet = true

[fruit.apple.texture]
smooth = true
`);
  assert.deepEqual(doc, {
    top: 1,
    table: { key: "value", sub: { key: "sub" } },
    dog: { "tater.man": { type: { name: "pug" } } },
    x: { y: { z: { w: {} } }, extra: 1 },
    fruit: { apple: { color: "red", taste: { sweet: true }, texture: { smooth: true } } },
  });
});

test("arrays of tables: elements, nested arrays of tables, sub-tables of the last element", () => {
  const doc = parse(`
[[products]]
name = "Hammer"
sku = 738594937

[[products]]  # empty

[[products]]
name = "Nail"
sku = 284758393
color = "gray"

[[fruits]]
name = "apple"

[fruits.physical]
color = "red"
shape = "round"

[[fruits.varieties]]
name = "red delicious"

[[fruits.varieties]]
name = "granny smith"

[[fruits]]
name = "banana"

[[fruits.varieties]]
name = "plantain"
`);
  assert.deepEqual(doc, {
    products: [{ name: "Hammer", sku: 738594937 }, {}, { name: "Nail", sku: 284758393, color: "gray" }],
    fruits: [
      {
        name: "apple",
        physical: { color: "red", shape: "round" },
        varieties: [{ name: "red delicious" }, { name: "granny smith" }],
      },
      { name: "banana", varieties: [{ name: "plantain" }] },
    ],
  });
});

test("comments: everywhere they may appear", () => {
  const doc = parse(`# at the top
# and again
key = "value" # after a value
  # indented
[table] # after a header
   x = 1 # here too
arr = [ # inside an array
  1, # one
] # after
[[items]] # after an array header
s = "a # inside a string is not a comment"
# at the end without a newline`);
  assert.deepEqual(doc, { key: "value", table: { x: 1, arr: [1] }, items: [{ s: "a # inside a string is not a comment" }] });
});

test("an empty document, a BOM, and CRLF line endings", () => {
  assert.deepEqual(parse(""), {});
  assert.deepEqual(parse("\n\n# only comments\n"), {});
  assert.deepEqual(parse("\uFEFFa = 1"), { a: 1 });
  assert.deepEqual(parse("a = 1\r\n[b]\r\nc = 2\r\n"), { a: 1, b: { c: 2 } });
});

// ------------------------------------------------------------ errors

test("errors: duplicate keys", () => {
  fails("a = 1\na = 2", 2, /duplicate key `a`/);
  fails("a = 1\na.b = 2", 2, /`a` already holds a value/);
  fails("[t]\nx = 1\n\n[t]\ny = 2", 4, /table `t` is already defined at line 1/);
  fails("a = { x = 1, x = 2 }", 1, /duplicate key `x`/);
  fails("[a]\nb = 1\n[a.b]\nc = 1", 3, /`a.b` already holds a value/);
});

test("errors: redefining tables", () => {
  fails("[[a]]\n[a]", 2, /`a` is an array, not a table/);
  fails("[a]\n[[a]]", 2, /`a` is a table, not an array of tables/);
  fails("a = [1]\n[[a]]", 2, /static array/);
  fails("a = [{ x = 1 }]\n[a.b]", 2, /static array/);
  fails("[fruit]\napple.color = 'red'\n[fruit.apple]", 3, /already defined by a dotted key at line 2/);
  fails("[a.b]\nz = 1\n[a]\nb.c = 2", 4, /`b` is a table defined at line 1 and cannot be extended by a dotted key/);
});

test("errors: an inline table is closed", () => {
  fails("t = { a = 1 }\n[t]", 2, /`t` is an inline table and cannot be extended/);
  fails("t = { a = 1 }\n[t.b]", 2, /`t` in `t.b` is an inline table/);
  fails("[x]\nt = { a = 1 }\nt.b = 2", 3, /`t` is an inline table and cannot be extended/);
});

test("errors: keys", () => {
  fails("my key = 1", 1, /expected `=` but found `k`/);
  fails("= 1", 1, /expected a key but found `=`/);
  fails("a =", 1, /expected a value but found end of input/);
  fails("a = 1 b = 2", 1, /unexpected `b` after the value/);
  fails("[a", 1, /expected `\]` but found end of input/);
  fails("[a]b = 1", 1, /unexpected `b` after the value/);
  fails("a.b. = 1", 1, /expected a key but found `=`/);
  fails("ünïcödé = 1", 1, /expected a key but found `ü`/);
});

test("errors: strings", () => {
  fails('a = "unterminated', 1, /unterminated string/);
  fails("a = 'unterminated\nb = 1", 1, /unterminated string/);
  fails('\n\na = """\nnever\ncloses', 3, /unterminated multi-line string/);
  fails('a = "bad \\x escape"', 1, /invalid escape `\\x`/);
  fails('a = "\\u12"', 1, /\\u needs 4 hex digits/);
  fails('a = "\\uD800"', 1, /not a Unicode scalar value/);
  fails('a = "\\U00110000"', 1, /not a Unicode scalar value/);
  fails('a = "control \u0001 char"', 1, /control character U\+0001/);
  fails('a = """\nline\\ \nno newline after the backslash: "" x\\  y"""', 3, /line-ending backslash/);
  fails("a = 'a\rb'", 1, /unterminated string/);
});

test("errors: the error is a SyntaxError carrying its line", () => {
  try {
    parse("ok = 1\nbad");
    assert.fail("did not throw");
  } catch (err) {
    assert.ok(err instanceof SyntaxError);
    assert.ok(err instanceof TomlError);
    assert.equal(err.line, 2);
    assert.equal(err.name, "TomlError");
  }
});

// ------------------------------------------------------------ writer

test("writer: layout, sorting, quoting, and value spellings", () => {
  const text = stringify({
    z: "last scalar",
    a: 1,
    "needs quotes": 'with "quote" and \\ and \ttab',
    multi: "line one\nline \"two\"\n\ttabbed\\",
    n: { negative: -1, float: 2.5, big: 1e21, tiny: 5e-324, huge: 9007199254740992, e: 1.5e-7 },
    b: { t: true, f: false },
    list: [1, "two", [3, 4], { k: "v" }, {}],
    empty: [],
    emptyTable: {},
    rows: [{ b: 2, a: 1 }, { c: { d: [{ e: 1 }] } }],
  });
  assert.equal(
    text,
    [
      "a = 1",
      "empty = []",
      'list = [1, "two", [3, 4], { k = "v" }, {}]',
      'multi = """',
      "line one",
      'line \\"two\\"',
      "\ttabbed\\\\\"\"\"",
      '"needs quotes" = "with \\"quote\\" and \\\\ and \\ttab"',
      'z = "last scalar"',
      "",
      "[b]",
      "f = false",
      "t = true",
      "",
      "[emptyTable]",
      "",
      "[n]",
      "big = 1e+21",
      "e = 1.5e-7",
      "float = 2.5",
      "huge = 9007199254740992.0",
      "negative = -1",
      "tiny = 5e-324",
      "",
      "[[rows]]",
      "a = 1",
      "b = 2",
      "",
      "[[rows]]",
      "",
      "[rows.c]",
      "",
      "[[rows.c.d]]",
      "e = 1",
      "",
    ].join("\n"),
  );
});

test("writer: a nested [[rows.c.d]] belongs to the element it follows", () => {
  const doc = { rows: [{ a: 1 }, { c: { d: [{ e: 1 }] } }, { a: 3 }] };
  assert.deepEqual(parse(stringify(doc)), doc);
});

test("writer: what a document may not hold", () => {
  assert.throws(() => stringify({ a: null } as unknown as Record<string, unknown>), /cannot write a null at `a`/);
  assert.throws(() => stringify({ a: [1, undefined] } as unknown as Record<string, unknown>), /cannot write a undefined at `a.1`/);
  assert.throws(() => stringify({ a: { b: () => 1 } } as unknown as Record<string, unknown>), /cannot write a function at `a.b`/);
  assert.throws(() => stringify({ a: "lone \ud800 surrogate" }), /unpaired surrogate U\+D800 in the string at `a`/);
  assert.throws(() => stringify([] as unknown as Record<string, unknown>), /a TOML document is an object/);
});

test("writer: control characters, DEL, and a key with a newline", () => {
  const doc = { "k\ney": "\u0000\u001f\u007f", m: "a\n\u0000b" };
  const text = roundTrips(doc);
  assert.equal(text, '"k\\ney" = "\\u0000\\u001F\\u007F"\nm = """\na\n\\u0000b"""\n');
});

// ------------------------------------------------------------ round-trips of the records the host keeps

test("round-trip: a users record", () => {
  roundTrips({ id: "alice", role: "admin", status: "active", createdAt: "2026-09-13T10:03:00.000Z" });
});

test("round-trip: an auth record with hex-keyed tokens", () => {
  const tokens: Record<string, { user: string; createdAt: string }> = {};
  for (let i = 0; i < 8; i++) {
    tokens[(0xdeadbeef + i * 7919).toString(16).padStart(16, "0")] = { user: i % 2 ? "alice" : "bob", createdAt: `2026-09-1${i}T00:00:00Z` };
  }
  const text = roundTrips({ hash: "a".repeat(64), salt: "0123456789abcdef", tokens });
  assert.match(text, /^\[tokens\.00000000deadbeef\]$/m);
});

test("round-trip: a registry record", () => {
  roundTrips({
    name: "@thetis/exa",
    version: "0.3.1",
    type: "tools",
    owner: "system",
    source: { kind: "git", ref: "https://github.com/thetis-agent/packages#exa" },
    userspaces: ["alice", "bob", "system"],
    forkedFrom: { name: "@bitmuse/exa", version: "0.2.0" },
  });
});

test("round-trip: a session with a 200-message conversation", () => {
  const messages: Record<string, unknown>[] = [];
  for (let i = 0; i < 200; i++) {
    const role = i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool";
    const content = [
      `Message ${i} says "hello" with a backslash \\ and a path C:\\tmp\\file.txt`,
      `  indented ünïcödé 日本語 🎉 and a tab\there`,
      i % 5 === 0 ? 'ends with quotes: """' : "trailing \\",
      "",
    ].join("\n");
    const msg: Record<string, unknown> = { role, content, index: i, ts: 1_726_000_000_000 + i * 1000.5 };
    if (role === "assistant" && i % 2 === 1) {
      msg.tool_calls = [
        { id: `call_${i}_a`, type: "function", function: { name: "files_read", arguments: JSON.stringify({ path: `/x/${i}.md`, lines: [1, i] }) } },
        { id: `call_${i}_b`, type: "function", function: { name: "plan", arguments: "{\"steps\":[\"one\",\"two\"]}" }, meta: { retries: 0, ok: true } },
      ];
    }
    if (role === "tool") msg.tool_call_id = `call_${i - 1}_a`;
    messages.push(msg);
  }
  const doc = {
    id: "s_7e99c96f2e0e",
    user: "alice",
    model: "anthropic/claude-sonnet-4",
    createdAt: "2026-09-14T12:36:00Z",
    usage: { input: 123456, output: 7890, cacheRead: 0, cost: 0.0421 },
    tags: [],
    conversation: messages,
  };
  const text = roundTrips(doc);
  assert.equal(text.match(/^\[\[conversation\]\]$/gm)?.length, 200);
  assert.equal(text.match(/^\[\[conversation\.tool_calls\]\]$/gm)?.length, 2 * 34);
});

// Formulas as text: the tokenizer, precedence in the parser, the references a formula holds, and the
// rewriters for fill, insert/delete, tab rename and tab delete — each keeping every character that is not
// a reference exactly as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropTabRefs, isFormula, parse, parseCached, refsOf, renameTabRefs, shiftRefs, tokenize, translate } from "../ui/core/formula.js";

const show = (n) => {
  switch (n.t) {
    case "num":
      return String(n.v);
    case "str":
      return JSON.stringify(n.v);
    case "bool":
      return n.v ? "TRUE" : "FALSE";
    case "err":
      return n.v;
    case "ref":
      return `${n.tab ? n.tab + "!" : ""}${n.kind}[${n.r1},${n.c1}:${n.r2},${n.c2}]`;
    case "name":
      return `name:${n.name}`;
    case "neg":
      return `(-${show(n.a)})`;
    case "pos":
      return `(+${show(n.a)})`;
    case "pct":
      return `(${show(n.a)}%)`;
    case "bin":
      return `(${show(n.a)} ${n.op} ${show(n.b)})`;
    case "range":
      return `(${show(n.a)}:${show(n.b)})`;
    case "fn":
      return `${n.name}(${n.args.map(show).join(", ")})`;
    case "empty":
      return "_";
  }
};
const p = (src) => show(parse(src));

test("tokenize reads every kind of token with its offsets", () => {
  const toks = tokenize(`SUM('My tab'!A1:B2, "a""b", 1.5e2, TRUE, #N/A) <> -$C$3%`);
  assert.deepEqual(
    toks.map((t) => t.type),
    ["func", "(", "ref", ",", "str", ",", "num", ",", "bool", ",", "err", ")", "op", "op", "ref", "op"],
  );
  const ref = toks[2];
  assert.equal(ref.tab, "My tab");
  assert.equal(ref.kind, "area");
  assert.equal(ref.text, "'My tab'!A1:B2");
  assert.equal(toks[4].value, 'a"b');
  assert.equal(toks[6].value, 150);
  assert.equal(toks[10].value, "#N/A");
  assert.deepEqual([toks[14].a.colAbs, toks[14].a.rowAbs], [true, true]);
  assert.throws(() => tokenize('"open'), SyntaxError);
  assert.throws(() => tokenize("1 ~ 2"), SyntaxError);
  assert.equal(tokenize('A1 + "open', { tolerant: true }).length, 2);
});

test("cells, functions and names are told apart: LOG10( is a function, TRUE a boolean, foo a name", () => {
  assert.equal(p("LOG10(100)"), "LOG10(100)");
  assert.equal(parse("log10").bad, true, "without ( it is cell LOG10, past column ZZ, so #REF! when evaluated");
  assert.equal(p("A1"), "cell[0,0:0,0]");
  assert.equal(p("a1"), "cell[0,0:0,0]");
  assert.equal(p("TRUE"), "TRUE");
  assert.equal(p("true()"), "TRUE()");
  assert.equal(p("foo"), "name:foo");
  assert.equal(p("ABCD1"), "name:ABCD1");
  assert.equal(p("Sheet1!B2"), "Sheet1!cell[1,1:1,1]");
  assert.equal(p("'It''s'!B2"), "It's!cell[1,1:1,1]");
  assert.equal(p("B:D"), "cols[0,1:19999,3]");
  assert.equal(p("$3:5"), "rows[2,0:4,701]");
  assert.equal(p("C3:A1"), "area[0,0:2,2]");
});

test("precedence is Excel's: unary minus before ^, % before ^, ^ left to right, & below +, comparisons last", () => {
  assert.equal(p("-2^2"), "((-2) ^ 2)");
  assert.equal(p("2^-2"), "(2 ^ (-2))");
  assert.equal(p("2^3^2"), "((2 ^ 3) ^ 2)");
  assert.equal(p("1+2*3"), "(1 + (2 * 3))");
  assert.equal(p("(1+2)*3"), "((1 + 2) * 3)");
  assert.equal(p("10-4-3"), "((10 - 4) - 3)");
  assert.equal(p("2*50%"), "(2 * (50%))");
  assert.equal(p("2^50%"), "(2 ^ (50%))");
  assert.equal(p("-50%"), "((-50)%)");
  assert.equal(p('1+2&"x"'), '((1 + 2) & "x")');
  assert.equal(p("1+2=3"), "((1 + 2) = 3)");
  assert.equal(p("A1<>B1"), "(cell[0,0:0,0] <> cell[0,1:0,1])");
  assert.equal(p("1<=2"), "(1 <= 2)");
  assert.equal(p("1--1"), "(1 - (-1))");
  assert.equal(p("+A1"), "(+cell[0,0:0,0])");
  assert.equal(p("A1:B2:C3"), "(area[0,0:1,1]:cell[2,2:2,2])");
  assert.equal(p("SUM(A1:INDEX(B:B,3))"), "SUM((cell[0,0:0,0]:INDEX(cols[0,1:19999,1], 3)))");
});

test("function calls: empty arguments, no arguments, nesting", () => {
  assert.equal(p("IF(A1,,2)"), "IF(cell[0,0:0,0], _, 2)");
  assert.equal(p("PI()"), "PI()");
  assert.equal(p("sum( 1 , 2 )"), "SUM(1, 2)");
  assert.equal(p("IF(AND(A1>0,B1<1),\"y\",\"n\")"), 'IF(AND((cell[0,0:0,0] > 0), (cell[0,1:0,1] < 1)), "y", "n")');
  for (const bad of ["SUM(1", "1+", "(1", "1)", ")", "SUM(1 2)", "", "1 2", "*3"]) assert.throws(() => parse(bad), SyntaxError, bad);
  assert.throws(() => parse("(".repeat(300) + "1" + ")".repeat(300)), /nested too deeply/);
});

test("parseCached answers the tree or the error, by formula text", () => {
  assert.ok(parseCached("=1+2").ast);
  assert.match(parseCached("=SUM(1").error, /not closed/);
  assert.equal(parseCached("=1+2"), parseCached("=1+2"));
  assert.ok(isFormula("=A1") && !isFormula("'=A1") && !isFormula(3));
});

test("refsOf gives each reference with its offsets in the formula, even while it is typed", () => {
  const f = "=SUM(A1:B2)+'My tab'!C3*$D$4";
  const refs = refsOf(f);
  assert.deepEqual(refs.map((r) => [r.tab, r.text, f.slice(r.start, r.end)]), [
    [null, "A1:B2", "A1:B2"],
    ["My tab", "'My tab'!C3", "'My tab'!C3"],
    [null, "$D$4", "$D$4"],
  ]);
  assert.deepEqual(refs[0].range, { r1: 0, c1: 0, r2: 1, c2: 1 });
  assert.deepEqual(refsOf("=A1+B").map((r) => r.text), ["A1"]);
  assert.deepEqual(refsOf('=A1&"B2').map((r) => r.text), ["A1"], "a string being typed hides nothing before it");
  assert.deepEqual(refsOf("A1+C:C").map((r) => [r.start, r.end]), [[0, 2], [3, 6]], "without = the offsets count from 0");
});

test("translate moves relative parts only and keeps everything else byte for byte", () => {
  assert.equal(translate("=A1+$B1+C$1+$D$1", 2, 1), "=B3+$B3+D$1+$D$1");
  assert.equal(translate("=SUM(a1:b2)", 1, 0), "=SUM(A2:B3)");
  assert.equal(translate('=IF( A1 > 0 , "A1 stays" ,Sheet2!B2 )', 1, 0), '=IF( A2 > 0 , "A1 stays" ,Sheet2!B3 )');
  assert.equal(translate("='My tab'!A1", 0, 2), "='My tab'!C1");
  assert.equal(translate("=SUM(B:B)", 5, 1), "=SUM(C:C)");
  assert.equal(translate("=SUM($B:B)", 5, 1), "=SUM($B:C)");
  assert.equal(translate("=SUM(3:4)", 2, 9), "=SUM(5:6)");
  assert.equal(translate("=A1+B2", -1, 0), "=#REF!+B1", "pushed off the top");
  assert.equal(translate("=Data!A1*2", 0, -1), "=#REF!*2");
  assert.equal(translate("=a1", 0, 0), "=a1");
  assert.equal(translate("=sum(a1)+lower(\"x\")", 0, 0), "=sum(a1)+lower(\"x\")");
  assert.equal(translate("=SUM(A1", 1, 0), "=SUM(A2", "a formula that does not parse still moves");
});

const rows = (formula, at, count, extra = {}) => shiftRefs(formula, { ownTab: "Sheet1", tab: "Sheet1", axis: "row", at, count, ...extra });
const cols = (formula, at, count, extra = {}) => shiftRefs(formula, { ownTab: "Sheet1", tab: "Sheet1", axis: "col", at, count, ...extra });

test("shiftRefs on inserted rows: references at or after the row move, ranges spanning it grow", () => {
  assert.equal(rows("=A1+A5+$A$5", 4, 2), "=A1+A7+$A$7", "absolute references move too");
  assert.equal(rows("=SUM(A2:A10)", 4, 2), "=SUM(A2:A12)");
  assert.equal(rows("=SUM(A2:A10)", 1, 2), "=SUM(A4:A12)", "inserting at the first row moves the whole range");
  assert.equal(rows("=SUM(A2:A10)", 10, 2), "=SUM(A2:A10)", "inserting just after leaves it");
  assert.equal(rows("=SUM(B:B)", 0, 5), "=SUM(B:B)", "whole columns stay");
  assert.equal(rows("=SUM(3:5)", 3, 1), "=SUM(3:6)");
  assert.equal(rows("=SUM(A10:A2)", 4, 2), "=SUM(A12:A2)", "a range written bottom-up keeps its orientation");
  assert.equal(rows(`=A19999`, 0, 5), "=#REF!", "pushed past the last row");
});

test("shiftRefs on deleted rows: inside becomes #REF!, partial overlaps shrink, later ones move up", () => {
  assert.equal(rows("=A3+A5+A8", 3, -3), "=A3+#REF!+A5");
  assert.equal(rows("=SUM(A2:A10)", 4, -3), "=SUM(A2:A7)", "a deletion inside the range");
  assert.equal(rows("=SUM(A5:A10)", 2, -4), "=SUM(A3:A6)", "a deletion over the range's top");
  assert.equal(rows("=SUM(A2:A5)", 3, -5), "=SUM(A2:A3)", "a deletion over the range's bottom");
  assert.equal(rows("=SUM(A4:A6)", 2, -5), "=SUM(#REF!)", "the whole range deleted");
  assert.equal(rows("=SUM(A4:A6)", 3, -3), "=SUM(#REF!)", "exactly the range");
  assert.equal(rows("=SUM(4:9)", 2, -3), "=SUM(3:6)");
  assert.equal(rows("=SUM(B:B)", 0, -5), "=SUM(B:B)");
});

test("shiftRefs on columns, and only for references into the changed tab", () => {
  assert.equal(cols("=B1+D1*$E$2", 2, 1), "=B1+E1*$F$2");
  assert.equal(cols("=SUM(B:D)", 2, -1), "=SUM(B:C)");
  assert.equal(cols("=SUM(A1:F1)", 1, -2), "=SUM(A1:D1)");
  assert.equal(cols("=SUM(3:3)", 0, 3), "=SUM(3:3)", "whole rows stay");
  assert.equal(cols("=C1", 2, -1), "=#REF!");
  assert.equal(rows("=A5+Data!A5", 0, 1), "=A6+Data!A5", "a reference into another tab stays");
  assert.equal(rows("=A5+Data!A5", 0, 1, { ownTab: "Data" }), "=A5+Data!A5", "the formula lives on Data; the change is on Sheet1");
  assert.equal(rows("=A5+sheet1!A5+'Sheet1'!A5", 0, 1, { ownTab: "Data" }), "=A5+sheet1!A6+'Sheet1'!A6", "tab names match without case, quoted or not");
  assert.equal(rows('=CONCAT( "A5", a5 ,  A$5)', 0, 1), '=CONCAT( "A5", A6 ,  A$6)', "spacing, strings and the case of untouched text stay");
});

test("renameTabRefs and dropTabRefs touch only references into that tab", () => {
  assert.equal(renameTabRefs("=Data!A1+data!B2:C3+Other!A1+A1", "Data", "My data"), "='My data'!A1+'My data'!B2:C3+Other!A1+A1");
  assert.equal(renameTabRefs("='My data'!$A$1", "my data", "Data2"), "=Data2!$A$1");
  assert.equal(renameTabRefs("=\"Data!A1\"&Data!A1", "Data", "D"), "=\"Data!A1\"&D!A1");
  assert.equal(renameTabRefs("=A1", "Data", "D"), "=A1");
  assert.equal(dropTabRefs("=SUM(Data!A:A)+'It''s'!B1+A1", "Data"), "=SUM(#REF!)+'It''s'!B1+A1");
  assert.equal(dropTabRefs("=SUM(Data!A:A)+'It''s'!B1+A1", "it's"), "=SUM(Data!A:A)+#REF!+A1");
});

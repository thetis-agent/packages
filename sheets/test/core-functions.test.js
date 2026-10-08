// The function library through the engine, with the answers Sheets and Excel give: aggregates and their
// coercions, criteria, lookups, logic, text, dates, finance, and the errors for unknown names and wrong
// argument counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../ui/core/engine.js";
import { FUNCTIONS } from "../ui/core/functions.js";
import { toSerial } from "../ui/core/dates.js";

const tab = (id, name, cells) => ({ id, name, rows: 1000, cols: 26, cells, styles: {}, widths: {}, heights: {}, freeze: { rows: 0, cols: 0 } });
const WB = {
  tabs: [
    tab("t1", "Data", {
      A1: "Name", B1: "Score", C1: "Dept", D1: "Joined",
      A2: "Ann", B2: 90, C2: "Ops", D2: toSerial(2020, 2, 29),
      A3: "Bob", B3: 75, C3: "Eng", D3: toSerial(2021, 6, 1),
      A4: "Cat", B4: 82, C4: "Eng", D4: toSerial(2022, 1, 10),
      A5: "Dan", B5: 75, C5: "Ops", D5: toSerial(2023, 3, 3),
      A6: "Eve", B6: 60, C6: "Eng", D6: toSerial(2024, 12, 24),
      F1: 0, G1: "F", F2: 60, G2: "D", F3: 70, G3: "C", F4: 80, G4: "B", F5: 90, G5: "A",
      H1: 90, H2: 80, H3: 70, H4: 60,
      J1: "x", K1: "y", L1: "z", J2: 1, K2: 2, L2: 3,
      M1: "=1/0", M2: "'42", N1: true,
    }),
    tab("t2", "My tab", { A1: 7, B1: "=Data!B2*2" }),
  ],
};
const NOW = new Date(2026, 9, 8, 15, 30, 0);
const ev = (f, at = {}) => evaluate(WB, "t1", f, { now: NOW, ...at });
const near = (actual, expected, digits = 2) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 10 ** -digits / 2, `${actual} ≈ ${expected}`);
const err = (f, code) => {
  const v = ev(f);
  assert.equal(v?.err, code, `${f} → ${JSON.stringify(v)}`);
  return v;
};

test("SUM and friends: numbers in ranges, text there skipped, direct text coerced, errors carried", () => {
  assert.equal(ev("=SUM(B2:B6)"), 382);
  assert.equal(ev("=SUM(B:B)"), 382, "the header text is skipped");
  assert.equal(ev('=SUM(1,"2",TRUE)'), 4);
  assert.equal(ev("=SUM(M2)"), 0, "text in a cell is not a number to SUM");
  err('=SUM("x")', "#VALUE!");
  err("=SUM(B2:B6,M1)", "#DIV/0!");
  assert.equal(ev("=AVERAGE(B2:B6)"), 76.4);
  err("=AVERAGE(A1:A6)", "#DIV/0!");
  assert.equal(ev("=MIN(B2:B6)"), 60);
  assert.equal(ev("=MAX(B2:B6, 100)"), 100);
  assert.equal(ev("=MAX(A1:A6)"), 0);
  assert.equal(ev("=COUNT(A1:B6)"), 5);
  assert.equal(ev("=COUNT(B2:B6,M1,\"3\",\"x\")"), 6, "COUNT skips errors and counts number-like text given directly");
  assert.equal(ev("=COUNTA(A1:B6)"), 12);
  assert.equal(ev("=COUNTA(M1:M3)"), 2);
  assert.equal(ev("=COUNTBLANK(E1:E3)"), 3);
  assert.equal(ev("=PRODUCT(2,3,4)"), 24);
});

test("statistics", () => {
  assert.equal(ev("=MEDIAN(1,2,3,4)"), 2.5);
  assert.equal(ev("=MEDIAN(B2:B6)"), 75);
  assert.equal(ev("=MODE(1,3,3,2,2)"), 3, "the first of the most frequent, in data order");
  err("=MODE(1,2,3)", "#N/A");
  near(ev("=STDEV(2,4,4,4,5,5,7,9)"), 2.13809, 5);
  assert.equal(ev("=STDEVP(2,4,4,4,5,5,7,9)"), 2);
  assert.equal(ev("=VARP(2,4,4,4,5,5,7,9)"), 4);
  near(ev("=VAR(1,2,3,4)"), 1.66667, 5);
  err("=STDEV(1)", "#DIV/0!");
  assert.equal(ev("=LARGE(B2:B6,2)"), 82);
  assert.equal(ev("=SMALL(B2:B6,1)"), 60);
  err("=LARGE(B2:B6,6)", "#NUM!");
  assert.equal(ev("=RANK(75,B2:B6)"), 3);
  assert.equal(ev("=RANK(75,B2:B6,1)"), 2);
  err("=RANK(76,B2:B6)", "#N/A");
});

test("criteria the way COUNTIF reads them", () => {
  assert.equal(ev('=COUNTIF(B2:B6,">=75")'), 4);
  assert.equal(ev("=COUNTIF(B2:B6,75)"), 2);
  assert.equal(ev('=COUNTIF(B2:B6,"75")'), 2);
  assert.equal(ev('=COUNTIF(B2:B6,"<>75")'), 3);
  assert.equal(ev('=COUNTIF(C2:C6,"eng")'), 3, "text matches without case");
  assert.equal(ev('=COUNTIF(A2:A6,"?a*")'), 2, "wildcards");
  assert.equal(ev('=COUNTIF(A2:A6,"<c")'), 2, "text compared as text");
  assert.equal(ev('=COUNTIF(E1:E10,"")'), 10, "blanks, even past the used cells");
  assert.equal(ev('=COUNTIF(A1:A6,"<>")'), 6);
  assert.equal(ev('=COUNTIF(A:A,"<>x")'), 1000, "a blank is not x, all the way down the column");
  assert.equal(ev("=COUNTIF(N1:N2,TRUE)"), 1);
  assert.equal(ev('=COUNTIF(D2:D6,">2022-01-01")'), 3, "a date in a criterion reads as its serial");
  assert.equal(ev('=COUNTIF(M1:M3,"#DIV/0!")'), 1);
  assert.equal(ev("=SUMIF(C2:C6,\"Eng\",B2:B6)"), 217);
  assert.equal(ev("=SUMIF(B2:B6,\">80\")"), 172);
  assert.equal(ev("=SUMIF(C2:C6,\"Eng\",B2)"), 217, "a one-cell sum range grows to the criteria range's shape");
  assert.equal(ev('=SUMIFS(B2:B6,C2:C6,"Ops",B2:B6,">80")'), 90);
  assert.equal(ev('=COUNTIFS(C2:C6,"Eng",B2:B6,"<80")'), 2);
  assert.equal(ev('=AVERAGEIF(C2:C6,"Ops",B2:B6)'), 82.5);
  assert.equal(ev('=AVERAGEIFS(B2:B6,C2:C6,"Eng",B2:B6,">70")'), 78.5);
  err('=AVERAGEIFS(B2:B6,C2:C6,"Sales")', "#DIV/0!");
  err('=SUMIFS(B2:B6,C2:C7,"Ops")', "#VALUE!");
});

test("lookups: VLOOKUP exact and approximate, HLOOKUP, MATCH's types, XLOOKUP's defaults, INDEX as a reference", () => {
  assert.equal(ev('=VLOOKUP("cat",A2:C6,2,FALSE)'), 82);
  assert.equal(ev('=VLOOKUP("d*",A2:C6,3,FALSE)'), "Ops");
  err('=VLOOKUP("Zed",A2:C6,2,FALSE)', "#N/A");
  err('=VLOOKUP("Ann",A2:C6,4,FALSE)', "#REF!");
  err('=VLOOKUP("Ann",A2:C6,0,FALSE)', "#VALUE!");
  assert.equal(ev("=VLOOKUP(85,F1:G5,2)"), "B", "approximate: the largest key not above");
  assert.equal(ev("=VLOOKUP(90,F1:G5,2,TRUE)"), "A");
  assert.equal(ev("=VLOOKUP(1000,F:G,2)"), "A", "whole columns stop at the used rows");
  err("=VLOOKUP(-1,F1:G5,2)", "#N/A");
  assert.equal(ev('=HLOOKUP("y",J1:L2,2,FALSE)'), 2);
  assert.equal(ev('=MATCH("Dan",A1:A6,0)'), 5);
  assert.equal(ev('=MATCH("e*",A1:A6,0)'), 6);
  assert.equal(ev("=MATCH(85,F1:F5)"), 4);
  assert.equal(ev("=MATCH(75,H1:H4,-1)"), 2, "-1: the smallest not below, in descending data");
  assert.equal(ev("=MATCH(2,J2:L2,0)"), 2);
  err("=MATCH(5,F1:F5,0)", "#N/A");
  err("=MATCH(1,F1:G5,0)", "#N/A");
  assert.equal(ev('=XLOOKUP("Eng",C2:C6,A2:A6)'), "Bob");
  assert.equal(ev('=XLOOKUP("Eng",C2:C6,A2:A6,,0,-1)'), "Eve", "searching from the end");
  assert.equal(ev('=XLOOKUP("Sales",C2:C6,A2:A6,"none")'), "none");
  err('=XLOOKUP("Sales",C2:C6,A2:A6)', "#N/A");
  assert.equal(ev("=XLOOKUP(85,F1:F5,G1:G5,,-1)"), "B", "exact or next smaller");
  assert.equal(ev("=XLOOKUP(85,F1:F5,G1:G5,,1)"), "A", "exact or next larger");
  assert.equal(ev('=XLOOKUP("c?t",A2:A6,B2:B6,,2)'), 82, "wildcard mode");
  assert.equal(ev('=SUM(XLOOKUP("Bob",A2:A6,B2:C6))'), 75, "a whole row comes back as a reference");
  assert.equal(ev("=INDEX(A1:C6,3,2)"), 75);
  assert.equal(ev("=INDEX(A2:A6,2)"), "Bob");
  assert.equal(ev("=INDEX(J2:L2,3)"), 3, "a one-row range takes the index as a column");
  assert.equal(ev("=SUM(INDEX(A1:C6,0,2))"), 382, "row 0 is the whole column");
  assert.equal(ev("=SUM(B2:INDEX(B2:B6,3))"), 247, "INDEX gives a reference a range can end at");
  err("=INDEX(A1:C6,7,1)", "#REF!");
  assert.equal(ev("=ROW()", { row: 4 }), 5);
  assert.equal(ev("=ROW(C5)"), 5);
  assert.equal(ev("=COLUMN(C5)"), 3);
  assert.equal(ev("=COLUMN()", { col: 3 }), 4);
  assert.equal(ev("=ROWS(A1:C6)"), 6);
  assert.equal(ev("=COLUMNS(A:C)"), 3);
  assert.equal(ev("=ROWS(A:A)"), 1000, "a whole column is as tall as the tab");
});

test("logic: IF does not evaluate the branch not taken; IFS, IFERROR, IFNA, AND/OR/XOR/NOT, SWITCH, CHOOSE", () => {
  assert.equal(ev("=IF(B2>80,\"high\",\"low\")"), "high");
  assert.equal(ev("=IF(FALSE,1)"), false);
  assert.equal(ev("=IF(TRUE,1,1/0)"), 1);
  assert.equal(ev("=IF(1,\"y\",\"n\")"), "y");
  err('=IF("maybe",1,2)', "#VALUE!");
  err("=IF(M1,1,2)", "#DIV/0!");
  assert.equal(ev("=IFS(B3>80,\"A\",B3>70,\"B\",TRUE,\"C\")"), "B");
  err("=IFS(FALSE,1)", "#N/A");
  assert.equal(ev('=IFERROR(1/0,"oops")'), "oops");
  assert.equal(ev('=IFERROR(5,"oops")'), 5);
  assert.equal(ev('=IFNA(NA(),"none")'), "none");
  err('=IFNA(1/0,"none")', "#DIV/0!");
  assert.equal(ev("=AND(TRUE,1,B2>0)"), true);
  assert.equal(ev("=AND(N1:N2)"), true, "blanks in ranges are skipped");
  assert.equal(ev("=OR(FALSE,0)"), false);
  assert.equal(ev("=XOR(TRUE,TRUE,TRUE)"), true);
  assert.equal(ev("=NOT(0)"), true);
  err("=AND(A1:A6)", "#VALUE!");
  assert.equal(ev('=SWITCH(C3,"Ops","O","Eng","E","?")'), "E");
  assert.equal(ev('=SWITCH(9,1,"a","dflt")'), "dflt");
  err('=SWITCH(9,1,"a")', "#N/A");
  assert.equal(ev('=CHOOSE(2,"a","b","c")'), "b");
  err('=CHOOSE(4,"a","b","c")', "#VALUE!");
  assert.equal(ev("=TRUE()"), true);
});

test("math: rounding half away from zero, sign conventions of MOD, CEILING and FLOOR", () => {
  assert.equal(ev("=ROUND(2.5,0)"), 3);
  assert.equal(ev("=ROUND(-2.5)"), -3);
  assert.equal(ev("=ROUND(1.005,2)"), 1.01);
  assert.equal(ev("=ROUND(1234.5678,-2)"), 1200);
  assert.equal(ev("=ROUNDUP(1.21,1)"), 1.3);
  assert.equal(ev("=ROUNDUP(-1.21,1)"), -1.3);
  assert.equal(ev("=ROUNDDOWN(-1.29,1)"), -1.2);
  assert.equal(ev("=INT(-1.5)"), -2);
  assert.equal(ev("=TRUNC(-1.5)"), -1);
  assert.equal(ev("=TRUNC(3.14159,2)"), 3.14);
  assert.equal(ev("=MOD(-3,2)"), 1);
  assert.equal(ev("=MOD(3,-2)"), -1);
  assert.equal(ev("=MOD(5.5,2)"), 1.5);
  err("=MOD(1,0)", "#DIV/0!");
  assert.equal(ev("=POWER(2,10)"), 1024);
  err("=SQRT(-1)", "#NUM!");
  assert.equal(ev("=CEILING(2.1,1)"), 3);
  assert.equal(ev("=CEILING(2.1)"), 3);
  assert.equal(ev("=CEILING(-2.5,2)"), -2);
  assert.equal(ev("=CEILING(-2.5,-2)"), -4);
  assert.equal(ev("=CEILING(4.3,0.5)"), 4.5);
  err("=CEILING(2.5,-2)", "#NUM!");
  assert.equal(ev("=FLOOR(2.7,1)"), 2);
  assert.equal(ev("=FLOOR(-2.5,2)"), -4);
  assert.equal(ev("=FLOOR(-2.5,-2)"), -2);
  assert.equal(ev("=LOG(8,2)"), 3);
  assert.equal(ev("=LOG(1000)"), 3);
  assert.equal(ev("=LOG10(0.01)"), -2);
  assert.equal(ev("=LN(EXP(2))"), 2);
  err("=LN(0)", "#NUM!");
  assert.equal(ev("=SIGN(-3)"), -1);
  assert.equal(ev("=ABS(-3)"), 3);
  assert.equal(ev("=PI()"), Math.PI);
  const r = ev("=RAND()");
  assert.ok(r >= 0 && r < 1);
  for (let k = 0; k < 20; k++) {
    const d = ev("=RANDBETWEEN(1,6)");
    assert.ok(Number.isInteger(d) && d >= 1 && d <= 6);
  }
});

test("text", () => {
  assert.equal(ev('=LEN("héllo")'), 5);
  assert.equal(ev("=LEN(B2)"), 2);
  assert.equal(ev('=LEFT("abc",2)'), "ab");
  assert.equal(ev('=LEFT("abc")'), "a");
  assert.equal(ev('=RIGHT("abc")'), "c");
  assert.equal(ev('=RIGHT("abc",5)'), "abc");
  assert.equal(ev('=MID("abcdef",2,3)'), "bcd");
  err('=MID("abc",0,1)', "#VALUE!");
  assert.equal(ev('=UPPER("aBc")'), "ABC");
  assert.equal(ev('=LOWER("aBc")'), "abc");
  assert.equal(ev('=PROPER("hello wORLD-wide")'), "Hello World-Wide");
  assert.equal(ev('=TRIM("  a   b  ")'), "a b");
  assert.equal(ev('=CONCAT(A2:A3,"!")'), "AnnBob!");
  assert.equal(ev('=CONCATENATE("a",1,TRUE)'), "a1TRUE");
  assert.equal(ev('=TEXTJOIN(", ",TRUE,A2:A4)'), "Ann, Bob, Cat");
  assert.equal(ev('=TEXTJOIN("-",FALSE,"a","","b")'), "a--b");
  assert.equal(ev('=TEXTJOIN("-",FALSE,M2:M4)'), "42--", "blanks inside the used rows count when not ignored");
  assert.equal(ev('=SUBSTITUTE("a-b-c","-","+")'), "a+b+c");
  assert.equal(ev('=SUBSTITUTE("a-b-c","-","+",2)'), "a-b+c");
  assert.equal(ev('=SUBSTITUTE("a-b-c","-","+",3)'), "a-b-c");
  assert.equal(ev('=REPLACE("abcdef",2,3,"X")'), "aXef");
  assert.equal(ev('=FIND("b","abcb")'), 2);
  assert.equal(ev('=FIND("b","abcb",3)'), 4);
  err('=FIND("B","abc")', "#VALUE!");
  assert.equal(ev('=SEARCH("B","abc")'), 2);
  assert.equal(ev('=SEARCH("c*","abcd")'), 3);
  assert.equal(ev('=TEXT(1234.5,"#,##0.00")'), "1,234.50");
  assert.equal(ev('=TEXT(DATE(2026,10,8),"dddd d mmm")'), "Thursday 8 Oct");
  assert.equal(ev('=TEXT(0.25,"0%")'), "25%");
  assert.equal(ev('=TEXT("0.5","0.00")'), "0.50", "number-like text is formatted as the number");
  err('=TEXT(1,"bogus")', "#VALUE!");
  assert.equal(ev('=VALUE("12%")'), 0.12);
  assert.equal(ev('=VALUE("1,234.5")'), 1234.5);
  assert.equal(ev('=VALUE("2026-10-08")'), 46303);
  err('=VALUE("abc")', "#VALUE!");
  assert.equal(ev('=REPT("ab",3)'), "ababab");
  assert.equal(ev('=EXACT("a","A")'), false);
  assert.equal(ev('=EXACT("a","a")'), true);
});

test("dates: DATE rolls over, parts, WEEKDAY and WEEKNUM types, EDATE/EOMONTH, DAYS, DATEDIF units, NETWORKDAYS", () => {
  assert.equal(ev("=DATE(2026,10,8)"), 46303);
  assert.equal(ev("=DATE(2026,14,1)"), toSerial(2027, 2, 1));
  assert.equal(ev("=DATE(2026,3,0)"), toSerial(2026, 2, 28));
  assert.equal(ev("=DATE(126,1,1)"), toSerial(2026, 1, 1), "a year below 1900 is added to 1900");
  assert.equal(ev("=YEAR(D2)"), 2020);
  assert.equal(ev("=MONTH(D2)"), 2);
  assert.equal(ev("=DAY(D2)"), 29);
  assert.equal(ev('=YEAR("2026-10-08")'), 2026, "date text is read as a date");
  assert.equal(ev("=HOUR(TIME(14,30,15))"), 14);
  assert.equal(ev("=MINUTE(TIME(14,30,15))"), 30);
  assert.equal(ev("=SECOND(TIME(14,30,15))"), 15);
  near(ev("=TIME(25,0,0)"), 1 / 24, 9);
  assert.equal(ev("=TODAY()"), 46303);
  near(ev("=NOW()"), 46303 + 15.5 / 24, 6);
  assert.equal(ev("=WEEKDAY(DATE(2026,10,8))"), 5);
  assert.equal(ev("=WEEKDAY(DATE(2026,10,8),2)"), 4);
  assert.equal(ev("=WEEKDAY(DATE(2026,10,8),3)"), 3);
  assert.equal(ev("=WEEKDAY(DATE(2026,10,8),16)"), 6);
  err("=WEEKDAY(1,9)", "#NUM!");
  assert.equal(ev("=WEEKNUM(DATE(2026,1,1))"), 1);
  assert.equal(ev("=WEEKNUM(DATE(2026,10,8))"), 41);
  assert.equal(ev("=WEEKNUM(DATE(2026,1,4))"), 2, "weeks start on Sunday by default");
  assert.equal(ev("=WEEKNUM(DATE(2026,1,4),2)"), 1, "type 2 starts weeks on Monday");
  assert.equal(ev("=WEEKNUM(DATE(2026,10,8),21)"), 41);
  assert.equal(ev("=WEEKNUM(DATE(2027,1,1),21)"), 53, "ISO: 1 January 2027 is in week 53 of 2026");
  assert.equal(ev("=EDATE(DATE(2026,1,31),1)"), toSerial(2026, 2, 28));
  assert.equal(ev("=EDATE(DATE(2026,1,31),-13)"), toSerial(2024, 12, 31));
  assert.equal(ev("=EOMONTH(DATE(2026,1,15),1)"), toSerial(2026, 2, 28));
  assert.equal(ev("=EOMONTH(DATE(2026,1,15),-1)"), toSerial(2025, 12, 31));
  assert.equal(ev("=DAYS(DATE(2026,12,25),DATE(2026,10,8))"), 78);
  assert.equal(ev('=DATEDIF(D2,DATE(2026,10,8),"Y")'), 6);
  assert.equal(ev('=DATEDIF(D2,DATE(2026,10,8),"M")'), 79);
  assert.equal(ev('=DATEDIF(D2,DATE(2026,10,8),"YM")'), 7);
  assert.equal(ev('=DATEDIF(D2,DATE(2026,10,8),"MD")'), 9);
  assert.equal(ev('=DATEDIF(D2,DATE(2026,10,8),"D")'), toSerial(2026, 10, 8) - toSerial(2020, 2, 29));
  assert.equal(ev('=DATEDIF(DATE(2025,11,15),DATE(2026,10,8),"YD")'), 327);
  assert.equal(ev('=DATEDIF(DATE(2026,1,1),DATE(2026,12,31),"y")'), 0);
  err('=DATEDIF(DATE(2026,1,2),DATE(2026,1,1),"D")', "#NUM!");
  err('=DATEDIF(1,2,"W")', "#NUM!");
  assert.equal(ev("=NETWORKDAYS(DATE(2026,10,1),DATE(2026,10,31))"), 22);
  assert.equal(ev("=NETWORKDAYS(DATE(2026,10,1),DATE(2026,10,31),DATE(2026,10,12))"), 21);
  assert.equal(ev("=NETWORKDAYS(DATE(2026,10,1),DATE(2026,10,31),DATE(2026,10,11))"), 22, "a holiday on a Sunday changes nothing");
  assert.equal(ev("=NETWORKDAYS(DATE(2026,10,31),DATE(2026,10,1))"), -22);
  assert.equal(ev("=NETWORKDAYS(DATE(2026,10,10),DATE(2026,10,11))"), 0);
});

test("finance: the PMT family's sign conventions", () => {
  near(ev("=PMT(0.05/12,360,200000)"), -1073.64);
  assert.equal(ev("=PMT(0,10,1000)"), -100);
  near(ev("=PMT(0.06/12,12,0,10000,1)"), -806.63);
  near(ev("=FV(0.06/12,120,-100)"), 16387.93);
  near(ev("=FV(0.06/12,10,-200,-500,1)"), 2581.40);
  near(ev("=PV(0.08/12,240,500)"), -59777.15);
  near(ev("=NPV(0.1,-10000,3000,4200,6800)"), 1188.44);
  near(ev("=NPV(0.08,J2:L2)"), 1 / 1.08 + 2 / 1.08 ** 2 + 3 / 1.08 ** 3, 9);
});

test("information functions see errors without passing them on", () => {
  assert.equal(ev("=ISBLANK(E1)"), true);
  assert.equal(ev('=ISBLANK("")'), false);
  assert.equal(ev("=ISNUMBER(B2)"), true);
  assert.equal(ev("=ISNUMBER(M2)"), false);
  assert.equal(ev("=ISTEXT(A2)"), true);
  assert.equal(ev("=ISLOGICAL(N1)"), true);
  assert.equal(ev("=ISERROR(M1)"), true);
  assert.equal(ev("=ISERROR(1)"), false);
  assert.equal(ev("=ISNA(NA())"), true);
  assert.equal(ev("=ISNA(M1)"), false);
});

test("unknown names and wrong argument counts", () => {
  assert.deepEqual(ev("=FOO(1)"), { err: "#NAME?", msg: "Unknown function FOO." });
  err("=foo", "#NAME?");
  const v = err("=ROUND()", "#N/A");
  assert.match(v.msg, /ROUND\(value, \[places\]\)/);
  err("=PI(1)", "#N/A");
  err("=IF()", "#N/A");
});

test("FUNCTIONS lists at least the contract's names, each with a signature", () => {
  const names = "SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS SUMIF SUMIFS AVERAGEIF AVERAGEIFS PRODUCT MEDIAN MODE STDEV STDEVP VAR VARP LARGE SMALL RANK ROUND ROUNDUP ROUNDDOWN INT TRUNC ABS MOD POWER SQRT EXP LN LOG LOG10 CEILING FLOOR SIGN PI RAND RANDBETWEEN IF IFS IFERROR IFNA AND OR NOT XOR SWITCH CHOOSE TRUE FALSE VLOOKUP HLOOKUP XLOOKUP INDEX MATCH ROW ROWS COLUMN COLUMNS LEN LEFT RIGHT MID UPPER LOWER PROPER TRIM CONCAT CONCATENATE TEXTJOIN SUBSTITUTE REPLACE FIND SEARCH TEXT VALUE REPT EXACT TODAY NOW DATE TIME YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY WEEKNUM EDATE EOMONTH DAYS DATEDIF NETWORKDAYS ISBLANK ISNUMBER ISTEXT ISERROR ISNA ISLOGICAL NA PMT FV PV NPV".split(" ");
  for (const n of names) {
    const f = FUNCTIONS[n];
    assert.ok(f, n);
    assert.equal(typeof f.fn, "function");
    assert.ok(f.help.startsWith(`${n}(`) && f.help.endsWith(")"), f.help);
    assert.ok(Number.isInteger(f.min) && f.max >= f.min, n);
  }
  assert.equal(FUNCTIONS.SUMIFS.min, 3);
  assert.equal(FUNCTIONS.COUNTIFS.min, 2);
  assert.equal(FUNCTIONS.IF.min, 1);
  assert.equal(FUNCTIONS.IF.max, 3);
  assert.equal(FUNCTIONS.SUM.max, 255);
});

test("SUMPRODUCT, MAXIFS, MINIFS, ISEVEN and ISODD", () => {
  const wb = { tabs: [tab("t1", "T", { A1: 2, A2: 3, A3: "x", B1: 10, B2: 20, B3: 30, C1: "a", C2: "b", C3: "a" })] };
  const v = (f) => evaluate(wb, "t1", f);
  assert.equal(v("SUMPRODUCT(A1:A3,B1:B3)"), 80);
  assert.equal(v("SUMPRODUCT(A:A,B:B)"), 80);
  assert.equal(v("SUMPRODUCT(A1:A2,B1:B3)").err, "#VALUE!");
  assert.equal(v('MAXIFS(B1:B3,C1:C3,"a")'), 30);
  assert.equal(v('MINIFS(B1:B3,C1:C3,"a")'), 10);
  assert.equal(v('MAXIFS(B1:B3,C1:C3,"z")'), 0);
  assert.equal(v("ISEVEN(4)"), true);
  assert.equal(v("ISODD(-3)"), true);
  assert.equal(v("ISEVEN(2.9)"), true);
});

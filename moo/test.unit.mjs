// Unit tests for the pure encoding/decoding logic. No network.
import assert from "node:assert/strict";
import {
  mooLiteral, mooObjectExpr, objectPathSegment, pathSegment, verbName, corifiedPath,
  decodeWireValue, decodeCaptured, compactWire, dynamicTools, bounded,
  objdefLinesLiteral, createClient,
} from "./client.js";

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

// --- MOO literal encoding: the injection boundary ---------------------------
t("literal escapes quotes and newlines", () => {
  assert.equal(mooLiteral('say "hi"\nnext'), '"say \\"hi\\"\\nnext"');
});
t("literal blocks code injection", () => {
  // The classic: a value that would close the string and start a statement.
  const evil = '"; recycle(#1); "';
  const out = mooLiteral(evil);
  assert.equal(out, '"\\"; recycle(#1); \\""');
  // The real property: every quote inside the literal is backslash-escaped, so
  // the string has exactly two *unescaped* quotes — its own delimiters — and
  // cannot close early. A naive substring check cannot tell an escaped quote
  // from a bare one, so remove the escape pairs first.
  const withoutEscapes = out.replace(/\\./g, "");
  assert.equal((withoutEscapes.match(/"/g) ?? []).length, 2, "the literal can be closed early");
});
t("literal handles list and map", () => {
  assert.equal(mooLiteral([1, "a"]), '{1, "a"}');
  assert.equal(mooLiteral({ k: 2 }), '["k" -> 2]');
});
t("literal refuses non-finite number", () => {
  assert.throws(() => mooLiteral(Infinity), /non-finite/);
});
t("null encodes as 0", () => assert.equal(mooLiteral(null), "0"));

// --- object references ------------------------------------------------------
t("object expr keeps #number", () => assert.equal(mooObjectExpr("#36"), "#36"));
t("object expr maps sysobj: to a $ reference", () => assert.equal(mooObjectExpr("sysobj:system"), "$system"));
t("object expr maps oid: to #number", () => assert.equal(mooObjectExpr("oid:36"), "#36"));
// toobj("uuid:...") evaluates to #0 in the VM; only the #-form parses.
t("object expr keeps a UUID id as toobj(\"#...\")", () => {
  assert.equal(mooObjectExpr("#001BB3-A0D9F77359"), 'toobj("#001BB3-A0D9F77359")');
  assert.equal(mooObjectExpr("uuid:001BB3-A0D9F77359"), 'toobj("#001BB3-A0D9F77359")');
});
t("object expr rejects rubbish", () => assert.throws(() => mooObjectExpr("#; recycle(#1)"), /must be a #number/));
// Corified references: `$you` is the expression the VM evaluates to that object.
t("object expr keeps a corified reference", () => assert.equal(mooObjectExpr("$you"), "$you"));
t("object expr keeps a dotted corified reference", () => assert.equal(mooObjectExpr(" $sys.utils "), "$sys.utils"));
t("object expr rejects a corified reference carrying code", () => {
  assert.throws(() => mooObjectExpr("$you; recycle(#1)"), /must be a #number/);
  assert.throws(() => mooObjectExpr("$you.recycle(#1)"), /must be a #number/);
  assert.throws(() => mooObjectExpr("$"), /must be a #number/);
  assert.throws(() => mooObjectExpr("$1abc"), /must be a #number/);
});
t("object expr rejects sysobj: carrying code", () => {
  assert.throws(() => mooObjectExpr("sysobj:you; recycle(#1)"), /must be a #number/);
});
t("object expr accepts the trailing dot mooR's to_curie writes", () => {
  assert.equal(mooObjectExpr("sysobj:system."), "$system");
});
t("corifiedPath parses and refuses", () => {
  assert.equal(corifiedPath("$you"), "you");
  assert.equal(corifiedPath("$a.b_c.d9"), "a.b_c.d9");
  assert.equal(corifiedPath("you"), undefined);
  assert.equal(corifiedPath("$a..b"), undefined);
  assert.equal(corifiedPath("$a.b."), undefined);
});
t("path segment maps a corified reference to sysobj:", () => {
  assert.equal(objectPathSegment("$you"), "sysobj:you");
  assert.equal(objectPathSegment("$sys.utils"), "sysobj:sys.utils");
});
t("path segment rejects a corified reference carrying code", () => {
  assert.throws(() => objectPathSegment("$you; x"), /must be #number/);
});
t("path segment maps #36 to oid:36", () => assert.equal(objectPathSegment("#36"), "oid:36"));
t("path segment maps a UUID id to uuid:", () => {
  assert.equal(objectPathSegment("#0011E5-9CB7359F34"), "uuid:0011E5-9CB7359F34");
});
t("path segment keeps negative oid", () => assert.equal(objectPathSegment("#-5"), "oid:-5"));
t("path segment escapes a verb name", () => assert.equal(pathSegment("foo bar/baz"), "foo%20bar%2Fbaz"));
t("verb name allows MOO wildcards", () => assert.equal(verbName("wield*ed?"), "wield*ed?"));
t("verb name rejects a paren", () => assert.throws(() => verbName("f()"), /unsafe/));

// --- Var decoding -----------------------------------------------------------
t("decodes scalars", () => {
  assert.equal(decodeWireValue({ variant: { VarInt: { value: 7 } } }), 7);
  assert.equal(decodeWireValue({ variant: { VarStr: { value: "s" } } }), "s");
  assert.equal(decodeWireValue({ variant: { VarNone: {} } }), null);
  assert.equal(decodeWireValue({ variant: { VarBool: { value: true } } }), true);
});
t("decodes an object ref to #id", () => {
  assert.equal(decodeWireValue({ variant: { VarObj: { obj: { ObjId: { id: 36 } } } } }), "#36");
});
t("decodes a list", () => {
  const v = { variant: { VarList: { elements: [{ variant: { VarInt: { value: 1 } } }, { variant: { VarInt: { value: 2 } } }] } } };
  assert.deepEqual(decodeWireValue(v), [1, 2]);
});
t("string-keyed map becomes an object", () => {
  const v = { variant: { VarMap: { pairs: [{ key: { variant: { VarStr: { value: "a" } } }, value: { variant: { VarInt: { value: 1 } } } }] } } };
  assert.deepEqual(decodeWireValue(v), { a: 1 });
});
t("non-string-keyed map keeps its keys as data", () => {
  const v = { variant: { VarMap: { pairs: [{ key: { variant: { VarInt: { value: 1 } } }, value: { variant: { VarStr: { value: "x" } } } }] } } };
  assert.deepEqual(decodeWireValue(v), [{ key: 1, value: "x" }]);
});
t("an unknown tag is preserved, not nulled", () => {
  const v = { variant: { VarFuture: { value: 1 } } };
  assert.deepEqual(decodeWireValue(v), v);
});

// --- captured envelopes: both wire shapes -----------------------------------
const res = (obj) => ({ ok: true, status: 200, text: JSON.stringify(obj) });

t("decodes a modern InvocationSuccess", () => {
  const r = decodeCaptured(res({ InvocationSuccess: { result: { variant: { VarInt: { value: 42 } } } } }), "/v1/eval");
  assert.equal(r.success, true);
  assert.equal(r.value, 42);
});
t("decodes a legacy EvalResult", () => {
  const r = decodeCaptured(res({ ReplyResult: { ClientSuccess: { EvalResult: { result: { variant: { VarStr: { value: "ok" } } } } } } }), "/v1/eval");
  assert.equal(r.success, true);
  assert.equal(r.value, "ok");
});
t("decodes an error envelope", () => {
  const r = decodeCaptured(res({ InvocationError: { TaskError: { message: "E_PERM" } } }), "/v1/eval");
  assert.equal(r.success, false);
  assert.ok(r.error);
});
t("flags a tick-limit abort as timed out", () => {
  const r = decodeCaptured(res({ InvocationError: { TaskAbortedLimit: { limit: "ticks" } } }), "/v1/eval");
  assert.equal(r.success, false);
  assert.equal(r.timed_out, true);
});
t("an unknown envelope is an error, not a silent success", () => {
  assert.throws(() => decodeCaptured(res({ Something: {} }), "/v1/eval"), /unrecognised/);
});
t("non-JSON body is reported as such", () => {
  assert.throws(() => decodeCaptured({ ok: true, status: 200, text: "<html>" }, "/v1/eval"), /did not return JSON/);
});

// --- wrapper stripping ------------------------------------------------------
t("compactWire strips unions to #36", () => {
  assert.equal(compactWire({ value: { reply: { ObjId: { id: 36 } } } }), "#36");
});
t("compactWire renders a UuObjId the way mooR does", () => {
  // autoincrement=1, rng=0, epoch=0x1234567890 -> first_group = (1<<6)|0 = 0x40
  const packed = (1n << 46n) | 0x1234567890n;
  assert.equal(compactWire({ UuObjId: { packed_value: packed.toString() } }), "#000040-1234567890");
});
t("compactWire keeps meaningful keys", () => {
  assert.deepEqual(compactWire({ name: { value: "x" }, count: 2 }), { name: "x", count: 2 });
});

// --- dynamic tools ----------------------------------------------------------
t("validates declared dynamic tools", () => {
  const list = [{ name: "a", description: "d", target_obj: "#1", target_verb: "v", input_schema: {} }];
  assert.deepEqual(dynamicTools(list), list);
});
t("rejects a dynamic tool missing a field", () => {
  assert.throws(() => dynamicTools([{ name: "a" }]), /missing/);
});

// --- output bounding --------------------------------------------------------
t("bounded keeps short text intact", () => assert.equal(bounded("hi", 100), "hi"));
t("bounded ends with the recovery note", () => {
  const out = bounded("x\n".repeat(50_000), 1000);
  assert.ok(out.length < 2000, "cut too large");
  assert.ok(out.trimEnd().endsWith("]"), "note did not survive the cut");
  assert.ok(out.includes("narrower slice"), "no recovery instruction");
});
t("objdef lines become a MOO list", () => {
  assert.equal(objdefLinesLiteral("a\nb"), '{"a", "b"}');
});

// --- config -----------------------------------------------------------------
t("missing credentials names the keys and the fix", () => {
  assert.throws(() => createClient({ config: {} }), /username. and .password/);
});
t("a bad base_url is refused", () => {
  assert.throws(() => createClient({ config: { base_url: "10.0.0.1:7892", username: "u", password: "p" } }), /must start with http/);
});
t("username without password is refused", () => {
  assert.throws(() => createClient({ config: { username: "u" } }), /together|no mooR credentials/);
});
t("a client builds from good config", () => {
  const c = createClient({ config: { base_url: "http://h:1/", username: "u", password: "p" } });
  assert.equal(c.baseUrl, "http://h:1");
});

console.log(`${pass} passed`);

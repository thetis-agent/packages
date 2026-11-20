// Unit tests for the pure encoding/decoding logic. No network.
import assert from "node:assert/strict";
import {
  mooLiteral, mooObjectExpr, objectPathSegment, pathSegment, verbName, corifiedPath,
  decodeWireValue, decodeCaptured, compactWire, dynamicTools, bounded,
  objdefLinesLiteral, createClient, parseJson, uuObjIdString, summarizeError, summarizeEvent,
  report, wireVarUnion,
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

// --- captured replies: InvocationResponse { outcome: TaskOutcome, output } ---
// Fixtures are shaped like replies captured from a live mooR web host at
// e52638608 (after f50464d59, "report how tasks ended and what they kept").
const res = (obj) => ({ ok: true, status: 200, text: JSON.stringify(obj) });
const outcome = (kept, ending, output = []) => res({ outcome: { kept, ending }, output });
const aborted = (kept, reason, output) => outcome(kept, { TaskAborted: { reason } }, output);
const ME = { variant: { VarObj: { obj: { obj: { UuObjId: { packed_value: "726231414815482758" } } } } } };
const str = (value) => ({ variant: { VarStr: { value } } });
const int = (value) => ({ variant: { VarInt: { value } } });
const exception = (err_type, msg, lines) => ({
  AbortedException: { exception: {
    error: { err_type, msg, value: null, custom_symbol: null },
    stack: [{ variant: { VarList: { elements: [ME, str("eval"), ME, { variant: { VarObj: { obj: { obj: { ObjId: { id: -1 } } } } } }, ME, int(1)] } } }],
    backtrace: lines.map(str),
  } },
});
const notifyEv = (text) => ({ event_id: { data: [1] }, timestamp: "1", author: ME, event: { event: { NotifyEvent: { value: str(text), content_type: null, no_flush: false, no_newline: false, metadata: null } } } });
const gmcpTraceback = { event_id: { data: [2] }, timestamp: "2", author: ME, event: { event: { DataEvent: { domain: { value: "gmcp" }, kind: { value: "Bug.Traceback" }, payload: { variant: { VarMap: { pairs: [] } } } } } } };

t("TaskCompleted is a success with its value, kept Yes", () => {
  // The exact reply observed live for `return {0,3,"x"};`.
  const r = decodeCaptured(outcome("Yes", { TaskCompleted: { result: { variant: { VarList: { elements: [int(0), int(3), str("x")] } } } } }), "/v1/eval");
  assert.equal(r.success, true);
  assert.deepEqual(r.value, [0, 3, "x"]);
  assert.equal(r.error, null);
  assert.equal(r.kept, "Yes");
  assert.equal(r.ending, "completed");
  assert.equal(r.timed_out, false);
  assert.equal(r.cancelled, false);
  assert.deepEqual(r.output, []);
});
t("a completed false is still a success", () => {
  const r = decodeCaptured(outcome("Yes", { TaskCompleted: { result: { variant: { VarBool: { value: false } } } } }, [notifyEv("hi")]), "/v1/command");
  assert.equal(r.success, true);
  assert.equal(r.value, false);
  assert.deepEqual(r.output, ["hi"]);
});
t("an uncaught exception is code, message and backtrace, kept Yes", () => {
  const r = decodeCaptured(
    aborted("Yes", exception("EDiv", "division by zero", ["builtin eval: E_DIV (division by zero)", "(End of traceback)"]), [notifyEv("before"), gmcpTraceback]),
    "/v1/eval",
  );
  assert.equal(r.success, false);
  assert.equal(r.ending, "aborted");
  assert.equal(r.reason, "exception");
  assert.equal(r.kept, "Yes");
  assert.deepEqual(r.error, {
    reason: "exception", code: "E_DIV", message: "division by zero",
    backtrace: ["builtin eval: E_DIV (division by zero)", "(End of traceback)"],
  });
  // The core's own traceback copy is dropped; the notify before it is kept.
  assert.deepEqual(r.output, ["before"]);
  assert.equal(r.timed_out, false);
});
t("a traceback data event is kept when the outcome is not an exception", () => {
  const r = decodeCaptured(outcome("Yes", { TaskCompleted: { result: int(1) } }, [gmcpTraceback]), "/v1/eval");
  assert.equal(r.output.length, 1);
});
t("E_VERBNF raised in eval is an exception", () => {
  const r = decodeCaptured(aborted("Yes", exception("EVerbnf", "Verb #0:nope not found", ["builtin eval: E_VERBNF (Verb #0:nope not found)", "(End of traceback)"])), "/v1/eval");
  assert.equal(r.error.code, "E_VERBNF");
  assert.equal(r.error.message, "Verb #0:nope not found");
});
t("AbortedVerbNotFound names the object and verb", () => {
  // The JSON key is `where_`: planus renames the keyword field and serde keeps it.
  const r = decodeCaptured(aborted("No", { AbortedVerbNotFound: { where_: { variant: { VarObj: { obj: { obj: { ObjId: { id: 0 } } } } } }, what: { value: "nope" } } }), "/v1/verbs/oid:0/nope/invoke");
  assert.equal(r.reason, "verb_not_found");
  assert.deepEqual(r.error, { reason: "verb_not_found", object: "#0", verb: "nope", message: "Verb not found: #0:nope" });
  assert.equal(r.kept, "No");
});
t("AbortedDeadline is a timeout and a cancellation, kept No", () => {
  // The exact reply observed live for a looping eval with timeout_ms=1500.
  const r = decodeCaptured(aborted("No", { AbortedDeadline: { deadline_nanos: 1500000000 } }), "/v1/eval?timeout_ms=1500");
  assert.equal(r.success, false);
  assert.equal(r.reason, "deadline");
  assert.equal(r.timed_out, true);
  assert.equal(r.cancelled, true);
  assert.equal(r.kept, "No");
  assert.equal(r.error.deadline_ms, 1500);
});
t("TaskResultLost at a deadline is a timeout that keeps kept as reported", () => {
  for (const kept of ["Yes", "Unknown"]) {
    const r = decodeCaptured(outcome(kept, { TaskResultLost: {} }), "/v1/eval");
    assert.equal(r.success, false);
    assert.equal(r.ending, "result_lost");
    assert.equal(r.timed_out, true);
    assert.equal(r.kept, kept);
  }
});
t("a tick limit is a timeout; an output limit is not", () => {
  const ticks = decodeCaptured(aborted("Yes", { AbortedLimit: { limit: { reason: "Ticks", ticks: 60000, time_nanos: 0, output_bytes: 0, output_events: 0 } } }), "/v1/eval");
  assert.equal(ticks.timed_out, true);
  assert.equal(ticks.error.limit, "ticks");
  assert.equal(ticks.error.ticks, 60000);
  assert.equal(ticks.kept, "Yes");
  const secs = decodeCaptured(aborted("Yes", { AbortedLimit: { limit: { reason: "Time", ticks: 0, time_nanos: 5000000000, output_bytes: 0, output_events: 0 } } }), "/v1/eval");
  assert.equal(secs.timed_out, true);
  assert.equal(secs.error.seconds, 5);
  const bytes = decodeCaptured(aborted("No", { AbortedLimit: { limit: { reason: "OutputBytes", ticks: 0, time_nanos: 0, output_bytes: 1024, output_events: 0 } } }), "/v1/eval");
  assert.equal(bytes.timed_out, false);
  assert.equal(bytes.error.limit, "output_bytes");
});
t("cancelled, killed, rolled back, conflicts and internal each say so", () => {
  const cases = [
    [{ AbortedCancelled: {} }, "cancelled", true],
    [{ AbortedKilled: {} }, "killed", false],
    [{ AbortedRolledBack: {} }, "rolled_back", false],
    [{ AbortedConflictRetriesExhausted: {} }, "conflict_retries_exhausted", false],
    [{ AbortedInternal: { message: "boom" } }, "internal", false],
  ];
  for (const [reason, name, cancelled] of cases) {
    const r = decodeCaptured(aborted("No", reason), "/v1/eval");
    assert.equal(r.reason, name);
    assert.equal(r.error.reason, name);
    assert.equal(r.cancelled, cancelled, name);
    assert.equal(r.timed_out, false, name);
    assert.ok(r.error.message.length > 5);
  }
  assert.match(decodeCaptured(aborted("No", { AbortedInternal: { message: "boom" } }), "/v1/eval").error.message, /boom/);
});
t("AbortedCommandFailed names the command error", () => {
  const r = decodeCaptured(aborted("No", { AbortedCommandFailed: { error: { error: { NoCommandMatch: {} } } } }), "/v1/command");
  assert.deepEqual(r.error, { reason: "command_failed", command_error: "NoCommandMatch", message: "Could not find verb match for command" });
});
t("an unknown abort reason keeps its name", () => {
  const r = decodeCaptured(aborted("Unknown", { AbortedSomethingNew: { x: 1 } }), "/v1/eval");
  assert.equal(r.error.reason, "AbortedSomethingNew");
  assert.equal(r.kept, "Unknown");
});
t("TaskSuspended is not a success and has no value", () => {
  const r = decodeCaptured(outcome("Yes", { TaskSuspended: {} }), "/v1/eval");
  assert.equal(r.success, false);
  assert.equal(r.ending, "suspended");
});
t("a missing or odd kept is read as Unknown, never Yes", () => {
  const r = decodeCaptured(res({ outcome: { ending: { TaskAborted: { reason: { AbortedCancelled: {} } } } }, output: [] }), "/v1/eval");
  assert.equal(r.kept, "Unknown");
});
t("an unknown ending is an error, not a silent success", () => {
  assert.throws(() => decodeCaptured(outcome("Yes", { TaskSomethingNew: {} }), "/v1/eval"), /unknown task ending/);
});
t("an old-host envelope is refused with the reason", () => {
  assert.throws(() => decodeCaptured(res({ InvocationSuccess: { result: int(1) } }), "/v1/eval"), /older than mooR f50464d59/);
  assert.throws(() => decodeCaptured(res({ Something: {} }), "/v1/eval"), /not an InvocationResponse/);
});
t("non-JSON body is reported as such", () => {
  assert.throws(() => decodeCaptured({ ok: true, status: 200, text: "<html>" }, "/v1/eval"), /did not return JSON/);
});

// --- refusals: an error status means no task ran -----------------------------
const refused = (status, body) => ({ ok: false, status, text: body === undefined ? "" : JSON.stringify(body) });
t("a 422 compilation_error is a failed result with line, column and message", () => {
  // The exact body observed live for `return (;`.
  const r = decodeCaptured(refused(422, {
    code: "compilation_error",
    compile_error: { ParseError: { context: "frontend parser", details: { expected_tokens: [], notes: [], span: [8, 9] }, end_line_col: [1, 9], error_position: { line_col: [1, 9] }, message: "expected expression after '('" } },
    error: "Failure to parse program @ 1/9:\nexpected expression after '('",
  }), "/v1/eval");
  assert.equal(r.success, false);
  assert.equal(r.ending, "not_run");
  assert.equal(r.kept, "No");
  assert.equal(r.reason, "compilation_error");
  assert.deepEqual(r.error, { reason: "compilation_error", kind: "ParseError", line: 1, column: 9, message: "expected expression after '('" });
});
t("a non-parse compile error keeps its whole message", () => {
  const r = decodeCaptured(refused(422, {
    code: "compilation_error",
    compile_error: { UnknownBuiltinFunction: [{ line_col: [1, 8] }, "frob"] },
    error: "Unknown built-in function @ 1/8: frob",
  }), "/v1/eval");
  assert.equal(r.error.kind, "UnknownBuiltinFunction");
  assert.equal(r.error.line, 1);
  assert.equal(r.error.column, 8);
  assert.equal(r.error.message, "Unknown built-in function @ 1/8: frob");
});
t("other refusals throw with the code and say no task ran", () => {
  assert.throws(() => decodeCaptured(refused(404, { code: "object_not_found", error: "Object not found" }), "/v1/eval"), /HTTP 404: object_not_found: Object not found\. No task ran/);
  assert.throws(() => decodeCaptured(refused(400), "/v1/verbs/x/y/invoke"), /HTTP 400 with no body: .*No task ran/);
  assert.throws(() => decodeCaptured(refused(503, { code: "daemon_unavailable", error: "The daemon is unavailable" }), "/v1/eval"), /could not reach its daemon/);
  assert.throws(() => decodeCaptured(refused(401, { code: "unauthorized", error: "Missing or invalid credentials" }), "/v1/eval"), /moo_reconnect/);
  // A 422 that is not a compile error is not mistaken for one.
  assert.throws(() => decodeCaptured(refused(422, { code: "other", error: "x" }), "/v1/eval"), /HTTP 422/);
});

// --- report(): kept is told truthfully --------------------------------------
const reported = (r) => JSON.parse(report(r));
t("report of a success carries no ending noise", () => {
  const out = reported(decodeCaptured(outcome("Yes", { TaskCompleted: { result: int(7) } }), "/v1/eval"));
  assert.deepEqual(out, { success: true, value: 7 });
});
t("report of a deadline with kept No says nothing committed", () => {
  const out = reported(decodeCaptured(aborted("No", { AbortedDeadline: { deadline_nanos: 1500000000 } }), "/v1/eval"));
  assert.equal(out.timed_out, true);
  assert.equal(out.kept, "No");
  assert.match(out.warning, /cancelled/);
  assert.match(out.warning, /NOT committed/);
  assert.doesNotMatch(out.warning, /WERE committed/);
});
t("report of a lost result with kept Yes says it committed", () => {
  const out = reported(decodeCaptured(outcome("Yes", { TaskResultLost: {} }), "/v1/eval"));
  assert.match(out.warning, /WERE committed/);
});
t("report of kept Unknown says to read state back", () => {
  const out = reported(decodeCaptured(outcome("Unknown", { TaskResultLost: {} }), "/v1/eval"));
  assert.match(out.warning, /unknown\. Read back/);
});
t("report of an exception says its changes stand", () => {
  const out = reported(decodeCaptured(aborted("Yes", exception("EDiv", "division by zero", [])), "/v1/eval"));
  assert.equal(out.kept, "Yes");
  assert.match(out.note, /WERE committed/);
  assert.equal(out.error.code, "E_DIV");
});
t("report of a compile error says nothing ran", () => {
  const out = reported(decodeCaptured(refused(422, { code: "compilation_error", compile_error: { ParseError: { error_position: { line_col: [2, 3] }, message: "m", details: {} } }, error: "e" }), "/v1/eval"));
  assert.equal(out.ending, "not_run");
  assert.match(out.note, /Nothing ran/);
});
t("report still copes with a result that has no kept (fakes, old callers)", () => {
  const out = reported({ success: false, timed_out: true, output: [] });
  assert.match(out.warning, /NOT a rollback/);
});

// --- invoke arguments --------------------------------------------------------
t("wireVarUnion encodes JSON values as mooR VarUnion", () => {
  assert.deepEqual(wireVarUnion(7), { VarInt: { value: 7 } });
  assert.deepEqual(wireVarUnion(1.5), { VarFloat: { value: 1.5 } });
  assert.deepEqual(wireVarUnion("#36"), { VarStr: { value: "#36" } });
  assert.deepEqual(wireVarUnion(true), { VarBool: { value: true } });
  assert.deepEqual(wireVarUnion(null), { VarInt: { value: 0 } });
  assert.deepEqual(wireVarUnion([1]), { VarList: { elements: [{ variant: { VarInt: { value: 1 } } }] } });
  assert.deepEqual(wireVarUnion({ a: 1 }), { VarMap: { pairs: [{ key: { variant: { VarStr: { value: "a" } } }, value: { variant: { VarInt: { value: 1 } } } }] } });
  const obj = { VarObj: { obj: { obj: { ObjId: { id: 36 } } } } };
  assert.deepEqual(wireVarUnion(obj), obj, "an already-tagged value passes through");
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

t("parseJson keeps a u64 exact", () => {
  // JSON.parse would round this to ...482800 and print #0A1417-9FC0CE6380.
  const v = parseJson('{"UuObjId":{"packed_value":726231414815482758}}');
  assert.equal(v.UuObjId.packed_value, "726231414815482758");
  assert.equal(compactWire(v), "#0A1417-9FC0CE6386");
  assert.equal(parseJson('{"a":1.5,"b":7}').b, 7);
});
t("uuObjIdString round-trips mooR's form", () => {
  assert.equal(uuObjIdString((0x0A1417n << 40n) | 0x9FC0CE6386n), "#0A1417-9FC0CE6386");
});
t("decodes a UUID object Var", () => {
  const v = { variant: { VarObj: { obj: { obj: { UuObjId: { packed_value: "726231414815482758" } } } } } };
  assert.equal(decodeWireValue(v), "#0A1417-9FC0CE6386");
});
t("an exception is reduced to code, message and backtrace", () => {
  const node = { exception: {
    error: { err_type: "EVerbnf", msg: "Verb not found: #1:x", value: null, custom_symbol: null },
    stack: [["#-1", "eval"]], backtrace: [{ variant: { VarStr: { value: "builtin eval: E_VERBNF" } } }, "(End of traceback)"] } };
  assert.deepEqual(summarizeError(node), { code: "E_VERBNF", message: "Verb not found: #1:x", backtrace: ["builtin eval: E_VERBNF", "(End of traceback)"] });
});
t("a custom error is named by its symbol; an error value is kept", () => {
  const node = { exception: { error: { err_type: "ErrCustom", msg: "m", value: { variant: { VarInt: { value: 3 } } }, custom_symbol: { value: "E_BOOM" } }, stack: [], backtrace: [] } };
  assert.deepEqual(summarizeError(node), { code: "E_BOOM", message: "m", value: 3, backtrace: [] });
});
t("an error that is not an exception keeps its variant name", () => {
  assert.deepEqual(summarizeError({ TaskError: { message: "E_PERM" } }), { TaskError: { message: "E_PERM" } });
});
t("a notify event becomes its text; a traceback event is dropped", () => {
  assert.equal(summarizeEvent({ event_id: {}, event: { event: { NotifyEvent: { value: "hello", content_type: null } } } }), "hello");
  assert.equal(summarizeEvent({ event: { event: { TracebackEvent: { exception: {} } } } }), undefined);
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

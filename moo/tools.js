// The moo_* tools. One module, one shared client.
//
// Every tool is wizard-authenticated: this group logs in as a single character
// and holds no authority of its own. The Rust ancestor kept a programmer login
// as the default and a wizard login for the privileged handful; this port was
// asked for the simpler shape, so there is one identity and no `wizard`
// argument anywhere. The consequence is worth stating plainly: there is no
// least-privilege here. Every tool runs with whatever the configured character
// can do, so what you give it decides the blast radius.
//
// The safety properties that survive from the original, because they are the
// ones that were learned the hard way:
//   * MOO source is *built* from literals, never interpolated from caller text.
//   * #0 is refused twice before a recycle, locally and inside the MOO task.
//   * A patch that does not apply performs no write.
//   * An objdef path is confined beneath one directory.
//   * A timeout is reported as "may have committed", never as a failure.

import {
  createClient, bounded, report, compactWire, mooLiteral, mooObjectExpr,
  objectPathSegment, pathSegment, verbName, dynamicTools, objdefLinesLiteral,
  OBJDEF_CONSTANTS_BUILDER, MAX_TIMEOUT_MS, clip,
} from "./client.js";
import path from "node:path";
import fs from "node:fs/promises";

// --- helpers ----------------------------------------------------------------

const need = (args, key) => {
  const v = args?.[key];
  if (v === undefined || v === null || v === "") throw new Error(`missing ${key}`);
  return v;
};

/** Run MOO source and report the captured outcome. */
async function evalSource(env, source, timeoutMs, extra) {
  const moo = createClient(env);
  const r = await moo.captured("/v1/eval", source, timeoutMs);
  return report(r, extra);
}

/** A JSON GET whose wrappers are stripped before the caller sees it. */
async function getCompact(env, p, extra = {}) {
  const moo = createClient(env);
  const res = await moo.authenticated("GET", p);
  if (!res.ok) throw new Error(`${p} returned HTTP ${res.status}: ${clip(res.text, 400)}`);
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new Error(`${p} did not return JSON: ${clip(res.text, 400)}`);
  }
  return bounded(JSON.stringify({ ...extra, ...(compactWire(body) ?? {}) }, null, 2));
}

// The objdef working directory, confined. Traversal and symlink escapes are
// rejected: the mooR MCP host takes a caller-supplied path with no sandbox at
// all, which its own skill calls out as the gap in its safety story. This is
// the part worth not copying.
const OBJDEF_ROOT = "workspace/torchship-objdef";

async function confinedObjdefPath(env, rel) {
  const r = String(rel ?? "");
  if (!r) throw new Error("missing path");
  if (path.isAbsolute(r)) throw new Error(`objdef path must be relative to ${OBJDEF_ROOT}`);
  for (const part of r.split(/[/\\]/)) {
    if (part === "." || part === ".." || part === "") {
      throw new Error("objdef path may not contain '.', '..', or an empty segment");
    }
  }
  // env.cwd is the userspace home. Falling back to process.cwd() would put the
  // root somewhere unpredictable, so refuse instead of guessing: this function
  // is a security boundary and a wrong root silently widens it.
  const home = env?.cwd;
  if (!home) throw new Error("cannot resolve the objdef root: env.cwd is not available");
  const root = path.resolve(home, OBJDEF_ROOT);
  const full = path.resolve(root, r);
  // resolve() collapses traversal; compare the result, not the input.
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("objdef path escapes its confined root");
  }
  // A symlink inside the root can still point out of it, and the path itself
  // then contains no traversal at all. Checking the target is not enough: on a
  // write the target usually does not exist yet, and the escape hides in a
  // symlinked *directory* along the way. So resolve the nearest existing
  // ancestor and require that to be inside the root too.
  const realRoot = await fs.realpath(root);
  const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);

  let existing = full;
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      if (!inside(real)) {
        throw new Error("objdef path resolves outside its confined root through a symlink");
      }
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const up = path.dirname(existing);
      if (up === existing) break; // reached the filesystem root
      existing = up;
    }
  }
  return full;
}

// ===========================================================================
// Execution
// ===========================================================================

export async function eval_(args, env) {
  return evalSource(env, String(need(args, "expression")), args.timeout_ms);
}

export async function command(args, env) {
  const moo = createClient(env);
  const line = String(need(args, "command"));
  let r;
  try {
    r = await moo.captured("/v1/command", line, args.timeout_ms);
  } catch (e) {
    if (/HTTP 404/.test(String(e.message))) {
      throw new Error(
        "this server does not expose /v1/command, so a parsed command cannot be run through it. " +
          "Use moo_eval, or moo_invoke_verb, instead.",
      );
    }
    throw e;
  }
  return report(r, {
    // The single most common wasted loop in this group.
    reminder:
      "Command output goes to the player's connection, not to this tool. Verify what the " +
      "command did by reading database state back, not by looking for printed text here.",
  });
}

export async function invokeVerb(args, env) {
  const obj = objectPathSegment(need(args, "object"));
  const verb = pathSegment(verbName(need(args, "verb")));
  const moo = createClient(env);
  const body = JSON.stringify(Array.isArray(args.args) ? args.args : []);
  const res = await moo.authenticated("POST", `/v1/verbs/${obj}/${verb}/invoke`, {
    contentType: "application/json",
    body,
  });
  const { decodeCaptured } = await import("./client.js");
  return report(decodeCaptured(res, "invoke"));
}

export async function dispatchCommandVerb(args, env) {
  const source =
    `return dispatch_command_verb(${mooObjectExpr(need(args, "player"))}, ` +
    `${mooLiteral(String(need(args, "command")))});`;
  return evalSource(env, source, args.timeout_ms);
}

// ===========================================================================
// Verbs
// ===========================================================================

export async function listVerbs(args, env) {
  const obj = objectPathSegment(need(args, "object"));
  const inherited = args.inherited ? "true" : "false";
  return getCompact(env, `/v1/verbs/${obj}?inherited=${inherited}`);
}

export async function getVerb(args, env) {
  const obj = objectPathSegment(need(args, "object"));
  const verb = pathSegment(verbName(need(args, "verb")));
  return getCompact(env, `/v1/verbs/${obj}/${verb}`);
}

export async function programVerb(args, env) {
  const obj = objectPathSegment(need(args, "object"));
  const verb = pathSegment(verbName(need(args, "verb")));
  const source = String(need(args, "source"));
  const moo = createClient(env);
  const res = await moo.authenticated("POST", `/v1/verbs/${obj}/${verb}`, {
    contentType: "text/plain; charset=utf-8",
    body: source,
  });
  if (!res.ok) throw new Error(`program returned HTTP ${res.status}: ${clip(res.text, 600)}`);
  return bounded(
    JSON.stringify(
      {
        success: true,
        bytes: source.length,
        note:
          "The verb compiled and was stored. That is not proof it behaves: a compile verdict " +
          "says the syntax is right. Verify by reading state back after a call.",
      },
      null,
      2,
    ),
  );
}

export async function applyPatchVerb(args, env) {
  const objRaw = need(args, "object");
  const verbRaw = need(args, "verb");
  const patchText = String(need(args, "patch"));
  const obj = objectPathSegment(objRaw);
  const verb = pathSegment(verbName(verbRaw));
  const moo = createClient(env);

  const current = await moo.authenticated("GET", `/v1/verbs/${obj}/${verb}`);
  if (!current.ok) throw new Error(`fetch returned HTTP ${current.status}: ${clip(current.text, 400)}`);
  let body;
  try {
    body = JSON.parse(current.text);
  } catch {
    throw new Error("verb fetch did not return JSON");
  }
  const source = findSource(body);
  if (source === undefined) throw new Error("verb response contained no source string");

  // A failed patch never writes. That is the whole point of the tool.
  const patched = applyUnifiedDiff(source, patchText);
  const res = await moo.authenticated("POST", `/v1/verbs/${obj}/${verb}`, {
    contentType: "text/plain; charset=utf-8",
    body: patched,
  });
  if (!res.ok) throw new Error(`program returned HTTP ${res.status}: ${clip(res.text, 600)}`);
  return bounded(JSON.stringify({ success: true, bytes: patched.length }, null, 2));
}

function findSource(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findSource(x);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (["source", "code", "program"].includes(k)) {
        if (typeof x === "string") return x;
        const r = findSource(x);
        if (r !== undefined) return r;
      }
    }
    for (const x of Object.values(v)) {
      const r = findSource(x);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/**
 * Apply a unified diff, strictly.
 *
 * The Rust original used the `diffy` crate. This is a small hand-rolled
 * applier with the property that matters: every context and removal line must
 * match the file exactly, or it throws and nothing is written. It refuses
 * rather than guesses — a fuzzy patch on live verb source is how you silently
 * destroy someone's code.
 */
export function applyUnifiedDiff(source, patchText) {
  const srcLines = source.split("\n");
  const patchLines = patchText.split("\n");
  const hunks = [];
  let cur = null;
  for (const line of patchLines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // skip ---/+++/index headers
    if (/^[ +\-\\]/.test(line) || line === "") cur.lines.push(line);
  }
  if (!hunks.length) throw new Error("invalid patch: no @@ hunk header found");

  // Apply from the bottom up so earlier offsets stay valid.
  hunks.sort((a, b) => b.oldStart - a.oldStart);
  let out = srcLines.slice();
  for (const h of hunks) {
    let i = h.oldStart - 1; // unified diff is 1-based
    if (i < 0) throw new Error("invalid patch: hunk starts before the first line");
    const replacement = [];
    let cursor = i;
    for (const line of h.lines) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      const kind = line[0] ?? " ";
      const text = line.slice(1);
      if (kind === " ") {
        if (out[cursor] !== text) {
          throw new Error(
            `patch did not apply; no write performed: context mismatch at line ${cursor + 1}. ` +
              `Expected ${JSON.stringify(text)}, found ${JSON.stringify(out[cursor] ?? "<end of file>")}.`,
          );
        }
        replacement.push(text);
        cursor++;
      } else if (kind === "-") {
        if (out[cursor] !== text) {
          throw new Error(
            `patch did not apply; no write performed: removal mismatch at line ${cursor + 1}. ` +
              `Expected ${JSON.stringify(text)}, found ${JSON.stringify(out[cursor] ?? "<end of file>")}.`,
          );
        }
        cursor++;
      } else if (kind === "+") {
        replacement.push(text);
      }
    }
    out = out.slice(0, i).concat(replacement, out.slice(cursor));
  }
  return out.join("\n");
}

export async function addVerb(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const names = need(args, "names");
  const nameList = Array.isArray(names) ? names.join(" ") : String(names);
  const owner = args.owner ? mooObjectExpr(args.owner) : "player";
  const perms = String(args.perms ?? "rxd");
  const argspec = Array.isArray(args.args) && args.args.length === 3 ? args.args : ["this", "none", "this"];
  const source =
    `add_verb(${obj}, {${owner}, ${mooLiteral(perms)}, ${mooLiteral(nameList)}}, ` +
    `{${argspec.map((a) => mooLiteral(String(a))).join(", ")}});` +
    (args.source ? ` set_verb_code(${obj}, ${mooLiteral(nameList.split(" ")[0])}, ${objdefLinesLiteral(String(args.source))});` : "") +
    ` return 1;`;
  return evalSource(env, source, args.timeout_ms);
}

export async function deleteVerb(args, env) {
  const source = `delete_verb(${mooObjectExpr(need(args, "object"))}, ${mooLiteral(String(need(args, "verb")))}); return 1;`;
  return evalSource(env, source, args.timeout_ms);
}

export async function setVerbArgs(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const verb = mooLiteral(String(need(args, "verb")));
  const spec = [need(args, "dobj"), need(args, "preposition"), need(args, "iobj")].map((s) => mooLiteral(String(s)));
  return evalSource(env, `set_verb_args(${obj}, ${verb}, {${spec.join(", ")}}); return verb_args(${obj}, ${verb});`, args.timeout_ms);
}

export async function setVerbInfo(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const verb = mooLiteral(String(need(args, "verb")));
  // Read the current triple and change only what was asked for, so a caller
  // setting permissions cannot accidentally blank the owner or the names.
  const parts = [
    args.owner !== undefined ? mooObjectExpr(args.owner) : `info[1]`,
    args.perms !== undefined ? mooLiteral(String(args.perms)) : `info[2]`,
    args.names !== undefined ? mooLiteral(Array.isArray(args.names) ? args.names.join(" ") : String(args.names)) : `info[3]`,
  ];
  const source = `info = verb_info(${obj}, ${verb}); set_verb_info(${obj}, ${verb}, {${parts.join(", ")}}); return verb_info(${obj}, ${verb});`;
  return evalSource(env, source, args.timeout_ms);
}

export async function findVerbDefinition(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const verb = mooLiteral(String(need(args, "verb")));
  const source =
    `chain = {}; o = ${obj}; while (valid(o)) if (${verb} in verbs(o)) chain = {@chain, o}; endif o = parent(o); endwhile ` +
    `return ["defined_on" -> chain, "active" -> (length(chain) ? chain[1] | $nothing)];`;
  return evalSource(env, source, args.timeout_ms);
}

// ===========================================================================
// Properties
// ===========================================================================

export async function listProperties(args, env) {
  const obj = objectPathSegment(need(args, "object"));
  const inherited = args.inherited ? "true" : "false";
  return getCompact(env, `/v1/properties/${obj}?inherited=${inherited}`);
}

export async function getProperty(args, env) {
  const obj = objectPathSegment(need(args, "object"));
  const prop = pathSegment(need(args, "property"));
  return getCompact(env, `/v1/properties/${obj}/${prop}`);
}

export async function setProperty(args, env) {
  if (!("value" in (args ?? {}))) throw new Error("missing value");
  const obj = mooObjectExpr(need(args, "object"));
  const prop = String(need(args, "property"));
  // The value is serialized to a MOO literal, never interpolated as text.
  const source = `${obj}.${propName(prop)} = ${mooLiteral(args.value)}; return ${obj}.${propName(prop)};`;
  return evalSource(env, source, args.timeout_ms);
}

function propName(s) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
  throw new Error(`unsafe property name ${JSON.stringify(s)}`);
}

export async function addProperty(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const prop = mooLiteral(String(need(args, "property")));
  const value = "value" in (args ?? {}) ? mooLiteral(args.value) : "0";
  const owner = args.owner ? mooObjectExpr(args.owner) : "player";
  // `rwc` is the default deliberately: mutable instance state needs it, and
  // the common bug is a property added without `c` whose descendants then
  // cannot be written by their own owners.
  const perms = mooLiteral(String(args.perms ?? "rwc"));
  const source = `add_property(${obj}, ${prop}, ${value}, {${owner}, ${perms}}); return 1;`;
  return evalSource(env, source, args.timeout_ms);
}

export async function deleteProperty(args, env) {
  const source = `delete_property(${mooObjectExpr(need(args, "object"))}, ${mooLiteral(String(need(args, "property")))}); return 1;`;
  return evalSource(env, source, args.timeout_ms);
}

// ===========================================================================
// Objects
// ===========================================================================

export async function resolve(args, env) {
  const obj = objectPathSegment(need(args, "object"));
  return getCompact(env, `/v1/objects/${obj}`);
}

export async function listObjects(args, env) {
  const moo = createClient(env);
  const p = args.parent ? `/v1/objects/query?parent=${objectPathSegment(args.parent)}` : "/v1/objects";
  const res = await moo.authenticated("GET", p);
  if (!res.ok) throw new Error(`${p} returned HTTP ${res.status}: ${clip(res.text, 400)}`);
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new Error(`${p} did not return JSON`);
  }
  let list = compactWire(body);
  // name_pattern and limit are applied here, not on the server: the endpoint
  // offers neither, and pretending otherwise would silently return everything.
  const flat = Array.isArray(list) ? list : findFirstArray(list) ?? [];
  let filtered = flat;
  if (args.name_pattern) {
    const re = new RegExp(String(args.name_pattern), "i");
    filtered = filtered.filter((o) => re.test(JSON.stringify(o)));
  }
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : undefined;
  const total = filtered.length;
  if (limit && total > limit) filtered = filtered.slice(0, limit);
  return bounded(
    JSON.stringify(
      {
        objects: filtered,
        shown: filtered.length,
        total_matched: total,
        ...(limit && total > limit
          ? { cut: total - filtered.length, note: `${total - filtered.length} objects were cut by limit=${limit}. Raise limit or narrow name_pattern.` }
          : {}),
      },
      null,
      2,
    ),
  );
}

function findFirstArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) {
      const r = findFirstArray(x);
      if (r) return r;
    }
  }
  return undefined;
}

export async function createObject(args, env) {
  const parent = mooObjectExpr(need(args, "parent"));
  const owner = args.owner ? mooObjectExpr(args.owner) : "player";
  const source =
    `o = create(${parent}, ${owner});` +
    (args.name ? ` o.name = ${mooLiteral(String(args.name))};` : "") +
    ` return o;`;
  const out = await evalSource(env, source, args.timeout_ms, {
    reminder:
      "If this timed out or raised after allocating, a partial object may exist. Inspect for " +
      "partial children and dangling references and recycle any partial object through " +
      "$recycler before retrying.",
  });
  return out;
}

export async function recycleObject(args, env) {
  const raw = String(need(args, "object"));
  // Refused twice. First by spelling, here.
  const trimmed = raw.trim();
  if (trimmed.startsWith("#") && Number(trimmed.slice(1)) === 0) {
    throw new Error("refusing to recycle system object #0");
  }
  const obj = mooObjectExpr(trimmed);
  // Then inside the MOO, in the same task that recycles, because
  // toobj(<invalid CURIE>) evaluates to #0. The equality test is deliberately
  // before valid(), so this stays a hard stop even where #0 is valid.
  const source =
    `target = ${obj}; ` +
    `if (target == #0) raise(E_PERM, "Refusing to recycle system object #0."); endif ` +
    `if (!valid(target)) raise(E_INVARG, "Refusing to recycle an invalid object reference."); endif ` +
    `recycle(target); return target;`;
  return evalSource(env, source, args.timeout_ms);
}

export async function moveObject(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const dest = mooObjectExpr(need(args, "destination"));
  return evalSource(env, `move(${obj}, ${dest}); return location(${obj});`, args.timeout_ms);
}

export async function setParent(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const parent = mooObjectExpr(need(args, "parent"));
  return evalSource(env, `chparent(${obj}, ${parent}); return parent(${obj});`, args.timeout_ms);
}

export async function objectFlags(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const source =
    `return ["player" -> is_player(${obj}), "programmer" -> ${obj}.programmer, "wizard" -> ${obj}.wizard, ` +
    `"fertile" -> ${obj}.f, "readable" -> ${obj}.r, "writable" -> ${obj}.w];`;
  return evalSource(env, source, args.timeout_ms);
}

export async function setObjectFlag(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const flag = String(need(args, "flag"));
  const value = args.value ? "1" : "0";
  const map = { player: null, programmer: "programmer", wizard: "wizard", fertile: "f", readable: "r", writable: "w" };
  if (!(flag in map)) throw new Error(`unknown flag ${JSON.stringify(flag)}; expected one of ${Object.keys(map).join(", ")}`);
  if (flag === "player") {
    return evalSource(env, `set_player_flag(${obj}, ${value}); return is_player(${obj});`, args.timeout_ms);
  }
  return evalSource(env, `${obj}.${map[flag]} = ${value}; return ${obj}.${map[flag]};`, args.timeout_ms);
}

export async function objectGraph(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.min(Number(args.limit), 500) : 100;
  // Descendants are bounded: a query near the root of a large world would
  // otherwise walk the whole database and blow the tick limit.
  const source =
    `anc = {}; o = parent(${obj}); while (valid(o)) anc = {@anc, o}; o = parent(o); endwhile ` +
    `kids = children(${obj}); cut = 0; ` +
    `if (length(kids) > ${limit}) cut = length(kids) - ${limit}; kids = kids[1..${limit}]; endif ` +
    `return ["ancestors" -> anc, "children" -> kids, "children_cut" -> cut];`;
  return evalSource(env, source, args.timeout_ms);
}

export async function dumpObject(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const out = await evalSource(env, `return dump_object(${obj});`, args.timeout_ms, {
    reminder:
      "A failed dump is NOT evidence the object is absent or invalid: this can fail where " +
      "moo_resolve confirms the object is fine. Prefer targeted inspection — moo_resolve, " +
      "moo_list_verbs, moo_list_properties, moo_get_verb, moo_get_property.",
  });
  if (args.path) {
    const full = await confinedObjdefPath(env, args.path);
    // Persist only what the MOO actually returned.
    let text;
    try {
      const parsed = JSON.parse(out);
      text = Array.isArray(parsed.value) ? parsed.value.join("\n") : String(parsed.value ?? "");
    } catch {
      text = out;
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, text, "utf8");
    return bounded(JSON.stringify({ success: true, written: path.join(OBJDEF_ROOT, args.path), bytes: text.length }, null, 2));
  }
  return out;
}

// ===========================================================================
// objdef
// ===========================================================================

export async function loadObject(args, env) {
  const source = String(need(args, "objdef"));
  const src = `${OBJDEF_CONSTANTS_BUILDER}; return load_object(${objdefLinesLiteral(source)}, constants);`;
  return evalSource(env, src, args.timeout_ms);
}

export async function reloadObject(args, env) {
  const source = String(need(args, "objdef"));
  const src = `${OBJDEF_CONSTANTS_BUILDER}; return reload_object(${objdefLinesLiteral(source)}, constants);`;
  return evalSource(env, src, args.timeout_ms);
}

export async function readObjdefFile(args, env) {
  const full = await confinedObjdefPath(env, need(args, "path"));
  const text = await fs.readFile(full, "utf8");
  return bounded(text);
}

export async function writeObjdefFile(args, env) {
  const full = await confinedObjdefPath(env, need(args, "path"));
  const text = String(need(args, "contents"));
  await fs.mkdir(path.dirname(full), { recursive: true });
  // Written atomically: a half-written objdef that someone then loads is worse
  // than no file.
  const tmp = `${full}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, full);
  return bounded(JSON.stringify({ success: true, path: path.join(OBJDEF_ROOT, String(args.path)), bytes: text.length }, null, 2));
}

export async function loadObjdefFile(args, env) {
  const full = await confinedObjdefPath(env, need(args, "path"));
  const text = await fs.readFile(full, "utf8");
  return loadObject({ objdef: text, timeout_ms: args.timeout_ms }, env);
}

export async function reloadObjdefFile(args, env) {
  const full = await confinedObjdefPath(env, need(args, "path"));
  const text = await fs.readFile(full, "utf8");
  return reloadObject({ objdef: text, timeout_ms: args.timeout_ms }, env);
}

export async function applyPatchObjdef(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  const patchText = String(need(args, "patch"));
  const moo = createClient(env);
  const dumped = await moo.captured("/v1/eval", `return dump_object(${obj});`, args.timeout_ms);
  if (!dumped.success) return report(dumped, { note: "dump failed; no write performed" });
  const current = Array.isArray(dumped.value) ? dumped.value.join("\n") : String(dumped.value ?? "");
  // Throws, and writes nothing, if the patch does not apply.
  const patched = applyUnifiedDiff(current, patchText);
  const src = `${OBJDEF_CONSTANTS_BUILDER}; return reload_object(${objdefLinesLiteral(patched)}, constants);`;
  return evalSource(env, src, args.timeout_ms, { patched_bytes: patched.length });
}

export async function diffObject(args, env) {
  const obj = mooObjectExpr(need(args, "object"));
  let target;
  if (args.objdef) target = String(args.objdef);
  else if (args.path) target = await fs.readFile(await confinedObjdefPath(env, args.path), "utf8");
  else throw new Error("give either objdef or path");

  const moo = createClient(env);
  const dumped = await moo.captured("/v1/eval", `return dump_object(${obj});`, args.timeout_ms);
  if (!dumped.success) return report(dumped);
  const live = (Array.isArray(dumped.value) ? dumped.value.join("\n") : String(dumped.value ?? "")).split("\n");
  const other = target.split("\n");
  const diff = [];
  for (let i = 0; i < Math.max(live.length, other.length); i++) {
    if (live[i] !== other[i]) {
      if (live[i] !== undefined) diff.push(`-${i + 1}: ${live[i]}`);
      if (other[i] !== undefined) diff.push(`+${i + 1}: ${other[i]}`);
    }
  }
  return bounded(
    diff.length
      ? `${diff.length} differing lines (- live, + given):\n${diff.join("\n")}`
      : "identical: the live dump and the given objdef agree line for line.",
  );
}

// ===========================================================================
// Command parsing
// ===========================================================================

export async function parseCommand(args, env) {
  const cmd = mooLiteral(String(need(args, "command")));
  const envLit = environmentLiteral(args.environment);
  return evalSource(env, `return parse_command(${cmd}, ${envLit});`, args.timeout_ms);
}

export async function parseCommandForPlayer(args, env) {
  const cmd = mooLiteral(String(need(args, "command")));
  const player = mooObjectExpr(need(args, "player"));
  const source =
    `p = ${player}; e = {p, location(p), @contents(p)}; ` +
    `if (valid(location(p))) e = {@e, @contents(location(p))}; endif ` +
    `return parse_command(${cmd}, e);`;
  return evalSource(env, source, args.timeout_ms);
}

export async function findCommandVerb(args, env) {
  const cmd = mooLiteral(String(need(args, "command")));
  const envLit = environmentLiteral(args.environment);
  const source = `return find_command_verb(${cmd}, ${envLit});`;
  return evalSource(env, source, args.timeout_ms);
}

function environmentLiteral(value) {
  if (value === undefined || value === null) return "{}";
  if (!Array.isArray(value)) throw new Error("environment must be an array");
  const parts = value.map((entry) => {
    if (typeof entry === "string") return mooObjectExpr(entry);
    if (typeof entry === "number") return mooObjectExpr(`#${entry}`);
    if (entry && typeof entry === "object") {
      const obj = entry.obj;
      if (obj === undefined) throw new Error("environment entry missing obj");
      const o = typeof obj === "number" ? mooObjectExpr(`#${obj}`) : mooObjectExpr(String(obj));
      if (entry.names !== undefined) {
        if (!Array.isArray(entry.names)) throw new Error("environment names must be an array");
        return `{${o}, {${entry.names.map((n) => mooLiteral(String(n))).join(", ")}}}`;
      }
      return o;
    }
    throw new Error("invalid environment entry");
  });
  return `{${parts.join(", ")}}`;
}

export async function listPrepositions(_args, env) {
  // The canonical table, ids 0-15. Local: it is a constant of the language, so
  // a round trip would only add a way to fail.
  const table = [
    "with/using", "at/to", "in front of", "in/inside/into", "on top of/on/onto/upon",
    "out of/from inside/from", "over", "through", "under/underneath/beneath",
    "behind", "beside", "for/about", "is", "as", "off/off of", "any",
  ];
  return bounded(JSON.stringify({ prepositions: table.map((names, id) => ({ id, names })) }, null, 2));
}

// ===========================================================================
// Runtime and server
// ===========================================================================

export async function connectedPlayers(_args, env) {
  const source =
    `out = {}; for p in (connected_players()) ` +
    `out = {@out, ["player" -> p, "name" -> p.name, "idle_seconds" -> idle_seconds(p), "connected_seconds" -> connected_seconds(p)]}; ` +
    `endfor return out;`;
  return evalSource(env, source);
}

export async function queuedTasks(_args, env) {
  return evalSource(env, "return queued_tasks();");
}

export async function killTask(args, env) {
  const id = Number(need(args, "task_id"));
  if (!Number.isInteger(id)) throw new Error("task_id must be an integer");
  return evalSource(env, `kill_task(${id}); return ${id};`);
}

export async function notify(args, env) {
  const player = mooObjectExpr(need(args, "player"));
  const message = mooLiteral(String(need(args, "message")));
  return evalSource(env, `notify(${player}, ${message}); return 1;`);
}

export async function functionHelp(args, env) {
  const name = args?.function ? mooLiteral(String(args.function)) : null;
  const source = name
    ? `return function_help(${name});`
    : `return function_info();`;
  return evalSource(env, source);
}

export async function serverInfo(_args, env) {
  const moo = createClient(env);
  const out = {};
  // /health and /version need no auth, so they answer even when the
  // credentials are wrong — which is exactly what makes them worth reporting
  // separately from anything authenticated.
  try {
    const h = await moo.getPlain("/health");
    out.health = h.status === 200 ? "up" : `degraded (HTTP ${h.status})`;
    if (h.status === 503) out.health_note = "503 means the web host has not heard from its daemon in the last 30 seconds.";
  } catch (e) {
    out.health = `unreachable: ${e.message}`;
  }
  try {
    const v = await moo.getPlain("/version");
    out.version = JSON.parse(v.text);
  } catch {
    /* optional */
  }
  try {
    // Must ask for JSON explicitly: with no Accept header this answers with a
    // FlatBuffers blob, and with a wrong one it answers 406.
    const f = await moo.getJson("/v1/features");
    out.features = compactWire(JSON.parse(f.text));
  } catch (e) {
    out.features_error = e.message;
  }
  out.base_url = moo.baseUrl;
  return bounded(JSON.stringify(out, null, 2));
}

export async function reconnect(_args, env) {
  const moo = createClient(env);
  // Drop the cached token, then prove a fresh login works.
  try {
    if (env?.harness?.["@bitmuse/moo"]) env.harness["@bitmuse/moo"] = {};
  } catch {
    /* not fatal */
  }
  const token = await moo.login();
  return bounded(
    JSON.stringify(
      { success: true, identity: moo.username ?? "(pre-minted token)", token_length: token.length, base_url: moo.baseUrl },
      null,
      2,
    ),
  );
}

// ===========================================================================
// MOO-defined (dynamic) tools
// ===========================================================================

export async function dynamicList(_args, env) {
  const moo = createClient(env);
  const r = await moo.captured("/v1/eval", "return #0:external_agent_tools();");
  if (!r.success) return report(r);
  const tools = dynamicTools(r.value);
  return bounded(
    JSON.stringify(
      {
        tools,
        note:
          "These are declarations the world itself publishes, i.e. data — not registered tools. " +
          "Call one with moo_dynamic_invoke.",
      },
      null,
      2,
    ),
  );
}

export const dynamicRefresh = dynamicList;

export async function dynamicInvoke(args, env) {
  const name = String(need(args, "name"));
  const callArgs = args.arguments;
  if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) {
    throw new Error("arguments must be an object");
  }
  const moo = createClient(env);
  // Re-read the declarations in the same call: a tool that vanished from the
  // world must not remain callable from a stale cache.
  const defs = await moo.captured("/v1/eval", "return #0:external_agent_tools();");
  if (!defs.success) return report(defs);
  const tools = dynamicTools(defs.value);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`dynamic tool ${JSON.stringify(name)} is not currently declared`);

  const required = tool.input_schema?.required;
  if (Array.isArray(required)) {
    for (const k of required) {
      if (!(k in callArgs)) throw new Error(`missing required dynamic argument ${k}`);
    }
  }
  const target = mooObjectExpr(String(tool.target_obj));
  const verb = verbName(String(tool.target_verb));
  const source = `return ${target}:${verb}(${mooLiteral(callArgs)}, player);`;
  const r = await moo.captured("/v1/eval", source, args.timeout_ms);
  return report(r);
}

// ===========================================================================
// Gaps the skills reference but the original never implemented
// ===========================================================================

/**
 * `moo_grep` — search verb source across objects.
 *
 * The torchship skills tell an agent to reach for this and neither the wasm
 * tools nor the MCP host ever had it. It is built here because "everything is
 * objects and verbs; there are no source files to grep" is precisely why a
 * grep is needed.
 */
export async function grep(args, env) {
  const pattern = String(need(args, "pattern"));
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.min(Number(args.limit), 200) : 50;
  // `object` may be #number, a UUID id, a CURIE, or a corified reference such as
  // $you. mooObjectExpr turns each into an expression; the task resolves it to
  // an object *once*, checks it, and reports the resolved number back so the
  // caller sees what $you actually was.
  const scope = args.object ? mooObjectExpr(args.object) : null;
  // Built as a literal, so a pattern with a quote cannot become code.
  const pat = mooLiteral(pattern);
  const resolve = scope
    ? `scope = ${scope}; ` +
      // typeof(#0) rather than the OBJ constant: eval'd source has no builtin
      // type-name variables in scope, so OBJ raises E_VARNF there.
      `if (typeof(scope) != typeof(#0)) raise(E_TYPE, "object did not resolve to an object"); endif ` +
      `if (!valid(scope)) raise(E_INVARG, "object resolved to an invalid object"); endif `
    : `scope = #-1; `;
  const targets = scope ? `{scope, @descendants(scope)}` : `objects()`;
  const source =
    `hits = {}; cut = 0; ` +
    resolve +
    `for o in (${targets}) ` +
    `for v in (verbs(o)) ` +
    `code = \`verb_code(o, v) ! ANY => {}'; ` +
    `for i in [1..length(code)] ` +
    `if (index(code[i], ${pat})) ` +
    `if (length(hits) >= ${limit}) cut = cut + 1; else ` +
    `hits = {@hits, ["object" -> o, "verb" -> v, "line" -> i, "text" -> code[i]]}; endif ` +
    `endif endfor endfor endfor ` +
    `return ["scope" -> scope, "matches" -> hits, "cut" -> cut];`;
  return evalSource(env, source, args.timeout_ms ?? 60_000, {
    reminder:
      "A whole-database grep is expensive and can hit the tick limit. Narrow it with `object` " +
      "to search one subtree when you can.",
  });
}

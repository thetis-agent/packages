// Reaching the world, and running a plan in it.
//
// This package has no client and no credentials of its own. It finds the moo
// tool package installed in the same space, imports that package's client.js
// and hands it that package's effective configuration, so it logs in as the
// same character over the same web host. The soft link is deliberate: one
// login to configure, and a fix to the client reaches both packages at once.

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createBuildSource, createRoomSource, deleteRoomSource, finishSource, hideSource,
  linkSource, listSource, snapshotSource, unlinkSource, updateRoomSource,
} from "./source.js";
import { normalize } from "./plan.js";
import { OPPOSITE } from "./grid.js";

export const MOO_PACKAGES = ["@thetis/moo", "@bitmuse/moo"];

// Auth tokens, per moo package and character, for as long as this fence lives.
// The moo client reads and writes them through `env.harness`.
const harness = {};

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The moo package's client, logged in as its character. */
export async function connect(env) {
  const named = str(env?.config?.moo_package);
  const installed = (await env.kernel.packages.list()) ?? [];
  const pkg = (named ? [named] : MOO_PACKAGES).map((n) => installed.find((p) => p.name === n)).find(Boolean);
  if (!pkg?.root) {
    throw new Error(
      named
        ? `the key moo_package names ${named}, and no package of that name is installed in this space.`
        : `no moo package is installed in this space. These tools reach the world through ${MOO_PACKAGES.join(" or ")}: ` +
            `they use its client and log in as its character. Install it and set its username and password, or set ` +
            `moo_package on this package to name the one you have.`,
    );
  }
  const file = resolve(pkg.root, "client.js");
  let mod;
  try {
    mod = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
  } catch (e) {
    throw new Error(`could not load ${pkg.name}'s client from ${file}: ${e.message}`);
  }
  if (typeof mod.createClient !== "function") throw new Error(`${pkg.name}'s client.js has no createClient export`);
  const config = (await env.kernel.config.effective(pkg.name)) ?? {};
  return { name: pkg.name, client: mod.createClient({ ...env, config, harness }), mod };
}

/** A failed or refused task, in words: the raised message when there is one. */
export function explain(r, mod) {
  const err = mod?.compactWire ? mod.compactWire(r.error) : r.error;
  const strings = [];
  const walk = (v) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(err);
  const message = strings.filter((s) => s.length > 3).sort((a, b) => b.length - a.length)[0];
  const raw = JSON.stringify(err ?? null);
  const parts = [message ?? (raw.length > 600 ? raw.slice(0, 600) + "…" : raw)];
  if (r.output?.length) parts.push(`printed: ${r.output.map(String).join(" / ").slice(0, 400)}`);
  return parts.join(" — ");
}

/** Run one task and return its value, or throw with the MOO's own words. */
export async function call(conn, source, timeoutMs = 30_000) {
  const r = await conn.client.captured("/v1/eval", source, timeoutMs);
  if (r.timed_out) {
    // mooR (after f50464d59) says in `kept` whether the task's last
    // transaction committed; an older client gives no `kept`.
    const kept = {
      No: "It was rolled back: its last transaction did not commit, though anything it committed at a suspend() stands.",
      Yes: "It committed: whatever it did before the limit stands.",
      Unknown: "Whether it committed is unknown.",
    }[r.kept];
    const e = new Error(
      kept
        ? `the task hit its tick or time limit. ${kept} Read the build back with moo_build_get before trying again.`
        : "the task hit its tick or time limit. A timeout is not a rollback: whatever it did before the limit is committed. " +
            "Read the build back with moo_build_get before trying again.",
    );
    e.timedOut = true;
    if (r.kept) e.kept = r.kept;
    throw e;
  }
  if (!r.success) throw new Error(explain(r, conn.mod));
  return r.value;
}

export async function listBuilds(conn, { all }) {
  return call(conn, listSource({ all }), all ? 60_000 : 30_000);
}

export async function snapshot(conn, build, { authority = true } = {}) {
  return normalize(await call(conn, snapshotSource(build, { authority }), 60_000));
}

export async function createBuild(conn, spec, cfg) {
  return call(conn, createBuildSource(spec, cfg));
}

/**
 * Run planned operations in order, one task each, stopping at the first that
 * fails. One task per operation keeps every task far from the tick limit and
 * makes a failure name exactly what did and did not happen. New rooms are
 * referred to as `new:x,y,z` until they exist.
 */
export async function execute(conn, build, ops, cfg) {
  const made = new Map();
  const id = (ref) => (String(ref).startsWith("new:") ? made.get(ref) : ref);
  const done = [];
  const touched = new Set();
  let failed;
  for (const op of ops) {
    try {
      let value;
      switch (op.op) {
        case "create":
          value = await call(conn, createRoomSource(build, op, cfg));
          made.set(op.ref, value);
          break;
        case "update":
          value = await call(conn, updateRoomSource(build, op));
          break;
        case "link": {
          value = await call(conn, linkSource(build, { ...op, from: id(op.from), to: id(op.to) }));
          const far = Array.isArray(value) ? value[2] : undefined;
          if (far && far !== "#-1" && far !== build) touched.add(far);
          break;
        }
        case "unlink":
          value = await call(conn, unlinkSource(build, op));
          if (op.to_area && op.to_area !== "#-1" && op.to_area !== build) touched.add(op.to_area);
          break;
        case "hide":
          value = await call(conn, hideSource(build, op));
          break;
        case "delete":
          value = await call(conn, deleteRoomSource(build, op));
          break;
        default:
          throw new Error(`unknown operation ${op.op}`);
      }
      done.push({ ...op, from: id(op.from), to: id(op.to), value });
    } catch (e) {
      failed = { ...op, from: id(op.from) ?? op.from, to: id(op.to) ?? op.to, error: e.message, timedOut: Boolean(e.timedOut) };
      break;
    }
  }
  const notRun = ops.slice(done.length + (failed ? 1 : 0));
  let finish;
  if (done.length && !failed?.timedOut) {
    try {
      await call(conn, finishSource(build, [...touched]), 60_000);
    } catch (e) {
      finish = `the route cache was not rebuilt: ${e.message}`;
    }
  }
  return { done, failed, notRun, finish, made };
}

/** One line per operation, as it is reported. */
export function describe(op) {
  const at = (c) => `(${c.x},${c.y},${c.z})`;
  switch (op.op) {
    case "create":
      return `create  ${op.value ? op.value + " " : ""}"${op.name}" at ${at(op)}`;
    case "update":
      return `update  ${op.room}${op.name !== undefined ? ` name → "${op.name}"` : ""}${op.description !== undefined ? ` description (${op.description.length} chars)` : ""}`;
    case "link":
      return `link    ${op.from} ${op.dir} ⇄ ${OPPOSITE[op.dir]} ${op.to}${op.type !== "open" ? ` [${op.type}]` : ""}${op.hidden ? " [hidden]" : ""}${op.outside ? " (outside this build)" : ""}`;
    case "unlink":
      return `unlink  ${op.from} ${op.dir} → ${op.to}${op.why ? ` (${op.why})` : ""}`;
    case "hide":
      return `${op.hidden ? "hide  " : "reveal"}  ${op.from} ${op.dir}`;
    case "delete":
      return `delete  ${op.room} "${op.name}" at ${at(op.cell)}`;
    default:
      return JSON.stringify(op);
  }
}

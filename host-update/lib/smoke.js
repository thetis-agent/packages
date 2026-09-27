// The smoke check: before anything new goes live, a child `node` in the checkout imports the daemon's entry
// and the main entry of every package the installation runs -- the default list, whatever anyone has
// installed, the host packages and the storage driver. It catches the class of failure where the tree
// builds but does not load (a dependency missing from node_modules, a module a package imports that is not
// there), which is what left workspaces dead for twelve minutes after an update on 2026-09-25.
//
// It runs twice: once before the update, on what is there now, and once after the build. Only an entry that
// loaded before and fails after counts against the update; one that was already broken is named in the
// output and is not the update's to fix, so it cannot hold every future update hostage.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFacts, installedIn, knownPackages, real, userspaces } from "./layout.js";

export const SMOKE_TIMEOUT_MS = 60_000;

/** What the child runs: each entry imported in turn, the failures written as one JSON line, then an explicit exit. */
const SCRIPT = `
import { pathToFileURL } from "node:url";
const entries = JSON.parse(process.env.THETIS_SMOKE_ENTRIES || "[]");
const failed = [];
for (const e of entries) {
  try { await import(pathToFileURL(e.file).href); }
  catch (err) { failed.push({ name: e.name, error: String(err && err.message || err).split("\\n")[0] }); }
}
process.stdout.write("\\n" + JSON.stringify({ checked: entries.length, failed }) + "\\n");
process.exit(0);
`;

/** A package's main entry, or null when it declares none and has no index.js: a skills pack or a page-only package loads nothing. */
function entryOf(dir, manifest) {
  if (manifest?.main) return resolve(dir, manifest.main);
  const index = resolve(dir, "index.js");
  return existsSync(index) ? index : null;
}

/**
 * `[{ name, file }]`: the runtime's entry, the CLI adapter, and every package the installation runs, each
 * once by its real path. A default the checkout does not ship is skipped: nobody runs it here.
 */
export async function smokeEntries(root, home) {
  const out = new Map();
  const add = (name, file) => {
    if (file) out.set(real(file), { name, file: real(file) });
  };
  add("@thetis/runtime", resolve(root, "dist/src/index.js"));
  const known = knownPackages(root, home);
  const byName = new Map(known.map((p) => [p.name, p]));
  const { defaults, driver } = await configFacts(root, home);
  for (const name of ["@thetis/gateway-cli", driver, ...defaults]) {
    const p = byName.get(name);
    if (p) add(name, entryOf(p.dir, p.manifest));
  }
  for (const p of known) if (p.manifest.thetis?.type === "host") add(p.name, entryOf(p.dir, p.manifest));
  for (const user of userspaces(home)) {
    for (const p of installedIn(home, user)) {
      const manifest = byName.get(p.name)?.dir === p.dir ? byName.get(p.name).manifest : readManifest(p.dir);
      add(p.name, entryOf(p.dir, manifest));
    }
  }
  return [...out.values()];
}

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Imports `entries` in a child node with cwd = `root`. Answers `{ ok, failed: [{ name, error }], output }`;
 * a child that does not finish inside `timeoutMs` fails as a whole.
 */
export function runSmoke(root, entries, { env = process.env, timeoutMs = SMOKE_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", SCRIPT], { cwd: root, env: { ...env, THETIS_SMOKE_ENTRIES: JSON.stringify(entries) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, failed: [{ name: "node", error: e.message }], output: e.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const line = out.trim().split("\n").pop() ?? "";
      let report = null;
      try {
        report = JSON.parse(line);
      } catch {
        report = null;
      }
      if (!report) {
        const why = signal === "SIGKILL" ? `the check did not finish in ${Math.round(timeoutMs / 1000)} s` : `the check exited ${code ?? signal} without a report`;
        return done({ ok: false, failed: [{ name: "node", error: why }], output: `${why}\n${err}${out}`.trim() });
      }
      done({ ok: report.failed.length === 0, failed: report.failed, checked: report.checked, output: (err + out).trim() });
    });
  });
}

/**
 * The smoke check as the job runs it: `before` is the baseline taken on the old tree (or null), and only an
 * entry that loaded then and fails now is a failure. Answers `{ ok, error?, output }` with every entry named.
 */
export async function smokeAgainst(root, home, before, { env, timeoutMs } = {}) {
  const entries = await smokeEntries(root, home);
  const now = await runSmoke(root, entries, { env, timeoutMs });
  const already = new Set((before?.failed ?? []).map((f) => f.name));
  const fresh = now.failed.filter((f) => !already.has(f.name) || f.name === "node");
  const lines = [`imported ${entries.length} entries: ${entries.map((e) => e.name).join(", ")}`];
  for (const f of now.failed) lines.push(`${already.has(f.name) && f.name !== "node" ? "already failing before the update" : "FAILS"}: ${f.name}: ${f.error}`);
  const output = lines.join("\n");
  if (!fresh.length) return { ok: true, output };
  return { ok: false, error: `the new version does not load: ${fresh.map((f) => `${f.name}: ${f.error}`).join("; ")}`, output };
}

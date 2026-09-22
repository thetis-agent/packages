// A fence, a registry and a package, built in a temporary directory. The registries are real bare git
// repositories reached over `file://`, which is a real remote as far as git is concerned: a clone, a
// commit and a push all go through the same code paths they would against github, and nothing in these
// tests can reach a network.
import { execFileSync } from "node:child_process";
import { exec as cpExec } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

// Git must not read this host's configuration: the identity, the default branch and anything else a
// developer happens to have set would make the tests say different things on different machines.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export const AUTHOR = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function temp() {
  const root = await mkdtemp(join(tmpdir(), "thetis-publish-"));
  return { root, home: await ensure(join(root, "home")), cleanup: () => rm(root, { recursive: true, force: true }) };
}

const ensure = async (p) => (await mkdir(p, { recursive: true }), p);

export const manifest = (name, version, extra = {}) => ({ name, version, license: "MIT", type: "module", main: "index.js", thetis: { type: "tool", tools: [] }, ...extra });

/** A package directory: a manifest, an entry file, and whatever else the test wants. */
export async function makePackage(dir, m, files = {}) {
  await ensure(dir);
  await writeFile(join(dir, "package.json"), `${JSON.stringify(m, null, 2)}\n`);
  const main = m.main ?? "index.js";
  await ensure(dirname(join(dir, main)));
  await writeFile(join(dir, main), "export const ok = true;\n");
  for (const [path, body] of Object.entries(files)) {
    await ensure(dirname(join(dir, path)));
    await writeFile(join(dir, path), body);
  }
  return dir;
}

/** An empty registry: a bare repository on `main`. */
export async function makeRegistry(root, name) {
  const path = join(root, `${name}.git`);
  await ensure(path);
  git(path, "init", "--bare", "-b", "main", ".");
  return path;
}

/** A registry with packages already in it, so the clone has a branch and a history like a real one. */
export async function seedRegistry(root, bare, packages) {
  const work = await ensure(join(root, `seed-${Math.random().toString(36).slice(2, 8)}`));
  git(work, "init", "-b", "main", ".");
  git(work, "remote", "add", "origin", bare);
  await writeFile(join(work, "README.md"), "# registry\n");
  for (const [dir, m] of Object.entries(packages)) await makePackage(join(work, dir), m);
  git(work, "add", "-A");
  git(work, ...AUTHOR, "commit", "-m", "seed");
  git(work, "push", "origin", "main");
  await rm(work, { recursive: true, force: true });
  return bare;
}

/** A checkout of a registry, which is the shape the maintainer's own packages directory is in. */
export async function makeCheckout(root, bare, name, packages = {}) {
  const path = join(root, name);
  git(root, "clone", bare, name);
  for (const [dir, m] of Object.entries(packages)) await makePackage(join(path, dir), m);
  if (Object.keys(packages).length) {
    git(path, "add", "-A");
    git(path, ...AUTHOR, "commit", "-m", "local work");
  }
  return path;
}

/** One file out of a bare repository, without checking anything out. */
export function show(bare, ref, path) {
  try {
    return execFileSync("git", ["-C", bare, "show", `${ref}:${path}`], { encoding: "utf8" });
  } catch {
    return null;
  }
}

export const versionIn = (bare, ref, dir) => {
  const text = show(bare, ref, `${dir}/package.json`);
  return text ? JSON.parse(text).version : null;
};

/** An in-memory `Store`, the shape `env.storage` hands package code. */
function memory(state) {
  return (namespace = "default") => {
    const ns = (state[namespace] ??= new Map());
    return {
      get: async (key) => ns.get(key),
      set: async (key, doc) => void ns.set(key, structuredClone(doc)),
      delete: async (key) => void ns.delete(key),
      list: async (prefix) => [...ns.keys()].filter((k) => !prefix || k.startsWith(prefix)),
      clear: async () => ns.clear(),
    };
  };
}

/** A `ToolEnv` with a real `exec`, the way the fence's agent builds one. */
export function makeEnv(home, { config = {}, packages = [], storage = true } = {}) {
  const state = {};
  return {
    cwd: home,
    root: home,
    store: join(home, "store"),
    shared: join(home, "shared"),
    config,
    session: { id: "s_test", user: "test" },
    exec: (cmd, opts = {}) =>
      new Promise((res) => {
        cpExec(cmd, { cwd: opts.cwd ? resolve(home, opts.cwd) : home, env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, shell: "/bin/bash" }, (err, stdout, stderr) => {
          const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          res({ code, stdout: String(stdout), stderr: String(stderr) + (err && !stderr ? `\n${err.message}` : "") });
        });
      }),
    readFile: (p) => readFile(resolve(home, p), "utf8"),
    writeFile: async (p, content) => {
      const file = resolve(home, p);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    storage: storage ? memory(state) : undefined,
    kernel: { packages: { list: async () => packages } },
  };
}

/** The refusal a call makes, for a test that is about the sentence and the code. */
export async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal, got an answer");
}

/**
 * A fork of a package on disk, written the way `forkPackage` in `@thetis/lib` writes one: the copy takes a
 * new name and `<origin version>-fork.N`, loses `scripts` and `devDependencies` because a shipped package
 * cannot rebuild inside a fence, and carries `thetis.forkedFrom`. It is done by hand here rather than
 * imported because this package ships no dependencies and its tests run on plain node, and because the
 * shape of a fork's manifest is exactly what these tests are about.
 */
export async function makeFork(dir, origin, name, n = 1) {
  const m = JSON.parse(await readFile(join(origin, "package.json"), "utf8"));
  const files = {};
  for (const entry of await readdir(origin, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name === "package.json") continue;
    const rel = relative(origin, join(entry.parentPath ?? entry.path, entry.name));
    files[rel] = await readFile(join(origin, rel), "utf8");
  }
  const { scripts, devDependencies, ...rest } = m;
  return makePackage(dir, { ...rest, name, version: `${m.version}-fork.${n}`, thetis: { ...m.thetis, forkedFrom: { name: m.name, version: m.version } } }, files);
}

/** The package directories a registry holds, at the level `@thetis/marketplace` indexes them. */
export function held(bare, ref = "main") {
  const out = {};
  let listing;
  try {
    listing = execFileSync("git", ["-C", bare, "ls-tree", "-r", "--name-only", ref], { encoding: "utf8" });
  } catch {
    return out; // a registry with no branch on it yet holds nothing, which is the same answer
  }
  for (const line of listing.split("\n")) {
    if (!/^[^/]+\/package\.json$/.test(line)) continue;
    const m = JSON.parse(show(bare, ref, line));
    out[line.split("/")[0]] = `${m.name}@${m.version}`;
  }
  return out;
}

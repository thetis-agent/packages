import { test } from "node:test";
import assert from "node:assert/strict";
import { exec as cpExec } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { capReadme, describe, readIndex, readReadme, refresh, README_CAP, README_TRUNCATED, search, slugOf, type MirrorEnv } from "../src/index.js";
import { registriesOf } from "../src/service.js";
import { cloneCommand, cloneSlug, splitSource } from "@thetis/lib/pkg-fs";
import { behind, shortCommit } from "../src/updates.js";
import type { IndexedPackage, MarketplaceIndex } from "../src/index-file.js";

/** A real environment rooted in a temporary home, like the agent's `StepEnv`. */
function envAt(home: string): MirrorEnv {
  return {
    shared: join(home, "shared"),
    exec: (cmd, opts = {}) =>
      new Promise((done) => {
        cpExec(cmd, { cwd: home, shell: "/bin/bash", timeout: opts.timeoutMs ?? 60_000 }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          done({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    readFile: (p) => readFile(resolve(home, p), "utf8"),
    writeFile: async (p, content) => {
      await mkdir(dirname(resolve(home, p)), { recursive: true });
      await writeFile(resolve(home, p), content);
    },
  };
}

function sh(cmd: string, cwd: string): Promise<void> {
  return new Promise((done, fail) => cpExec(cmd, { cwd, shell: "/bin/bash" }, (err, _o, stderr) => (err ? fail(new Error(stderr || err.message)) : done())));
}

/** A git registry with two packages, each with a README, and one directory that is not a package. */
async function registryAt(dir: string): Promise<void> {
  mkdirSync(join(dir, "greet"), { recursive: true });
  mkdirSync(join(dir, "nested", "memo"), { recursive: true });
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "greet", "README.md"), "# Greet\n\nSays hello.\n");
  writeFileSync(join(dir, "nested", "memo", "README.md"), "# Memo\n");
  writeFileSync(join(dir, "greet", "package.json"), JSON.stringify({ name: "@thetis/greet", version: "1.2.0", description: "Say hello to people", keywords: ["hello", "tool"], thetis: { type: "tool", tools: [{ name: "greet", description: "hi", export: "greet" }] } }));
  writeFileSync(join(dir, "nested", "memo", "package.json"), JSON.stringify({ name: "@thetis/memo", version: "0.3.1", description: "Remember things between turns", keywords: ["memory"], thetis: { type: "memory", steps: [{ id: "load", phase: "prompt", export: "load" }], service: { export: "start" } } }));
  writeFileSync(join(dir, "notes", "package.json"), JSON.stringify({ name: "plain", version: "1.0.0" }));
  await sh("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -q -m init", dir);
}

test("refresh mirrors a registry and indexes its packages", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-market-"));
  try {
    const registry = join(tmp, "registry");
    await registryAt(registry);
    const home = join(tmp, "home");
    mkdirSync(home);
    const env = envAt(home);
    const index = await refresh(env, [{ name: "local", url: `file://${registry}` }]);
    assert.equal(index.registries.length, 1);
    assert.match(index.registries[0].commit ?? "", /^[0-9a-f]{40}$/);
    assert.equal(index.registries[0].error, undefined);
    assert.deepEqual(index.packages.map((p) => p.name).sort(), ["@thetis/greet", "@thetis/memo"], "the plain directory is not a package");
    const greet = index.packages.find((p) => p.name === "@thetis/greet")!;
    const commit = index.registries[0].commit!;
    assert.equal(greet.dir, "greet");
    // The index shows the latest; every entry carries the commit it was read from, and the install source
    // pins it, so what a person installs stays what they installed however the registry moves on.
    assert.equal(greet.commit, commit);
    assert.equal(greet.source, `file://${registry}#greet@${commit}`);
    assert.deepEqual(splitSource(greet.source), { url: `file://${registry}`, sub: "greet", ref: commit });
    assert.deepEqual(greet.tools, ["greet"]);
    const memo = index.packages.find((p) => p.name === "@thetis/memo")!;
    assert.equal(memo.dir, "nested/memo");
    assert.equal(memo.service, true);
    assert.deepEqual(memo.steps, [{ id: "load", phase: "prompt" }]);
    const onDisk = JSON.parse(readFileSync(join(home, "shared", "marketplace", "index.json"), "utf8"));
    assert.equal(onDisk.version, 1);
    assert.deepEqual(await readIndex(env), onDisk);
    // The README crosses into the shared directory, where a package page in any fence can read it; a nested
    // dir becomes one file name. The helper reads it back through the same env the index is read with.
    assert.equal(greet.readme, true);
    assert.equal(readFileSync(join(home, "shared", "marketplace", "readme", "local", "greet.md"), "utf8"), "# Greet\n\nSays hello.\n");
    assert.equal(await readReadme(env, greet), "# Greet\n\nSays hello.\n");
    assert.equal(memo.readme, true);
    assert.equal(await readReadme(env, memo), "# Memo\n");
    assert.ok(existsSync(join(home, "shared", "marketplace", "readme", "local", "nested__memo.md")));

    // A registry that cannot be cloned records its error and does not hide the others; its old packages stay.
    const again = await refresh(env, [{ name: "local", url: `file://${registry}` }, { name: "gone", url: `file://${tmp}/missing` }]);
    assert.equal(again.registries.length, 2);
    assert.ok(again.registries[1].error, "the failure is recorded");
    assert.equal(again.packages.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a README is copied capped, only under its exact name, and leaves with its package", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-market-"));
  try {
    const registry = join(tmp, "registry");
    await registryAt(registry);
    mkdirSync(join(registry, "big"));
    writeFileSync(join(registry, "big", "package.json"), JSON.stringify({ name: "@thetis/big", version: "1.0.0", thetis: { type: "tool" } }));
    writeFileSync(join(registry, "big", "README.md"), "x".repeat(300_000));
    mkdirSync(join(registry, "lower"));
    writeFileSync(join(registry, "lower", "package.json"), JSON.stringify({ name: "@thetis/lower", version: "1.0.0", thetis: { type: "tool" } }));
    writeFileSync(join(registry, "lower", "readme.md"), "not the name the rule asks for");
    await sh("git add -A && git -c user.email=t@t -c user.name=t commit -q -m more", registry);
    const home = join(tmp, "home");
    mkdirSync(home);
    const env = envAt(home);
    const registries = [{ name: "local", url: `file://${registry}` }];
    let index = await refresh(env, registries);

    const big = index.packages.find((p) => p.name === "@thetis/big")!;
    assert.equal(big.readme, true);
    const copy = readFileSync(join(home, "shared", "marketplace", "readme", "local", "big.md"), "utf8");
    assert.ok(copy.endsWith(README_TRUNCATED), "the copy says it was cut");
    assert.equal(Buffer.byteLength(copy), README_CAP + Buffer.byteLength(README_TRUNCATED));
    assert.equal(await readReadme(env, big), copy);

    const lower = index.packages.find((p) => p.name === "@thetis/lower")!;
    assert.equal(lower.readme, false, "README.md is the name; readme.md is not it");
    assert.equal(await readReadme(env, lower), undefined);
    assert.equal(existsSync(join(home, "shared", "marketplace", "readme", "local", "lower.md")), false);

    // The package leaves the registry: its copy goes with it, and the others stay.
    await sh("git rm -r -q big && git -c user.email=t@t -c user.name=t commit -q -m drop", registry);
    index = await refresh(env, registries);
    assert.equal(index.packages.find((p) => p.name === "@thetis/big"), undefined);
    assert.equal(existsSync(join(home, "shared", "marketplace", "readme", "local", "big.md")), false);
    assert.ok(existsSync(join(home, "shared", "marketplace", "readme", "local", "greet.md")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the README cap is in bytes, and a README at the cap is left whole", () => {
  assert.equal(capReadme("short"), "short");
  const exact = "\u00e9".repeat(README_CAP / 2);
  assert.equal(capReadme(exact), exact, "two bytes per character, exactly at the cap");
  const over = capReadme(exact + "!");
  assert.ok(over.endsWith(README_TRUNCATED));
  assert.equal(Buffer.byteLength(over), README_CAP + Buffer.byteLength(README_TRUNCATED));
});

test("search ranks name over keywords over description and filters by type", () => {
  const registry = { name: "r", url: "file:///r" };
  const at = "0".repeat(40);
  const pkgs = [
    describe({ name: "@thetis/memory-notes", version: "1", description: "x", thetis: { type: "memory" } }, registry, "a", at)!,
    describe({ name: "@thetis/other", version: "1", keywords: ["memory"], description: "x", thetis: { type: "tool" } }, registry, "b", at)!,
    describe({ name: "@thetis/third", version: "1", description: "keeps memory of things", thetis: { type: "tool" } }, registry, "c", at)!,
    describe({ name: "@thetis/unrelated", version: "1", description: "nothing", thetis: { type: "tool" } }, registry, "d", at)!,
  ];
  const index = { version: 1 as const, updatedAt: "", registries: [registry], packages: pkgs };
  assert.deepEqual(search(index, "memory").map((p) => p.name), ["@thetis/memory-notes", "@thetis/other", "@thetis/third"]);
  assert.deepEqual(search(index, "MEMORY", { type: "tool" }).map((p) => p.name), ["@thetis/other", "@thetis/third"]);
  assert.equal(search(index, "").length, 4, "an empty query lists everything");
  assert.deepEqual(search(index, "memory nothing"), [], "every term must match");
  assert.equal(describe({ name: "plain", version: "1" }, registry, "x", at), undefined);
});

test("registries come from the configuration, with a default name", () => {
  assert.deepEqual(registriesOf({}), []);
  assert.deepEqual(registriesOf({ registries: [{ url: "https://example.com/thetis-packages.git" }, { name: "mine", url: "file:///x" }, { bogus: 1 }] }), [
    { name: "thetis-packages", url: "https://example.com/thetis-packages.git" },
    { name: "mine", url: "file:///x" },
  ]);
  assert.equal(slugOf("https://example.com/a/b.git"), "b");
  assert.equal(slugOf("file:///tank/packages/"), "packages");
});

test("an indexed package is installed at the commit it was indexed from, not at whatever is latest", () => {
  const registry = { name: "thetis", url: "https://github.com/thetis-agent/packages.git" };
  const at = "a".repeat(40);
  const entry = describe({ name: "@thetis/tools-files", version: "0.1.0", thetis: { type: "tool" } }, registry, "tools-files", at)!;
  assert.equal(entry.commit, at);
  assert.equal(entry.source, `https://github.com/thetis-agent/packages.git#tools-files@${at}`);
  // The whole point: what install receives says which commit, so the package cannot move underneath it.
  assert.deepEqual(splitSource(entry.source), { url: registry.url, sub: "tools-files", ref: at });
});

test("two packages from one registry get their own clone, so the second cannot replace the first", () => {
  const url = "https://github.com/thetis-agent/packages.git";
  const one = "a".repeat(40);
  const two = "b".repeat(40);
  assert.notEqual(cloneSlug(url, one), cloneSlug(url, two));
  assert.equal(cloneSlug(url, one), cloneSlug(url, one));
  assert.equal(cloneSlug(url), "packages", "an unpinned source still clones to the plain repository name");
});

test("a pinned source fetches the one commit rather than cloning a branch", () => {
  const cmd = cloneCommand("https://example.com/r.git", "/tmp/d", "c".repeat(40));
  assert.match(cmd, /git init --quiet/);
  assert.match(cmd, /fetch --quiet --depth 1 origin 'c{40}'/);
  assert.match(cmd, /checkout --quiet --detach FETCH_HEAD/);
  assert.doesNotMatch(cloneCommand("https://example.com/r.git", "/tmp/d"), /FETCH_HEAD/);
});

const indexOf = (entries: Partial<IndexedPackage>[]): MarketplaceIndex => ({
  version: 1,
  updatedAt: "",
  registries: [],
  packages: entries.map((e) => ({ keywords: [], dir: "", steps: [], tools: [], service: false, type: "tool", description: "", registry: "thetis", ...e }) as IndexedPackage),
});

const URL_A = "https://github.com/thetis-agent/packages.git";
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

test("a package pinned behind the index is listed, with what to install to catch it up", () => {
  const index = indexOf([{ name: "@thetis/tools-files", version: "0.2.0", commit: NEW, source: `${URL_A}#tools-files@${NEW}` }]);
  const out = behind([{ name: "@thetis/tools-files", source: { kind: "git", ref: `${URL_A}#tools-files@${OLD}` } }], index);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    name: "@thetis/tools-files",
    installed: OLD,
    available: NEW,
    version: "0.2.0",
    registry: "thetis",
    source: `${URL_A}#tools-files@${NEW}`,
  });
});

test("a package already on the indexed commit is not listed", () => {
  const index = indexOf([{ name: "@thetis/tools-files", commit: NEW, source: `${URL_A}#tools-files@${NEW}` }]);
  assert.deepEqual(behind([{ name: "@thetis/tools-files", source: { kind: "git", ref: `${URL_A}#tools-files@${NEW}` } }], index), []);
});

test("a package with no pin to follow is never listed", () => {
  const index = indexOf([{ name: "@thetis/tools-files", commit: NEW, source: `${URL_A}#tools-files@${NEW}` }]);
  // Shipped with the service, written locally, or installed from an unpinned URL: none of these track a registry.
  assert.deepEqual(behind([{ name: "@thetis/tools-files", source: { kind: "system", ref: "/srv/thetis/runtime/packages/tools-files" } }], index), []);
  assert.deepEqual(behind([{ name: "@thetis/tools-files", source: { kind: "local", ref: "packages/tools-files" } }], index), []);
  assert.deepEqual(behind([{ name: "@thetis/tools-files", source: { kind: "git", ref: `${URL_A}#tools-files` } }], index), []);
  assert.deepEqual(behind([{ name: "@thetis/tools-files" }], index), []);
});

test("the same name from a different repository is a different package, not an update", () => {
  const index = indexOf([{ name: "@thetis/tools-files", commit: NEW, source: `${URL_A}#tools-files@${NEW}` }]);
  const elsewhere = { name: "@thetis/tools-files", source: { kind: "git", ref: `https://git.example.com/fork.git#tools-files@${OLD}` } };
  assert.deepEqual(behind([elsewhere], index), [], "a fork of the name from another registry is left alone");
});

test("a package the index no longer carries is left alone, not reported as behind", () => {
  assert.deepEqual(behind([{ name: "@thetis/gone", source: { kind: "git", ref: `${URL_A}#gone@${OLD}` } }], indexOf([])), []);
  assert.deepEqual(behind([{ name: "@thetis/gone", source: { kind: "git", ref: `${URL_A}#gone@${OLD}` } }], undefined), []);
});

test("nothing here installs anything: it reports, and a person decides", () => {
  const index = indexOf([
    { name: "@thetis/a", commit: NEW, source: `${URL_A}#a@${NEW}` },
    { name: "@thetis/b", commit: NEW, source: `${URL_A}#b@${NEW}` },
  ]);
  const out = behind(
    [
      { name: "@thetis/a", source: { kind: "git", ref: `${URL_A}#a@${OLD}` } },
      { name: "@thetis/b", source: { kind: "git", ref: `${URL_A}#b@${OLD}` } },
    ],
    index,
  );
  assert.deepEqual(out.map((b) => b.name), ["@thetis/a", "@thetis/b"], "sorted, so the report reads the same every time");
  assert.equal(shortCommit(NEW), "2222222");
});

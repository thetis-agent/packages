import { test } from "node:test";
import assert from "node:assert/strict";
import { exec as cpExec } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  capReadme, describe, isReadmeAssetPath, readIndex, readmeAssetsOf, readReadme, readReadmeAsset, refresh, README_ASSET_CAP, README_ASSET_LIMIT, README_CAP, README_TRUNCATED, search, slugOf,
  type MirrorEnv,
} from "../src/index.js";
import { registriesOf } from "../src/service.js";
import { cloneCommand, cloneSlug, splitSource } from "@thetis/runtime/lib/pkg-fs";
import { ahead, behind, shortCommit } from "../src/updates.js";
import { compareVersions } from "@thetis/runtime/lib/versions";
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

/** A git registry with two packages, each with a README, one directory that is not a package, and one storage driver. */
async function registryAt(dir: string): Promise<void> {
  mkdirSync(join(dir, "greet"), { recursive: true });
  mkdirSync(join(dir, "nested", "memo"), { recursive: true });
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "greet", "README.md"), "# Greet\n\nSays hello.\n");
  writeFileSync(join(dir, "nested", "memo", "README.md"), "# Memo\n");
  writeFileSync(join(dir, "greet", "package.json"), JSON.stringify({ name: "@thetis/greet", version: "1.2.0", description: "Say hello to people", keywords: ["hello", "tool"], thetis: { type: "tool", tools: [{ name: "greet", description: "hi", export: "greet" }] } }));
  writeFileSync(join(dir, "nested", "memo", "package.json"), JSON.stringify({ name: "@thetis/memo", version: "0.3.1", description: "Remember things between turns", keywords: ["memory"], thetis: { type: "memory", steps: [{ id: "load", phase: "prompt", export: "load" }], service: { export: "start" } } }));
  writeFileSync(join(dir, "notes", "package.json"), JSON.stringify({ name: "plain", version: "1.0.0" }));
  mkdirSync(join(dir, "store"), { recursive: true });
  writeFileSync(join(dir, "store", "package.json"), JSON.stringify({ name: "@thetis/store-toml", version: "1.0.0", description: "Stores documents as TOML", thetis: { type: "storage", export: "createDriver" } }));
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
    assert.deepEqual(index.packages.map((p) => p.name).sort(), ["@thetis/greet", "@thetis/memo"], "the plain directory is not a package, and a storage driver is never offered");
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

test("a README's local images are copied beside it, within the rules, and leave with it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-market-"));
  try {
    const registry = join(tmp, "registry");
    await registryAt(registry);
    const pic = join(registry, "nested", "pic");
    mkdirSync(join(pic, "bench", "s-v1"), { recursive: true });
    mkdirSync(join(pic, "img"));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    writeFileSync(join(pic, "package.json"), JSON.stringify({ name: "@thetis/pic", version: "1.0.0", thetis: { type: "tool" } }));
    writeFileSync(join(pic, "bench", "s-v1", "chart.svg"), svg);
    writeFileSync(join(pic, "img", "logo.png"), png);
    writeFileSync(join(pic, "big.png"), Buffer.alloc(README_ASSET_CAP + 1));
    writeFileSync(
      join(pic, "README.md"),
      [
        "# Pic",
        "![chart](bench/s-v1/chart.svg) and again ![chart](bench/s-v1/chart.svg)",
        "![logo](img/logo.png)",
        "![remote](https://example.org/x.svg) ![up](../greet/README.md) ![root](/etc/x.svg) ![text](notes.md)",
        "![big](big.png) ![missing](nowhere.svg)",
        "",
      ].join("\n"),
    );
    await sh("git add -A && git -c user.email=t@t -c user.name=t commit -q -m pics", registry);
    const home = join(tmp, "home");
    mkdirSync(home);
    const env = envAt(home);
    const registries = [{ name: "local", url: `file://${registry}` }];
    let index = await refresh(env, registries);

    // Only the pictures that are local, inside the package, present and under the cap; each once.
    const entry = index.packages.find((p) => p.name === "@thetis/pic")!;
    assert.equal(entry.readme, true);
    assert.deepEqual(entry.readmeAssets, ["bench/s-v1/chart.svg", "img/logo.png"]);
    const copies = join(home, "shared", "marketplace", "readme", "local");
    assert.equal(readFileSync(join(copies, "nested__pic__bench__s-v1__chart.svg"), "utf8"), svg);
    assert.equal(readFileSync(join(copies, "nested__pic__img__logo.png"), "utf8"), png.toString("base64"), "a PNG crosses as base64 text");
    assert.equal(existsSync(join(copies, "nested__pic__big.png")), false, "over the cap, so not copied");
    assert.deepEqual(await readReadmeAsset(env, entry, "bench/s-v1/chart.svg"), { type: "image/svg+xml", data: svg });
    assert.deepEqual(await readReadmeAsset(env, entry, "img/logo.png"), { type: "image/png", data: png.toString("base64") });
    assert.equal(await readReadmeAsset(env, entry, "big.png"), undefined, "not listed, so not read");
    assert.equal(await readReadmeAsset(env, entry, "../greet/README.md"), undefined);
    const greet = index.packages.find((p) => p.name === "@thetis/greet")!;
    assert.equal(greet.readmeAssets, undefined, "a README with no pictures lists none");

    // The README stops showing the logo: its copy goes on the next refresh, the chart's stays.
    writeFileSync(join(pic, "README.md"), "# Pic\n\n![chart](bench/s-v1/chart.svg)\n");
    await sh("git add -A && git -c user.email=t@t -c user.name=t commit -q -m fewer", registry);
    index = await refresh(env, registries);
    assert.deepEqual(index.packages.find((p) => p.name === "@thetis/pic")!.readmeAssets, ["bench/s-v1/chart.svg"]);
    assert.equal(existsSync(join(copies, "nested__pic__img__logo.png")), false);
    assert.ok(existsSync(join(copies, "nested__pic__bench__s-v1__chart.svg")));
    assert.ok(existsSync(join(copies, "nested__pic.md")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("which image paths a README may ask for, and how many", () => {
  for (const ok of ["a.svg", "bench/x/chart.svg", "img/Logo.PNG", "a b/c.png"]) assert.equal(isReadmeAssetPath(ok), true, ok);
  for (const bad of ["", "/a.svg", "../a.svg", "a/../b.svg", "a//b.svg", "./a.svg", "https://x/a.svg", "data:image/svg+xml,x", "a.jpg", "a.svg.md", "C:\\a.svg"]) {
    assert.equal(isReadmeAssetPath(bad), false, bad);
  }
  const many = Array.from({ length: README_ASSET_LIMIT + 3 }, (_, i) => `![p](p${i}.svg)`).join(" ");
  assert.equal(readmeAssetsOf(many).length, README_ASSET_LIMIT);
  assert.deepEqual(readmeAssetsOf("![a](x.svg) ![b](x.svg) [not an image](y.svg) ![c](y.png)"), ["x.svg", "y.png"]);
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
    apply: "install",
  });
});

test("a shipped package whose fence loaded an older version is behind its own disk, and a reload applies it", () => {
  const index = indexOf([{ name: "@thetis/skills-hybrid", version: "0.2.2", commit: NEW, source: `${URL_A}#skills-hybrid@${NEW}` }]);
  const record = { name: "@thetis/skills-hybrid", version: "0.2.2", loadedVersion: "0.2.1", source: { kind: "system", ref: "/srv/thetis/runtime/packages/skills-hybrid" } };
  assert.deepEqual(behind([record], index), [
    { name: "@thetis/skills-hybrid", installed: "0.2.1", available: "0.2.2", version: "0.2.2", registry: "thetis", source: `${URL_A}#skills-hybrid@${NEW}`, apply: "reload" },
  ]);
});

test("a copy behind its disk is listed with no index at all: it is behind whether or not a registry carries it", () => {
  const record = { name: "@thetis/skills-hybrid", version: "0.2.2", loadedVersion: "0.2.1", source: { kind: "system", ref: "/srv/thetis/runtime/packages/skills-hybrid" } };
  const expected = [{ name: "@thetis/skills-hybrid", installed: "0.2.1", available: "0.2.2", version: "0.2.2", registry: "on disk", source: "", apply: "reload" }];
  assert.deepEqual(behind([record], undefined), expected, "no index");
  assert.deepEqual(behind([record], indexOf([])), expected, "an index that does not carry it");
});

test("a stale pin and a different loaded version is one thing, an install: it brings the new pin and reopens", () => {
  const index = indexOf([{ name: "@thetis/tools-files", version: "0.3.0", commit: NEW, source: `${URL_A}#tools-files@${NEW}` }]);
  const record = { name: "@thetis/tools-files", version: "0.2.0", loadedVersion: "0.1.0", source: { kind: "git", ref: `${URL_A}#tools-files@${OLD}` } };
  const out = behind([record], index);
  assert.equal(out.length, 1, "one row, not two");
  assert.equal(out[0].apply, "install");
  assert.equal(out[0].installed, OLD);
});

test("a fence running the version on disk is not behind", () => {
  const record = { name: "@thetis/skills-hybrid", version: "0.2.2", loadedVersion: "0.2.2", source: { kind: "system", ref: "/srv/thetis/runtime/packages/skills-hybrid" } };
  assert.deepEqual(behind([record], undefined), []);
  assert.deepEqual(behind([{ ...record, loadedVersion: undefined }], undefined), [], "no fence open, so nothing to say");
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

test("a fork whose origin has moved on is behind it, and going back is what takes the difference", () => {
  const record = { name: "@alice/gateway-web", version: "0.1.1-fork.1", source: { kind: "local" as const, ref: "packages/gateway-web" }, fork: { name: "@thetis/gateway-web", version: "0.1.1", shipped: "0.2.0" } };
  assert.deepEqual(behind([record], undefined), [
    { name: "@alice/gateway-web", installed: "0.1.1", available: "0.2.0", version: "0.2.0", registry: "@thetis/gateway-web", source: "", apply: "unfork", origin: "@thetis/gateway-web" },
  ]);
});

test("a fork that is the shipped package's own files is behind it even when the version has not moved: it is carrying no change at all", () => {
  const same = { name: "@alice/gateway-web", version: "0.1.1-fork.1", fork: { name: "@thetis/gateway-web", version: "0.1.1", shipped: "0.1.1", identical: true } };
  assert.deepEqual(behind([same], undefined), [
    { name: "@alice/gateway-web", installed: "0.1.1", available: "0.1.1", version: "0.1.1", registry: "@thetis/gateway-web", source: "", apply: "unfork", origin: "@thetis/gateway-web", identical: true },
  ]);
  // The same fork with one byte changed is a fork doing its job, and nothing to nag about.
  const changed = { ...same, fork: { ...same.fork, identical: false } };
  assert.deepEqual(behind([changed], undefined), []);
});

test("a fork whose origin is not on disk any more is left alone: there is nothing here to go back to", () => {
  const gone = { name: "@alice/gateway-web", version: "0.1.1-fork.1", fork: { name: "@thetis/gateway-web", version: "0.1.1" } };
  assert.deepEqual(behind([gone], undefined), []);
  assert.deepEqual(behind([{ name: "@alice/plain", version: "0.1.0" }], undefined), [], "a package that is no fork says nothing about forks");
});

test("a fork that is also behind its own registry is told the one thing it can act on first", () => {
  const index = indexOf([{ name: "@alice/thing", version: "0.3.0", commit: NEW, source: `${URL_A}#thing@${NEW}` }]);
  const record = { name: "@alice/thing", version: "0.2.0", source: { kind: "git" as const, ref: `${URL_A}#thing@${OLD}` }, fork: { name: "@thetis/thing", version: "0.1.0", shipped: "0.9.0" } };
  const out = behind([record], index);
  assert.equal(out.length, 1, "one row, not two");
  assert.equal(out[0].apply, "install", "the update it can take now wins over the fork it could leave");
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

// ---- ahead: what is newer here than anywhere else ----

test("versions are compared as numbers, not as text: 0.10.0 is newer than 0.9.0", () => {
  // The whole reason this function exists. A string comparison puts "0.10.0" before "0.9.0", and the tenth
  // release of a line is exactly when nobody is reading the numbers any more.
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("2.1.0", "2.1.0"), 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0, "a missing part is a zero, not a difference");
  assert.equal(compareVersions("1.2.3", "1.2"), 1);
  assert.equal(compareVersions("1.2.0+build.7", "1.2.0"), 0, "build metadata is not part of the version");
});

test("a prerelease is older than the release it leads to, and prerelease identifiers order among themselves", () => {
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1, "the rule people get backwards");
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.9"), 1, "and numerically here too");
  assert.equal(compareVersions("1.0.0-rc", "1.0.0-rc.1"), -1, "fewer identifiers is lower");
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1, "a numeric identifier is lower than a text one");
  // What a fork's version looks like. It is not newer than the package it was copied from, which is why a
  // fork could never be mistaken for unpublished work even before `ahead` left forks out on purpose.
  assert.equal(compareVersions("0.1.1-fork.1", "0.1.1"), -1);
});

test("an installed package newer than the version the index holds is unpublished work, and says which registry is behind it", () => {
  const index = indexOf([{ name: "@thetis/marketplace", version: "0.2.0", commit: NEW, source: `${URL_A}#marketplace@${NEW}` }]);
  const record = { name: "@thetis/marketplace", version: "0.3.0", source: { kind: "system" as const, ref: "/srv/thetis/runtime/packages/marketplace" } };
  assert.deepEqual(ahead([record], index), [{ name: "@thetis/marketplace", version: "0.3.0", published: "0.2.0", registry: "thetis", state: "ahead" }]);
  // The version the registry holds, reached: nothing to say. And older here is `behind`'s question, not this one.
  assert.deepEqual(ahead([{ ...record, version: "0.2.0" }], index), []);
  assert.deepEqual(ahead([{ ...record, version: "0.1.0" }], index), []);
  assert.deepEqual(ahead([{ ...record, version: "0.10.0" }], index), [{ name: "@thetis/marketplace", version: "0.10.0", published: "0.2.0", registry: "thetis", state: "ahead" }], "0.10.0 is newer than 0.2.0");
});

test("a package no registry lists at all has never been shared, which is its own kind of unpublished", () => {
  const index = indexOf([{ name: "@thetis/exa", version: "0.1.0", commit: NEW, source: `${URL_A}#exa@${NEW}` }]);
  const mine = { name: "@thetis/package-publish", version: "0.1.0", source: { kind: "system" as const, ref: "/srv/thetis/runtime/packages/package-publish" } };
  assert.deepEqual(ahead([mine], index), [{ name: "@thetis/package-publish", version: "0.1.0", published: "", registry: "", state: "unpublished" }]);
  const local = { name: "@alice/scratch", version: "0.0.1", source: { kind: "local" as const, ref: "packages/scratch" } };
  assert.deepEqual(ahead([local], index), [{ name: "@alice/scratch", version: "0.0.1", published: "", registry: "", state: "unpublished" }]);
});

test("a package installed from a registry that no longer carries it is left alone, as it is for behind", () => {
  // A registry dropping a package is a statement about the registry, not about this copy, and certainly not
  // an invitation to publish it back.
  const gone = { name: "@thetis/gone", version: "0.4.0", source: { kind: "git" as const, ref: `${URL_A}#gone@${OLD}` } };
  assert.deepEqual(ahead([gone], indexOf([])), []);
});

test("a fork is not unpublished work: it has a row of its own, and two rows about one package is two rows nobody reads", () => {
  const fork = { name: "@alice/gateway-web", version: "0.1.1-fork.1", source: { kind: "local" as const, ref: "packages/gateway-web" }, fork: { name: "@thetis/gateway-web", version: "0.1.1", shipped: "0.2.0" } };
  assert.deepEqual(ahead([fork], indexOf([])), []);
  // Even a fork whose version was pushed past what the registry holds stays out: it is a private copy, not
  // work waiting to be shared, and `behind` is already telling its holder the thing worth acting on.
  const index = indexOf([{ name: "@alice/gateway-web", version: "0.1.0", commit: NEW, source: `${URL_A}#gw@${NEW}` }]);
  assert.deepEqual(ahead([{ ...fork, version: "0.9.0" }], index), []);
});

test("with no index there is nothing to compare against, so nothing is claimed about the registries", () => {
  const record = { name: "@thetis/marketplace", version: "0.3.0", source: { kind: "system" as const, ref: "/srv" } };
  assert.deepEqual(ahead([record], undefined), [], "no mirror yet is not the same as nothing published");
  assert.deepEqual(ahead([{ name: "@thetis/x" }], indexOf([])), [], "a record with no version says nothing");
});

test("a package two registries hold is measured against the newest of them, and ahead rows are sorted", () => {
  const index = indexOf([
    { name: "@thetis/exa", version: "0.1.0", registry: "thetis", commit: OLD, source: `${URL_A}#exa@${OLD}` },
    { name: "@thetis/exa", version: "0.4.0", registry: "team", commit: NEW, source: `https://git.example.com/p.git#exa@${NEW}` },
  ]);
  const at = (version: string) => [{ name: "@thetis/exa", version, source: { kind: "system" as const, ref: "/srv" } }];
  assert.deepEqual(ahead(at("0.2.0"), index), [], "published to one registry is published");
  assert.deepEqual(ahead(at("0.5.0"), index), [{ name: "@thetis/exa", version: "0.5.0", published: "0.4.0", registry: "team", state: "ahead" }]);
  const many = [
    { name: "@thetis/b", version: "2.0.0", source: { kind: "system" as const, ref: "/srv" } },
    { name: "@thetis/a", version: "2.0.0", source: { kind: "system" as const, ref: "/srv" } },
  ];
  assert.deepEqual(ahead(many, indexOf([])).map((a) => a.name), ["@thetis/a", "@thetis/b"], "sorted, so the report reads the same every time");
});

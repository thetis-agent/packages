import { test } from "node:test";
import assert from "node:assert/strict";
import { exec as cpExec } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, readIndex, refresh, search, slugOf, type MirrorEnv } from "../src/index.js";
import { registriesOf } from "../src/service.js";

/** A real environment rooted in a temporary home, like the agent's `StepEnv`. */
function envAt(home: string): MirrorEnv {
  return {
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

/** A git registry with two packages and one directory that is not a package. */
async function registryAt(dir: string): Promise<void> {
  mkdirSync(join(dir, "greet"), { recursive: true });
  mkdirSync(join(dir, "nested", "memo"), { recursive: true });
  mkdirSync(join(dir, "notes"), { recursive: true });
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
    assert.equal(greet.dir, "greet");
    assert.equal(greet.source, `file://${registry}#greet`);
    assert.deepEqual(greet.tools, ["greet"]);
    const memo = index.packages.find((p) => p.name === "@thetis/memo")!;
    assert.equal(memo.dir, "nested/memo");
    assert.equal(memo.service, true);
    assert.deepEqual(memo.steps, [{ id: "load", phase: "prompt" }]);
    const onDisk = JSON.parse(readFileSync(join(home, "marketplace/index.json"), "utf8"));
    assert.equal(onDisk.version, 1);
    assert.deepEqual(await readIndex(env), onDisk);

    // A registry that cannot be cloned records its error and does not hide the others; its old packages stay.
    const again = await refresh(env, [{ name: "local", url: `file://${registry}` }, { name: "gone", url: `file://${tmp}/missing` }]);
    assert.equal(again.registries.length, 2);
    assert.ok(again.registries[1].error, "the failure is recorded");
    assert.equal(again.packages.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("search ranks name over keywords over description and filters by type", () => {
  const registry = { name: "r", url: "file:///r" };
  const pkgs = [
    describe({ name: "@thetis/memory-notes", version: "1", description: "x", thetis: { type: "memory" } }, registry, "a")!,
    describe({ name: "@thetis/other", version: "1", keywords: ["memory"], description: "x", thetis: { type: "tool" } }, registry, "b")!,
    describe({ name: "@thetis/third", version: "1", description: "keeps memory of things", thetis: { type: "tool" } }, registry, "c")!,
    describe({ name: "@thetis/unrelated", version: "1", description: "nothing", thetis: { type: "tool" } }, registry, "d")!,
  ];
  const index = { version: 1 as const, updatedAt: "", registries: [registry], packages: pkgs };
  assert.deepEqual(search(index, "memory").map((p) => p.name), ["@thetis/memory-notes", "@thetis/other", "@thetis/third"]);
  assert.deepEqual(search(index, "MEMORY", { type: "tool" }).map((p) => p.name), ["@thetis/other", "@thetis/third"]);
  assert.equal(search(index, "").length, 4, "an empty query lists everything");
  assert.deepEqual(search(index, "memory nothing"), [], "every term must match");
  assert.equal(describe({ name: "plain", version: "1" }, registry, "x"), undefined);
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

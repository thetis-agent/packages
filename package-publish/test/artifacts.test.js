import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { forkPackage } from "@thetis/runtime/lib/pkg-fs";
import { publish } from "../lib/publish.js";
import { AUTHOR, git, makeCheckout, makeEnv, makePackage, makeRegistry, manifest, seedRegistry, temp } from "./helpers.js";

for (const as of ["origin", "itself"]) {
  test(`a compiled fork published as ${as} carries its ignored build and runs from a fresh clone`, async (t) => {
    const fx = await temp();
    t.after(fx.cleanup);
    const bare = await makeRegistry(fx.root, "registry");
    await seedRegistry(fx.root, bare, { widget: manifest("@dev/widget", "1.0.0", { main: "dist/src/index.js", scripts: { build: "echo build" } }) });
    const source = await makeCheckout(fx.root, bare, "source");
    await writeFile(join(source, ".gitignore"), "dist/\n.env\n");
    git(source, "rm", "-r", "--cached", "widget/dist");
    git(source, "add", ".gitignore");
    git(source, ...AUTHOR, "commit", "-m", "build outputs are local");
    git(source, "push");
    await writeFile(join(source, "widget/dist/src/value.js"), "export const answer = 42;\n");
    await writeFile(join(source, "widget/dist/src/index.js"), "export { answer } from './value.js';\n");
    await writeFile(join(source, "widget/.env"), "LOCAL_ONLY=true\n");
    const fork = join(fx.home, "packages/widget-mine");
    forkPackage({ from: join(source, "widget"), to: fork, name: "@dev/widget-mine", version: "1.0.0-fork.1", root: fx.home, origin: { name: "@dev/widget", version: "1.0.0" } });
    const env = makeEnv(fx.home, { config: { targets: [{ name: "registry", url: `file://${bare}`, branch: "main" }] } });
    const args = { package: fork, as, version: "1.0.1" };
    const dir = as === "origin" ? "widget" : "widget-mine";
    const preview = await publish({ ...args, dryRun: true }, env);
    assert.ok(preview.files.includes(`${dir}/dist/src/index.js`), "the preview includes the runtime entrypoint");
    assert.ok(preview.files.includes(`${dir}/dist/src/value.js`), "the entrypoint's sibling modules go too");
    const result = await publish(args, env);
    assert.equal(result.pushed, true);
    assert.ok(!result.files.some((file) => file.endsWith("/.env")), "unrelated ignored files stay local");
    const fresh = await makeCheckout(fx.root, bare, "fresh");
    const published = JSON.parse(await readFile(join(fresh, dir, "package.json"), "utf8"));
    assert.equal(published.scripts, undefined, "the copied fork runs its edited build without rebuilding the source");
    assert.equal((await import(pathToFileURL(join(fresh, dir, published.main)).href)).answer, 42);
  });
}

test("a skill-only fork has no runtime entrypoint to stage", async (t) => {
  const fx = await temp();
  t.after(fx.cleanup);
  const bare = await makeRegistry(fx.root, "registry");
  const source = await makePackage(join(fx.home, "skills"), { name: "@dev/skills", version: "1.0.0", thetis: { type: "skills" } });
  const fork = join(fx.home, "packages/skills-mine");
  forkPackage({ from: source, to: fork, name: "@dev/skills-mine", version: "1.0.0-fork.1", root: fx.home, origin: { name: "@dev/skills", version: "1.0.0" } });
  // makePackage supplies index.js by default; a real skill pack does not need one.
  await import("node:fs/promises").then((fs) => fs.rm(join(fork, "index.js")));
  const env = makeEnv(fx.home, { config: { targets: [{ name: "registry", url: `file://${bare}` }] } });
  const result = await publish({ package: fork }, env);
  assert.equal(result.pushed, true);
  assert.deepEqual(result.files, ["skills-mine/package.json"]);
});

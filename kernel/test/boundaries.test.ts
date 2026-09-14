// The layering rule: mechanism lives in lib and sandbox, authority in the kernel, wiring in the host.
// A package may import only from the packages below it. The kernel never sees the sandbox or the host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** What each package's `src` may import from the `@thetis` scope. */
const ALLOWED: Record<string, string[]> = {
  contracts: [],
  lib: ["contracts"],
  sandbox: ["contracts", "lib"],
  kernel: ["contracts", "lib"],
  host: ["contracts", "lib", "sandbox", "kernel"],
};

/** Besides the host, only the command line (a host process) may depend on the kernel. */
const MAY_IMPORT_KERNEL = new Set(["host", "gateway-cli"]);

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function thetisImports(file: string): string[] {
  const names = new Set<string>();
  for (const m of readFileSync(file, "utf8").matchAll(/from\s+["']@thetis\/([a-z-]+)(?:\/[^"']*)?["']/g)) names.add(m[1]);
  return [...names];
}

function sourcesOf(pkg: string): string[] {
  const dir = join(PACKAGES, pkg, "src");
  try {
    return walk(dir);
  } catch {
    return [];
  }
}

test("the layers import only downward: contracts < lib < sandbox, kernel < host", () => {
  for (const [pkg, allowed] of Object.entries(ALLOWED)) {
    const files = sourcesOf(pkg);
    assert.ok(files.length > 0, `${pkg} has sources`);
    for (const file of files) {
      const bad = thetisImports(file).filter((name) => !allowed.includes(name));
      assert.deepEqual(bad, [], `${file.slice(PACKAGES.length + 1)} imports @thetis/${bad.join(", ")}`);
    }
  }
});

test("no package other than the host and the command line imports the kernel", () => {
  const offenders: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    if (pkg === "kernel" || MAY_IMPORT_KERNEL.has(pkg)) continue;
    for (const file of sourcesOf(pkg)) if (thetisImports(file).includes("kernel")) offenders.push(file.slice(PACKAGES.length + 1));
  }
  assert.deepEqual(offenders, []);
});

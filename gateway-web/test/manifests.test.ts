// Every package in this checkout that declares `thetis.ui` must pass the gateway's own check. A refused
// manifest takes the whole extension down (every command answers 404), so a label one character too long
// must fail here rather than on the live page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PackageInfo } from "@thetis/runtime/contracts";
import { validateUi } from "../src/ui.js";

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("every checked-in thetis.ui manifest is accepted by the gateway", () => {
  const store = mkdtempSync(join(tmpdir(), "thetis-manifests-"));
  try {
    const refused: string[] = [];
    let checked = 0;
    for (const dir of readdirSync(PACKAGES)) {
      const file = join(PACKAGES, dir, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name: string; thetis?: { ui?: unknown } };
      if (pkg.thetis?.ui === undefined) continue;
      const link = join(store, "node_modules", pkg.name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(PACKAGES, dir), link);
      const result = validateUi(pkg as unknown as PackageInfo, store);
      if ("error" in result) refused.push(`${pkg.name}: ${result.error}`);
      checked++;
    }
    assert.ok(checked > 5, `only ${checked} manifests found under ${PACKAGES}`);
    assert.deepEqual(refused, []);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

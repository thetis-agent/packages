// The build id: one short hash that changes whenever the code a page runs could have changed. A page keeps
// the id it was loaded with and compares it with the one each new event stream opens with; a different id
// means this page is running yesterday's JavaScript, and it refreshes itself (see assets/app.js). What goes
// in is what a page actually loads: this package's version and the modification times of its browser files,
// the version of every installed package that adds browser files, and the runtime's commit when it can be
// read cheaply. Nothing in here may fail a request: every part that cannot be read is simply left out.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PackageInfo } from "@thetis/runtime/contracts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** This package's own version, from its manifest; "" when it cannot be read. */
function ownVersion(): string {
  try {
    return String(JSON.parse(readFileSync(resolve(HERE, "../../package.json"), "utf8")).version ?? "");
  } catch {
    return "";
  }
}

/** Every file under `dir` with its modification time, sorted, so the same tree always hashes the same. */
function mtimes(dir: string, into: string[] = [], prefix = ""): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return into;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) mtimes(path, into, `${prefix}${name}/`);
      else into.push(`${prefix}${name}:${Math.round(stat.mtimeMs)}`);
    } catch {
      // A file removed between the listing and the stat is not part of any build.
    }
  }
  return into;
}

/**
 * The runtime's commit, read from the checkout's `.git` without running git: HEAD, then the branch it
 * names, loose or packed. Answers "" when the runtime is not a checkout or its `.git` is not visible from
 * this fence, which is often the case and is fine: the gateway's own files and version are what matter most.
 */
function runtimeCommit(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve("@thetis/runtime")));
    for (let i = 0; i < 6; i++, dir = dirname(dir)) {
      let head: string;
      try {
        head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
      } catch {
        continue;
      }
      const ref = /^ref: (.+)$/.exec(head)?.[1];
      if (!ref) return head.slice(0, 12);
      try {
        return readFileSync(join(dir, ".git", ref), "utf8").trim().slice(0, 12);
      } catch {
        const packed = readFileSync(join(dir, ".git", "packed-refs"), "utf8");
        return (packed.split("\n").find((line) => line.endsWith(` ${ref}`)) ?? "").slice(0, 12);
      }
    }
  } catch {
    // Not resolvable from here: no commit, and no complaint.
  }
  return "";
}

/**
 * A function answering the current build id. The version and the commit are read once: they only change
 * when the gateway itself starts again. The files and the packages are read on every call, because a
 * browser file edited on disk or a package updated in place changes what the next page load gets.
 */
export function buildIdentity(assets: string): (packages?: PackageInfo[]) => { id: string } {
  const fixed = `gateway-web@${ownVersion()} runtime@${runtimeCommit()}`;
  return (packages = []) => {
    const hash = createHash("sha256").update(fixed);
    for (const line of mtimes(assets)) hash.update(`\n${line}`);
    for (const p of packages) if ((p.thetis as { ui?: unknown } | undefined)?.ui) hash.update(`\n${p.name}@${p.version}`);
    return { id: hash.digest("hex").slice(0, 16) };
  };
}

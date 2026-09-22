// Where this workspace may publish, and what each target already holds. Answered as fields rather than a
// sentence, because a page renders it as cards and a person wants to know one thing from it: whether the
// version they are about to publish is in front of the one out there.
//
// Without a package it costs nothing: the configured list, and whether a clone is already on disk. With
// one it clones or fetches each target, because the only way to know what a registry holds is to look in
// it. A target that cannot be reached is reported on its own row and does not sink the answer: one
// unreachable registry should not hide what the other one holds.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeName, targetsOf, workDirOf } from "./config.js";
import { locate, resolvePackage } from "./locate.js";
import { lastPublish } from "./record.js";
import { compareVersions } from "./semver.js";

export async function targets(args = {}, env) {
  const config = env.config ?? {};
  const list = targetsOf(config);
  const workDir = workDirOf(env, config);
  const spec = typeof args.package === "string" && args.package.trim() ? args.package.trim() : null;
  // Unsound is reported, not thrown: being asked what the registries hold for a package is not the moment
  // to refuse it for a missing `main`. The publish is where the gates bite.
  const pkg = spec ? await resolvePackage(env, spec) : null;

  const rows = [];
  for (const target of list) {
    const repo = join(workDir, safeName(target.name));
    const row = {
      name: target.name,
      url: target.url,
      branch: target.branch,
      repo,
      cloned: existsSync(join(repo, ".git")),
      lastPublish: await lastPublish(env, target.name),
    };
    if (pkg) {
      try {
        const where = await locate(env, pkg, target, workDir);
        row.mode = where.mode;
        row.repo = where.repo;
        row.branch = where.branch;
        row.directory = where.dir;
        row.holds = where.holds;
        row.holdsName = where.holdsName;
        row.first = where.holds === null;
        // The one comparison a person is actually asking for: is what is on disk here in front of what is
        // out there, and so publishable as it stands?
        row.ahead = where.holds === null ? true : compareVersions(pkg.version, where.holds) > 0;
        row.cloned = existsSync(join(where.repo, ".git"));
        row.error = null;
      } catch (err) {
        row.error = err.message;
        row.code = err.code ?? null;
      }
    }
    rows.push(row);
  }

  return {
    workDir,
    defaultTarget: list.length === 1 ? list[0].name : null,
    package: pkg ? { name: pkg.name, version: pkg.version, path: pkg.path, directory: pkg.directory, installed: pkg.installed, problem: pkg.problem } : null,
    targets: rows,
  };
}

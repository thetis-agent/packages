// The act itself. Publishing a package is putting its directory into a registry repository at a new
// version, committing that one directory, and pushing: nothing else makes a new version visible to
// anybody's update check, and everything before the commit here is a gate that decides whether it should.
//
// The gates run before anything is written, in this order, because that is the order a person can act on:
// what is configured, what the package is, which package this publish is at all (a fork is two possible
// publishes and only the person knows which), what the registry already holds, what else is riding on the
// branch, and last the verify commands, which are the only ones that cost real time.
//
// What else is riding on the branch, and why consent for it is asked for by name, is in `passengers.js`.
// Which package a fork's publish is, and why the question is asked once rather than every time, is in
// `fork.js`. Both were moved out of here because a removal pushes a branch too and asks the same questions.
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { few, refuse, tail } from "./refuse.js";
import { pickTarget, verifyOf, workDirOf } from "./config.js";
import { chooseAs, forkedFrom, originVersion, unscoped } from "./fork.js";
import { asIdentity, FALLBACK_IDENTITY, git, gitSays, headCommit, identityOf, lines, mustGit } from "./git.js";
import { assertSound, withOrigin, withVersion } from "./manifest.js";
import { locate, resolvePackage } from "./locate.js";
import { cannotRide, journalRow, notNamed, rider, sortPassengers } from "./passengers.js";
import { recordPublish } from "./record.js";
import { bumpVersion, compareVersions, isVersion } from "./semver.js";

/** What a person and a page both read: the whole act as fields, no prose-only result. */
export async function publish(args = {}, env) {
  const config = env.config ?? {};
  const target = pickTarget(config, args.to);
  const pkg = await resolvePackage(env, args.package);
  await assertSound(pkg.manifest, pkg.path);
  // Named here so that a version or a step that makes no sense is refused before a registry is cloned. An
  // as-origin publish then works out its own version, because the fork's is never one of the origin's.
  const named = nextVersion(pkg, args);
  const dryRun = Boolean(args.dryRun);
  const origin = forkedFrom(pkg.manifest);

  const workDir = workDirOf(env, config);
  await mkdir(workDir, { recursive: true });
  const found = await locate(env, pkg, target, workDir, origin?.name);

  const blockers = [];
  const stop = (code, message, details) => {
    if (!dryRun) refuse(code, message, details);
    blockers.push({ code, message, ...(details ? { details } : {}) });
  };

  // Which publish this is. A fork of something the target already holds is two acts wearing one set of
  // words, so it is refused until the person says which; everything else is a publish of itself.
  const choice = chooseAs({ args, spec: typeof args.package === "string" ? args.package.trim() : pkg.name, pkg, origin, where: found, target });
  if (choice.blocker) stop(choice.blocker.code, choice.blocker.message, { origin: found.origin, fork: { name: pkg.name, version: pkg.version } });
  const asOrigin = choice.as === "origin";

  // As its origin, the publish is aimed at the origin's own directory and measured against the origin's own
  // version. Everything downstream then reads exactly as an ordinary publish of that package, which is what
  // it is: what lands in the registry is the origin at a new version, not a copy of it under another name.
  const where = asOrigin ? { ...found, dir: found.origin?.dir ?? unscoped(origin.name), holds: found.origin?.version ?? null, holdsName: found.origin?.name ?? null } : found;
  const name = asOrigin ? origin.name : pkg.name;
  const now = asOrigin ? originVersion({ args, pkg, origin, holds: where.holds, target }) : named;

  // A directory in the registry that holds some other package is the one way the destination can be wrong
  // without anything else looking wrong, and the copy would overwrite it. It is measured against the name
  // this publish carries, not the name on disk: a fork going out as its origin lands in the origin's
  // directory on purpose, and that directory holding the origin is the thing that makes it right.
  if (where.holdsName && where.holdsName !== name) {
    refuse("name-mismatch", `${target.name} already holds ${where.holdsName} in ${where.dir}/, so publishing ${name} there would replace it. Rename this package's directory, or take that one out of the registry, and publish again.`);
  }

  // The central rule. A version that does not move past what the registry holds is a publish nobody's
  // update check can see: the marketplace index would carry the same version it carried before, every
  // installation would go on believing it is current, and the work would be invisible.
  const first = where.holds === null;
  if (!first && compareVersions(now, where.holds) <= 0) {
    refuse("not-newer", `${name} ${now} does not move past ${where.holds}, which ${target.name} already holds, so no update check anywhere would see this publish. Raise the version to ${bumpVersion(where.holds, "patch") ?? "something higher"} or later, then publish it.`);
  }

  const { named: riders, unnamed, blocked } = sortPassengers(where, target, args.with);

  // The two gates about the state of the tree around the package, rather than about this publish being a
  // good one. A dry run reports them instead of refusing: it changes nothing, so there is nothing to
  // protect, and "what would this publish, and what could I add?" is answered properly only by naming
  // both the passengers and the ones that could come along.

  // Only this package's directory goes into the commit. Anything else staged would be left behind without
  // a word, which is how half a tree ends up in one commit or a real change ends up in none.
  if (where.staged.length) {
    stop("dirty-index", `Other files are staged in ${where.repo}: ${few(where.staged)}. A publish commits only ${where.dir}/, so those would be left behind. Unstage them with git restore --staged <path>, or commit them yourself, and publish again.`, where.staged);
  }
  if (blocked.length) stop("unpushed-others", cannotRide(blocked, unnamed, target, where), { blocked, nameable: unnamed });
  else if (unnamed.length) stop("unnamed-others", notNamed(unnamed, target, where), { nameable: unnamed });

  const riding = blockers.length ? [] : riders;
  const verify = blockers.length ? null : await runVerify(env, config, name, pkg.path);
  // A rider is a publish in its own right, so it is verified like one. Publishing code nobody checked is
  // the thing `verify` exists to prevent, and it would be a strange exemption to grant to the package
  // that got in by being committed early.
  for (const one of riding) one.verify = await runVerify(env, config, one.package, join(where.repo, one.dir));

  // Everything from here changes something. In a dry run it stops at the commit, having done the clone,
  // the copy and the staging list, so what it reports is what would happen and not a guess at it.
  //
  // A fork going out as its origin never writes its own manifest: the person goes on running their fork,
  // under their own name and at their own version, and what the registry gets is written into the copy.
  if (!dryRun && !asOrigin && now !== pkg.version) await env.writeFile(join(pkg.path, "package.json"), withVersion(pkg.text, pkg.manifest, now));
  if (where.mode === "copy") await copyInto(pkg.path, join(where.repo, where.dir));
  if (asOrigin) await env.writeFile(join(where.repo, where.dir, "package.json"), withOrigin(pkg.manifest, origin.name, now));

  const files = dryRun ? await wouldStage(env, where, pkg, now, asOrigin) : await stage(env, where);
  const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : `${name} ${now}`;
  // A fence is a container with no ~/.gitconfig, so git would stop the publish halfway through with
  // "please tell me who you are". One is supplied instead, and the answer says which one signed the commit.
  const configured = await identityOf(env, where.repo);
  const author = configured ?? `${FALLBACK_IDENTITY.name} <${FALLBACK_IDENTITY.email}>`;

  const answer = {
    ok: true,
    dryRun,
    package: name,
    from: pkg.path,
    mode: where.mode,
    /** Which of the two publishes a fork's was. `itself` for everything that is not a fork's. */
    as: choice.as,
    /** The origin this package's manifest names, whichever way it went out, or null. */
    forkedFrom: origin?.name ?? null,
    /** Set only when the origin is what was published: the copy the code came out of, left as it was. */
    fork: asOrigin ? { name: pkg.name, version: pkg.version } : null,
    target: target.name,
    url: where.url,
    branch: where.branch,
    directory: where.dir,
    repo: where.repo,
    was: where.holds,
    now,
    first,
    bump: typeof args.bump === "string" ? args.bump : null,
    files,
    author,
    verify,
    commit: null,
    committed: false,
    pushed: false,
    others: where.others,
    /** The publishable passengers, whether or not they were named: what `with` could take. */
    nameable: unnamed.concat(riders).map((p) => p.package).sort(),
    with: [],
  };
  if (dryRun) {
    answer.blockers = blockers;
    answer.ok = blockers.length === 0;
    answer.with = riding.map((r) => rider(r, answer));
    answer.journals = [journalRow(answer, answer), ...answer.with.map((r) => journalRow(r, answer))];
    answer.summary = summarise(answer, blockers);
    return answer;
  }

  if (files.length) {
    const commit = await git(env, where.repo, [...asIdentity(configured), "commit", "-m", message, "--", where.dir]);
    if (commit.code !== 0) refuse("git", `Could not commit ${where.dir}/ in ${where.repo}: ${gitSays(commit)}`);
    answer.committed = true;
  }
  answer.commit = await headCommit(env, where.repo);
  if (!answer.commit) refuse("git", `${where.repo} has no commit to push after committing ${where.dir}/. Nothing was pushed.`);

  const push = await git(env, where.repo, ["push", "origin", `HEAD:refs/heads/${where.branch}`], { timeoutMs: 600_000 });
  if (push.code !== 0) {
    refuse("push", `The push to ${target.name} (${where.url}, branch ${where.branch}) was refused: ${gitSays(push)}. The commit is in ${where.repo}; nothing in the registry has changed.`);
  }
  answer.pushed = true;
  answer.shortCommit = answer.commit.slice(0, 7);
  answer.with = riding.map((r) => rider(r, answer));
  // What the marketplace will pin once it next refreshes, and the plain fact that it has not yet. The
  // registry holds this now; the index a gallery reads does not, and will not until the service's next
  // refresh, which is its own schedule and nothing here can hurry. A caller that does not say so shows a
  // badge with the old version on it and looks like nothing happened.
  answer.source = `${where.url}#${where.dir}@${answer.commit}`;
  answer.indexed = false;
  answer.journals = [journalRow(answer, answer), ...answer.with.map((r) => journalRow(r, answer))];
  answer.summary = summarise(answer, blockers);
  answer.records = await recordPublish(env, answer);
  return answer;
}

function summarise(answer, blockers) {
  const moved = answer.first ? `${answer.now}, a first publish,` : `${answer.was} to ${answer.now}`;
  const along = answer.with.length ? ` Along with it: ${answer.with.map((r) => `${r.package} ${r.first ? r.now : `${r.was} to ${r.now}`}`).join(", ")}.` : "";
  // Said on every as-origin publish, because the one thing a person could reasonably assume happened is
  // the one thing that did not: their own copy is untouched and still a fork, under its own name.
  const outOf = answer.fork ? ` Your copy is still ${answer.fork.name} ${answer.fork.version}, a fork.` : "";
  const from = answer.fork ? ` out of ${answer.fork.name}` : "";
  if (answer.dryRun) {
    const refused = blockers.length ? `, but the publish would be refused (${blockers.map((b) => b.code).join(", ")})` : "";
    return `dry run: ${answer.package} ${moved} would go to ${answer.target} (${answer.branch})${from}: ${answer.files.length} file(s)${refused}.${along}${outOf} Nothing was committed or pushed.`;
  }
  return `${answer.package} ${moved} published to ${answer.target} (${answer.branch})${from} as ${answer.shortCommit}: ${answer.files.length} file(s).${along}${outOf} The marketplace index catches up on its next refresh.`;
}

/** The version this publish sets: named, one step along, or the one the manifest already carries. */
function nextVersion(pkg, args) {
  const named = typeof args.version === "string" && args.version.trim() ? args.version.trim() : null;
  const how = typeof args.bump === "string" && args.bump.trim() ? args.bump.trim() : null;
  if (named && how) refuse("bad-version", `Say which version to publish, or ask for a patch, minor or major step from ${pkg.version}, but not both at once.`);
  if (named) {
    if (!isVersion(named)) refuse("bad-version", `${named} is not a semantic version like 1.2.0, and every registry compares versions.`);
    return named;
  }
  if (how) {
    if (!["patch", "minor", "major"].includes(how)) refuse("bad-version", `A step is patch, minor or major, not ${how}.`);
    const next = bumpVersion(pkg.version, how);
    if (!next) refuse("bad-version", `${pkg.name} is at ${pkg.version}, which is not a semantic version, so there is no ${how} step from it. Give it the version to publish instead.`);
    return next;
  }
  return pkg.version;
}

export async function runVerify(env, config, name, path) {
  const command = verifyOf(config);
  if (!command) return null;
  const r = await env.exec(command, { cwd: path, timeoutMs: 600_000 });
  if (r.code !== 0) {
    refuse("verify-failed", `verify refused ${name}: \`${command}\` exited ${r.code} in ${path}. ${tail(r.stderr || r.stdout)} Fix it, or clear the verify setting, and publish again.`);
  }
  return { command, code: 0 };
}

/**
 * The package's directory as the registry will hold it. The destination is removed first so that a file
 * the package no longer has stops being in the registry: a copy over the top would leave it there for
 * ever, and nobody would ever notice which of the two trees it came from. `node_modules` and any `.git`
 * inside the package never travel.
 */
async function copyInto(from, dest) {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(from, dest, { recursive: true, filter: (src) => src === from || !["node_modules", ".git"].includes(basename(src)) });
}

/** Stage this package's directory and answer with what is in the index for it. */
async function stage(env, where) {
  await mustGit(env, where.repo, ["add", "-A", "--", where.dir], `could not stage ${where.dir}/ in ${where.repo}`);
  const diff = await git(env, where.repo, ["diff", "--cached", "--name-only", "--", where.dir]);
  // On a branch with no commit on it yet there is no HEAD to diff against, and git says so rather than
  // treating it as the empty tree. The index itself is then the whole answer.
  return diff.code === 0 ? lines(diff) : lines(await git(env, where.repo, ["ls-files", "--cached", "--", where.dir]));
}

/**
 * What staging would put in the commit, without touching the index. A dry run in the maintainer's checkout
 * must leave their index exactly as it found it, so `add --dry-run` does the listing. The version is the
 * one thing that is not written in a dry run, so the manifest is named explicitly when it would move. An
 * as-origin publish writes its manifest into the copy either way, so there is nothing to make up for.
 */
async function wouldStage(env, where, pkg, now, asOrigin) {
  const r = await git(env, where.repo, ["add", "-A", "--dry-run", "--", where.dir]);
  const files = lines(r)
    .map((l) => /^(?:add|remove)\s+'(.*)'$/.exec(l)?.[1])
    .filter(Boolean);
  const manifest = `${where.dir}/package.json`;
  if (!asOrigin && now !== pkg.version && !files.includes(manifest)) files.push(manifest);
  return files.sort();
}

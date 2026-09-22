// The act itself. Publishing a package is putting its directory into a registry repository at a new
// version, committing that one directory, and pushing: nothing else makes a new version visible to
// anybody's update check, and everything before the commit here is a gate that decides whether it should.
//
// The gates run before anything is written, in this order, because that is the order a person can act on:
// what is configured, what the package is, what the registry already holds, what else is riding on the
// branch, and last the verify commands, which are the only ones that cost real time.
//
// Scoping the commit does not scope the push. `git push` sends the branch, so a branch already carrying
// commits to other packages carries them to the registry however carefully this code commits. That cannot
// be fixed by committing better, and the two ways of handling it are both wrong: refusing on every
// passenger costs a branch dance often enough that the tool gets routed around with a plain `git push`,
// which is the behaviour this package exists to stop, and letting a passenger ride because its version
// moved reads consent into a version bump, which a person does to test something as readily as to ship
// it. So consent is asked for instead, by name, in `with`, and it is cheap: one argument. What can never
// be consented to is a passenger that is not publishable on its own, because its code would land in the
// registry under a version every installation already holds and no update check will look at again.
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { few, refuse, tail } from "./refuse.js";
import { pickTarget, verifyOf, workDirOf } from "./config.js";
import { asIdentity, FALLBACK_IDENTITY, git, gitSays, headCommit, identityOf, lines, mustGit } from "./git.js";
import { assertSound, withVersion } from "./manifest.js";
import { locate, resolvePackage } from "./locate.js";
import { recordPublish } from "./record.js";
import { bumpVersion, compareVersions, isVersion } from "./semver.js";

/** What a person and a page both read: the whole act as fields, no prose-only result. */
export async function publish(args = {}, env) {
  const config = env.config ?? {};
  const target = pickTarget(config, args.to);
  const pkg = await resolvePackage(env, args.package);
  await assertSound(pkg.manifest, pkg.path);
  const now = nextVersion(pkg, args);
  const dryRun = Boolean(args.dryRun);

  const workDir = workDirOf(env, config);
  await mkdir(workDir, { recursive: true });
  const where = await locate(env, pkg, target, workDir);

  // A directory in the registry that holds some other package is the one way the destination can be wrong
  // without anything else looking wrong, and the copy would overwrite it.
  if (where.holdsName && where.holdsName !== pkg.name) {
    refuse("name-mismatch", `${target.name} already holds ${where.holdsName} in ${where.dir}/, so publishing ${pkg.name} there would replace it. Rename this package's directory, or take that one out of the registry, and publish again.`);
  }

  // The central rule. A version that does not move past what the registry holds is a publish nobody's
  // update check can see: the marketplace index would carry the same version it carried before, every
  // installation would go on believing it is current, and the work would be invisible.
  const first = where.holds === null;
  if (!first && compareVersions(now, where.holds) <= 0) {
    refuse("not-newer", `${pkg.name} ${now} does not move past ${where.holds}, which ${target.name} already holds, so no update check anywhere would see this publish. Raise the version to ${bumpVersion(where.holds, "patch") ?? "something higher"} or later, then publish it.`);
  }

  const { named, unnamed, blocked } = sortPassengers(where, target, args.with);

  // The two gates about the state of the tree around the package, rather than about this publish being a
  // good one. A dry run reports them instead of refusing: it changes nothing, so there is nothing to
  // protect, and "what would this publish, and what could I add?" is answered properly only by naming
  // both the passengers and the ones that could come along.
  const blockers = [];
  const stop = (code, message, details) => {
    if (!dryRun) refuse(code, message, details);
    blockers.push({ code, message, ...(details ? { details } : {}) });
  };

  // Only this package's directory goes into the commit. Anything else staged would be left behind without
  // a word, which is how half a tree ends up in one commit or a real change ends up in none.
  if (where.staged.length) {
    stop("dirty-index", `Other files are staged in ${where.repo}: ${few(where.staged)}. A publish commits only ${where.dir}/, so those would be left behind. Unstage them with git restore --staged <path>, or commit them yourself, and publish again.`, where.staged);
  }
  if (blocked.length) stop("unpushed-others", cannotRide(blocked, unnamed, target, where), { blocked, nameable: unnamed });
  else if (unnamed.length) stop("unnamed-others", notNamed(unnamed, target, where), { nameable: unnamed });

  const riders = blockers.length ? [] : named;
  const verify = blockers.length ? null : await runVerify(env, config, pkg.name, pkg.path);
  // A rider is a publish in its own right, so it is verified like one. Publishing code nobody checked is
  // the thing `verify` exists to prevent, and it would be a strange exemption to grant to the package
  // that got in by being committed early.
  for (const rider of riders) rider.verify = await runVerify(env, config, rider.package, join(where.repo, rider.dir));

  // Everything from here changes something. In a dry run it stops at the commit, having done the clone,
  // the copy and the staging list, so what it reports is what would happen and not a guess at it.
  if (!dryRun && now !== pkg.version) await env.writeFile(join(pkg.path, "package.json"), withVersion(pkg.text, pkg.manifest, now));
  if (where.mode === "copy") await copyInto(pkg.path, join(where.repo, where.dir));

  const files = dryRun ? await wouldStage(env, where, pkg, now) : await stage(env, where);
  const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : `${pkg.name} ${now}`;
  // A fence is a container with no ~/.gitconfig, so git would stop the publish halfway through with
  // "please tell me who you are". One is supplied instead, and the answer says which one signed the commit.
  const configured = await identityOf(env, where.repo);
  const author = configured ?? `${FALLBACK_IDENTITY.name} <${FALLBACK_IDENTITY.email}>`;

  const answer = {
    ok: true,
    dryRun,
    package: pkg.name,
    from: pkg.path,
    mode: where.mode,
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
    nameable: unnamed.concat(named).map((p) => p.package).sort(),
    with: [],
  };
  if (dryRun) {
    answer.blockers = blockers;
    answer.ok = blockers.length === 0;
    answer.with = riders.map((r) => rider(r, answer));
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
  answer.with = riders.map((r) => rider(r, answer));
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

/** One rider as a result of its own, not a name: everything a card shows for the package it published. */
function rider(row, answer) {
  return {
    package: row.package,
    directory: row.dir,
    was: row.holds,
    now: row.version,
    first: row.holds === null,
    files: row.files,
    commit: answer.commit,
    verify: row.verify ?? null,
    source: answer.commit ? `${answer.url}#${row.dir}@${answer.commit}` : null,
  };
}

/**
 * The passengers, split the three ways that decide what happens: named and allowed to ride, publishable
 * but not named, and not publishable at all. Naming something that is not riding, or something that can
 * never ride, is a refusal here and not on a dry run's blocker list: those are mistakes in the call, like
 * giving both a version and a step, and reporting them as findings would be reporting back the caller's
 * own typing.
 */
function sortPassengers(where, target, asked) {
  const wanted = (Array.isArray(asked) ? asked : asked === undefined || asked === null ? [] : [asked]).map((x) => String(x).trim()).filter(Boolean);
  const riding = where.others;
  const named = [];
  for (const name of wanted) {
    const found = riding.find((p) => p.package === name || p.dir === name);
    if (!found) {
      const what = riding.length ? `What is riding is ${few(riding.map((p) => p.package ?? `${p.dir}/`))}.` : "Nothing else is riding on this branch.";
      refuse("not-a-passenger", `${name} is not riding on this branch: nothing outside ${where.dir}/ is committed for it, so publishing it alongside would do nothing. ${what}`);
    }
    if (!found.publishable) {
      refuse("unpushed-others", `${name} cannot be published: ${why(found, target)}. Naming it alongside ${where.dir}/ changes nothing about that. Move it off this branch first: git branch keep; git reset --hard origin/${where.branch}.`, [found]);
    }
    if (!named.includes(found)) named.push(found);
  }
  return {
    named,
    unnamed: riding.filter((p) => p.publishable && !named.includes(p)),
    blocked: riding.filter((p) => !p.publishable),
  };
}

/** Why one passenger cannot be published, as a clause. Built here, where the target has a name. */
function why(p, target) {
  if (p.reason === "not-a-package") return `${p.dir}/ is not a package`;
  if (p.reason === "manifest") return p.problem;
  if (p.reason === "name-mismatch") return `${target.name} holds ${p.dir}/ as ${p.holdsName}, not ${p.package}`;
  return `${p.package} is ${p.version} here and in ${target.name}, so its code would land under a version every installation already believes it has`;
}

/** What one publishable passenger is, as a clause: the version here against the version out there. */
const offer = (p, target) => `${p.package} ${p.version} here, ${p.holds ?? "not held"} in ${target.name}`;

const listed = (parts) => (parts.length <= 3 ? parts.join("; ") : `${parts.slice(0, 3).join("; ")}; and ${parts.length - 3} more`);

const carries = (where, target) => `Commits on this branch touch more than ${where.dir}/ and are not in ${target.name} yet, and a publish pushes the branch, so they would go with it`;

/**
 * The refusal when something riding cannot be published. This one is absolute, so the sentence does not
 * offer a way to consent to it; it offers the only procedure that works. Anything that could have ridden
 * is mentioned at the end, so the person is not refused twice over the same branch.
 */
function cannotRide(blocked, nameable, target, where) {
  const also = nameable.length ? ` Once they are off the branch, ${listed(nameable.map((p) => offer(p, target)))} could go along with it.` : "";
  return `${carries(where, target)}. These cannot be published, and saying you want them anyway will not change that: ${listed(blocked.map((p) => why(p, target)))}. Put them aside and bring things back one at a time: git branch keep; git reset --hard origin/${where.branch}; git checkout keep -- ${where.dir}; then publish ${where.dir}/, and each of the others in its turn.${also}`;
}

/**
 * The refusal when everything riding could be published and nobody said so. This is the common one, so it
 * asks for one word rather than a procedure. A version bump is not consent: a person raises a version to
 * try something as readily as to ship it, so the publish is the moment to say which it was.
 */
function notNamed(nameable, target, where) {
  const names = nameable.map((p) => p.package);
  return `${carries(where, target)}: ${listed(nameable.map((p) => offer(p, target)))}. Each of those can be published in its own right, but a version having moved is not the same as meaning to ship it, so nothing goes that you did not ask for. Publish them deliberately alongside this one (thetis publish ${where.dir} ${names.map((n) => `--with ${n}`).join(" ")}), or move them off this branch first: git branch keep; git reset --hard origin/${where.branch}; git checkout keep -- ${where.dir}.`;
}

function summarise(answer, blockers) {
  const moved = answer.first ? `${answer.now}, a first publish,` : `${answer.was} to ${answer.now}`;
  const along = answer.with.length ? ` Along with it: ${answer.with.map((r) => `${r.package} ${r.first ? r.now : `${r.was} to ${r.now}`}`).join(", ")}.` : "";
  if (answer.dryRun) {
    const refused = blockers.length ? `, but the publish would be refused (${blockers.map((b) => b.code).join(", ")})` : "";
    return `dry run: ${answer.package} ${moved} would go to ${answer.target} (${answer.branch}): ${answer.files.length} file(s)${refused}.${along} Nothing was committed or pushed.`;
  }
  return `${answer.package} ${moved} published to ${answer.target} (${answer.branch}) as ${answer.shortCommit}: ${answer.files.length} file(s).${along} The marketplace index catches up on its next refresh.`;
}

/**
 * The row each published package is worth in the kernel's journal, in the shape the admin History view
 * renders. There is no seam for a package inside a fence to append to that journal: `ToolEnv` has no
 * `journal`, only a host package's `HostEnv` does, and the operator channel has `journal.tail` and nothing
 * that writes. So the rows are returned rather than written, in `answer.journals`, for a caller that has
 * the seam. It is a list and not a single row because one act can publish more than one package, and a
 * field that could only ever say one of them would be a lie the moment `with` is used.
 */
function journalRow(row, answer) {
  return {
    kind: "package.publish",
    target: row.package,
    data: {
      name: row.package,
      ...(row.first ? {} : { was: row.was }),
      version: row.now,
      target: answer.target,
      url: answer.url,
      branch: answer.branch,
      commit: answer.commit,
      first: row.first,
    },
  };
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

async function runVerify(env, config, name, path) {
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
 * one thing that is not written in a dry run, so the manifest is named explicitly when it would move.
 */
async function wouldStage(env, where, pkg, now) {
  const r = await git(env, where.repo, ["add", "-A", "--dry-run", "--", where.dir]);
  const files = lines(r)
    .map((l) => /^(?:add|remove)\s+'(.*)'$/.exec(l)?.[1])
    .filter(Boolean);
  const manifest = `${where.dir}/package.json`;
  if (now !== pkg.version && !files.includes(manifest)) files.push(manifest);
  return files.sort();
}

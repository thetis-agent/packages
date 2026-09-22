// Taking a package out of a registry, which is the one thing publishing could not do.
//
// A registry is a git repository and a package is a directory in it, so a removal is exactly: delete that
// directory, commit it, push. `publish` only ever adds and updates, and a package that went out by mistake
// or has been retired stayed in the index for ever; `thetis packages uninstall` takes it off one person and
// touches no registry at all.
//
// It is a tool and a verb of its own rather than an argument to `publish_package`, and deliberately so. An
// argument that inverts what a command does is how people delete things by accident: `publish --remove` is
// one word away from a publish in a shell history, in a retry after a typo, in a model's second attempt at
// a call it got wrong the first time, and the two acts share almost no arguments -- there is no version, no
// step, no verify, and nothing to copy. What they do share is the branch, and that is shared as code.
//
// What a removal does and does not do is said in the answer, because the two halves are easy to confuse.
// The package leaves the registry now and leaves the marketplace index at its next refresh, so nobody
// installs it again. Every installation that already has it keeps it, goes on running it, and is not told:
// `behind` leaves a package the index no longer carries alone, because a registry dropping a package is
// not the same thing as a package being out of date. That is deliberate and it is the only safe default,
// but it means a removal is not a recall.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { few, refuse } from "./refuse.js";
import { pickTarget, workDirOf } from "./config.js";
import { unscoped } from "./fork.js";
import { asIdentity, FALLBACK_IDENTITY, git, gitSays, headCommit, identityOf, lines, mustGit } from "./git.js";
import { locate, locateInClone, resolvePackage } from "./locate.js";
import { cannotRide, journalRow, notNamed, rider, sortPassengers } from "./passengers.js";
import { recordUnpublish } from "./record.js";
import { runVerify } from "./publish.js";

/** The same fields a publish answers, for the act that is its opposite. */
export async function unpublish(args = {}, env) {
  const config = env.config ?? {};
  const target = pickTarget(config, args.to);
  const asked = typeof args.package === "string" && args.package.trim() ? args.package.trim() : null;
  if (!asked) refuse("no-package", "unpublish needs a package: the name a registry holds it under, such as @alice/hello, or the directory it keeps it in.");
  const dryRun = Boolean(args.dryRun);

  const workDir = workDirOf(env, config);
  await mkdir(workDir, { recursive: true });
  const { where, identity } = await whereHeld(env, asked, target, workDir);

  // The target has to actually hold it. Removing what is not there is not harmless: it is a person who
  // believes a package is gone from a registry that is still serving it, which is the same mistake as a
  // publish nobody's update check sees, told the other way round.
  if (!where.holdsName) {
    refuse("not-held", `${target.name} does not hold ${identity} on ${where.branch}, so there is nothing to take out of it. Check the name against what the registry holds, or the target, and try again.`);
  }
  // Found by name is safe. Found because the directory happened to be spelled the way the name was is only
  // safe when that is literally what was asked for, and never when the directory holds something else.
  if (where.holdsName !== identity && where.dir !== asked) {
    refuse("name-mismatch", `${target.name} holds ${where.holdsName} in ${where.dir}/, not ${identity}, so removing that directory would take somebody else's package out instead. Name the package the registry holds, or the directory it is in, and try again.`);
  }

  const name = where.holdsName;
  const held = where.holds;
  const about = { act: "removal", command: `thetis unpublish ${asked} --to ${target.name}`, then: `remove ${where.dir}/` };

  const blockers = [];
  const stop = (code, message, details) => {
    if (!dryRun) refuse(code, message, details);
    blockers.push({ code, message, ...(details ? { details } : {}) });
  };

  const { named: riders, unnamed, blocked } = sortPassengers(where, target, args.with);
  // The same three gates about the state of the tree, for the same reason: a removal commits one directory
  // and pushes a branch, and the branch is carrying whatever it was carrying before anybody typed this.
  if (where.staged.length) {
    stop("dirty-index", `Other files are staged in ${where.repo}: ${few(where.staged)}. A removal commits only ${where.dir}/, so those would be left behind. Unstage them with git restore --staged <path>, or commit them yourself, and try again.`, where.staged);
  }
  if (blocked.length) stop("unpushed-others", cannotRide(blocked, unnamed, target, where, about), { blocked, nameable: unnamed });
  else if (unnamed.length) stop("unnamed-others", notNamed(unnamed, target, where, about), { nameable: unnamed });

  const riding = blockers.length ? [] : riders;
  // A rider is a publish in its own right whatever it is riding with, so it is verified like one.
  for (const one of riding) one.verify = await runVerify(env, config, one.package, join(where.repo, one.dir));

  const files = dryRun ? await wouldRemove(env, where) : await removeDir(env, where);
  const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : `remove ${name} ${held}`;
  const configured = await identityOf(env, where.repo);
  const author = configured ?? `${FALLBACK_IDENTITY.name} <${FALLBACK_IDENTITY.email}>`;

  const answer = {
    ok: true,
    dryRun,
    removed: true,
    package: name,
    target: target.name,
    url: where.url,
    branch: where.branch,
    directory: where.dir,
    repo: where.repo,
    mode: where.mode,
    /** The version the registry was holding when it went. There is no `now`: that is the point of this. */
    held,
    files,
    author,
    commit: null,
    committed: false,
    pushed: false,
    others: where.others,
    nameable: unnamed.concat(riders).map((p) => p.package).sort(),
    with: [],
  };
  if (dryRun) {
    answer.blockers = blockers;
    answer.ok = blockers.length === 0;
    answer.with = riding.map((r) => rider(r, answer));
    answer.journals = [removalRow(answer), ...answer.with.map((r) => journalRow(r, answer))];
    answer.summary = summarise(answer, blockers);
    return answer;
  }

  const commit = await git(env, where.repo, [...asIdentity(configured), "commit", "-m", message, "--", where.dir]);
  if (commit.code !== 0) refuse("git", `Could not commit the removal of ${where.dir}/ in ${where.repo}: ${gitSays(commit)}`);
  answer.committed = true;
  answer.commit = await headCommit(env, where.repo);
  if (!answer.commit) refuse("git", `${where.repo} has no commit to push after removing ${where.dir}/. Nothing was pushed.`);

  const push = await git(env, where.repo, ["push", "origin", `HEAD:refs/heads/${where.branch}`], { timeoutMs: 600_000 });
  if (push.code !== 0) {
    refuse("push", `The push to ${target.name} (${where.url}, branch ${where.branch}) was refused: ${gitSays(push)}. The commit is in ${where.repo}; nothing in the registry has changed.`);
  }
  answer.pushed = true;
  answer.shortCommit = answer.commit.slice(0, 7);
  answer.with = riding.map((r) => rider(r, answer));
  answer.indexed = false;
  answer.journals = [removalRow(answer), ...answer.with.map((r) => journalRow(r, answer))];
  answer.summary = summarise(answer, blockers);
  answer.records = await recordUnpublish(env, answer);
  return answer;
}

/**
 * The tree the removal happens in, and the name it is a removal of.
 *
 * A package can be taken out of a registry by somebody who does not have it: that is most of the point,
 * because a package published by mistake is often one nobody kept. So the local package is looked for and
 * not required. What it is needed for is the one case where the answer differs: a package inside a checkout
 * that *is* the registry, where there is nothing to clone and the removal is a commit in that checkout.
 */
async function whereHeld(env, asked, target, workDir) {
  const pkg = await localPackage(env, asked);
  if (pkg) return { where: await locate(env, pkg, target, workDir), identity: pkg.name ?? asked };
  return { where: await locateInClone(env, { name: asked, directory: unscoped(asked) }, target, workDir), identity: asked };
}

/** The package here under that name or path, or null. Its absence is an ordinary case, not a refusal. */
async function localPackage(env, asked) {
  try {
    return await resolvePackage(env, asked);
  } catch {
    return null;
  }
}

/** The directory taken out of the tree and out of the index, and the files that went with it. */
async function removeDir(env, where) {
  await mustGit(env, where.repo, ["rm", "-r", "-q", "--", where.dir], `could not remove ${where.dir}/ in ${where.repo}`);
  return lines(await git(env, where.repo, ["diff", "--cached", "--name-only", "--", where.dir]));
}

/** What the registry holds under that directory, read from its own branch, touching no index anywhere. */
async function wouldRemove(env, where) {
  return lines(await git(env, where.repo, ["ls-tree", "-r", "--name-only", `origin/${where.branch}`, "--", where.dir]));
}

/**
 * The journal row a removal is worth, which is its own kind. It is not a `package.publish` with a field
 * saying otherwise: a history that has to be read with a flag in mind is a history that gets misread, and
 * "this package left the registry" is a different event from "this package has a new version".
 */
function removalRow(answer) {
  return {
    kind: "package.unpublish",
    target: answer.package,
    data: {
      name: answer.package,
      version: answer.held,
      target: answer.target,
      url: answer.url,
      branch: answer.branch,
      directory: answer.directory,
      commit: answer.commit,
      files: answer.files.length,
    },
  };
}

/**
 * What it did, and in the same breath what it did not. The second half is the part people get wrong: a
 * removal reads like a recall and is nothing of the kind, so the sentence says both every time rather than
 * leaving the quiet half to be discovered by somebody still running the package a year later.
 */
function summarise(answer, blockers) {
  const along = answer.with.length ? ` Along with it: ${answer.with.map((r) => `${r.package} ${r.first ? r.now : `${r.was} to ${r.now}`}`).join(", ")}.` : "";
  const keeps = `It leaves the marketplace index at the next refresh, so nobody installs it again. Every installation that already has it keeps it, goes on running it, and is not told.`;
  // In a checkout that is the registry there is no copy to delete instead: the source and the registry are
  // the same directory, and the removal takes it. Nobody should learn that from `git status`.
  const source = answer.mode === "checkout" ? ` The directory is gone from ${answer.repo} as well, because that checkout is the registry; git has it in the history.` : "";
  if (answer.dryRun) {
    const refused = blockers.length ? `, but the removal would be refused (${blockers.map((b) => b.code).join(", ")})` : "";
    return `dry run: ${answer.package} ${answer.held} would be taken out of ${answer.target} (${answer.branch}): ${answer.directory}/, ${answer.files.length} file(s)${refused}.${along}${source} ${keeps} Nothing was committed or pushed.`;
  }
  return `${answer.package} ${answer.held} taken out of ${answer.target} (${answer.branch}) as ${answer.shortCommit}: ${answer.directory}/ is gone, ${answer.files.length} file(s).${along}${source} ${keeps}`;
}

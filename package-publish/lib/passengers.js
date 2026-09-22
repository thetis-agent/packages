// What else is riding on the branch, and the sentences about it.
//
// Scoping a commit does not scope the push. `git push` sends the branch, so a branch that already carries
// commits to other packages carries them to the registry however carefully anything here commits. That
// cannot be fixed by committing better, and the two obvious answers are both wrong: refusing on every
// passenger costs a branch dance often enough that the tool gets routed around with a plain `git push`,
// which is the behaviour this package exists to stop, and letting a passenger ride because its version
// moved reads consent into a version bump, which a person does to try something as readily as to ship it.
// So consent is asked for instead, by name, in `with`.
//
// This lives on its own because both acts that push a branch need it. A publish sends the branch, and so
// does a removal: taking a package out of a registry is a commit and a push like any other, and what the
// branch is carrying is exactly as much its business.
import { few, refuse } from "./refuse.js";

/**
 * The passengers, split the three ways that decide what happens: named and allowed to ride, publishable
 * but not named, and not publishable at all. Naming something that is not riding, or something that can
 * never ride, is a refusal here and not a dry run's blocker: those are mistakes in the call, like giving
 * both a version and a step, and reporting them as findings would be reporting back the caller's own typing.
 */
export function sortPassengers(where, target, asked) {
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

/** One rider as a result of its own, not a name: everything a card shows for the package it published. */
export function rider(row, answer) {
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
 * The row each published package is worth in the kernel's journal, in the shape the admin History view
 * renders. There is no seam for a package inside a fence to append to that journal: `ToolEnv` has no
 * `journal`, only a host package's `HostEnv` does, and the operator channel has `journal.tail` and nothing
 * that writes. So the rows are returned rather than written, in `answer.journals`, for a caller that has
 * the seam. It is a list and not a single row because one act can publish more than one package, and a
 * field that could only ever say one of them would be a lie the moment `with` is used.
 */
export function journalRow(row, answer) {
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
      // Only on a publish that went out as its origin: the fork the code actually came from. A year later
      // the row says "@dev/widget 0.2.0" and this is the only thing that says whose copy wrote it.
      ...(row.fork ? { fork: row.fork.name } : {}),
    },
  };
}

/** Why one passenger cannot be published, as a clause. Built here, where the target has a name. */
export function why(p, target) {
  if (p.reason === "not-a-package") return `${p.dir}/ is not a package`;
  if (p.reason === "manifest") return p.problem;
  if (p.reason === "name-mismatch") return `${target.name} holds ${p.dir}/ as ${p.holdsName}, not ${p.package}`;
  return `${p.package} is ${p.version} here and in ${target.name}, so its code would land under a version every installation already believes it has`;
}

/** What one publishable passenger is, as a clause: the version here against the version out there. */
const offer = (p, target) => `${p.package} ${p.version} here, ${p.holds ?? "not held"} in ${target.name}`;

const listed = (parts) => (parts.length <= 3 ? parts.join("; ") : `${parts.slice(0, 3).join("; ")}; and ${parts.length - 3} more`);

const carries = (where, target, about) => `Commits on this branch touch more than ${where.dir}/ and are not in ${target.name} yet, and a ${about.act} pushes the branch, so they would go with it`;

/**
 * What act these sentences are about. A removal pushes a branch exactly as a publish does, so it meets the
 * same two refusals, but it is not a publish and the way out of each one is spelled differently: the
 * command to type again, and what to do once the branch is clear.
 */
export const aPublish = (where) => ({ act: "publish", command: `thetis publish ${where.dir}`, then: `publish ${where.dir}/` });

/**
 * The refusal when something riding cannot be published. This one is absolute, so the sentence does not
 * offer a way to consent to it; it offers the only procedure that works. Anything that could have ridden
 * is mentioned at the end, so the person is not refused twice over the same branch.
 */
export function cannotRide(blocked, nameable, target, where, about = aPublish(where)) {
  const also = nameable.length ? ` Once they are off the branch, ${listed(nameable.map((p) => offer(p, target)))} could go along with it.` : "";
  return `${carries(where, target, about)}. These cannot be published, and saying you want them anyway will not change that: ${listed(blocked.map((p) => why(p, target)))}. Put them aside and bring things back one at a time: git branch keep; git reset --hard origin/${where.branch}; git checkout keep -- ${where.dir}; then ${about.then}, and each of the others in its turn.${also}`;
}

/**
 * The refusal when everything riding could be published and nobody said so. This is the common one, so it
 * asks for one word rather than a procedure. A version bump is not consent: a person raises a version to
 * try something as readily as to ship it, so the act is the moment to say which it was.
 */
export function notNamed(nameable, target, where, about = aPublish(where)) {
  const names = nameable.map((p) => p.package);
  return `${carries(where, target, about)}: ${listed(nameable.map((p) => offer(p, target)))}. Each of those can be published in its own right, but a version having moved is not the same as meaning to ship it, so nothing goes that you did not ask for. Publish them deliberately alongside this one (${about.command} ${names.map((n) => `--with ${n}`).join(" ")}), or move them off this branch first: git branch keep; git reset --hard origin/${where.branch}; git checkout keep -- ${where.dir}.`;
}

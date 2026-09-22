// What this package can record, and what it cannot.
//
// A publish is exactly the kind of act the kernel's journal is for: who published what, where, and when.
// There is no seam for it. A tool runs inside a fence with a `ToolEnv`, which carries no journal; the one
// interface that does is `HostEnv`, which only a host package on the service plane ever receives, and the
// operator channel offers `journal.tail` and nothing that appends. Reaching for `operator.call` to fake a
// row would journal `host.call`, or nothing, and would need the person to be an admin, so it is not done.
// `publish` returns the row it would have written, in `answer.journals`, for a caller that has the seam,
// and `unpublish` returns one of its own kind for the same reason.
//
// What is written here instead is the package's own record, in the package's own store: `env.storage`
// keys documents under this user and this package, so it is this person's history of their own publishes
// and nothing else's. `publish_targets` reads the last one back for each target, which is the point --
// a record nobody can see is not much better than no record.
import { safeName } from "./config.js";

const NAMESPACE = "publishes";

/** The document's own key: when, which target, which package. Sorted by time wherever it is listed. */
const keyFor = (doc, target) => `${doc.at.replace(/[^0-9]/g, "")}_${safeName(target)}_${safeName(doc.name.replace("/", "-"))}`;

/** One row per package published, small enough to keep for ever and complete enough to read a year later. */
function rows(answer, at = new Date().toISOString()) {
  const of = (r) => ({
    at,
    name: r.package,
    was: r.was ?? "",
    version: r.now,
    first: r.first,
    target: answer.target,
    url: answer.url,
    branch: answer.branch,
    directory: r.directory ?? answer.directory,
    commit: answer.commit ?? "",
    mode: answer.mode,
    files: r.files.length,
    // The copy the code came out of, when a fork was published as its origin. The row says `@dev/widget`,
    // because that is the package that was published, and this is the only thing that says whose work it
    // was. A rider has no fork of its own, so the field is the primary's alone.
    ...(r.fork ? { fork: r.fork.name } : {}),
    // A package that rode along on the branch was named in `with`, not published on its own. A year later
    // that is the difference between "I shipped this" and "I let this go with something else".
    ...(r === answer ? {} : { alongside: answer.package }),
  });
  return [of(answer), ...answer.with.map(of)];
}

/**
 * Writes a row for every package this act published, and answers them. Never throws: a store that is not
 * there is a reason to lose the record, not a reason to tell somebody their push failed when it did not.
 * The push has already happened by the time this runs, and nothing after it may claim otherwise.
 *
 * `last_<target>` is the package that was published, not one that rode along, so it is written from the
 * primary and written last.
 */
export async function recordPublish(env, answer) {
  const docs = rows(answer);
  try {
    const store = env.storage?.(NAMESPACE);
    if (!store) return null;
    for (const doc of docs) await store.set(keyFor(doc, answer.target), doc);
    await store.set(`last_${safeName(answer.target)}`, docs[0]);
  } catch {
    return null;
  }
  return docs;
}

/**
 * The same, for a removal. It is written as its own row and under its own `lastRemoval_<target>` key, and
 * it does not touch `last_<target>`: that key means the last thing this person *published* to a target, a
 * card draws the version from it, and a removal quietly taking its place would make the card say a package
 * is at a version that was in fact its last. Two keys and no ambiguity is cheaper than one key with a flag.
 *
 * Riders are publishes and are recorded as such, `alongside` and all: a package that went out because it
 * was named in the `with` of a removal is still a publish of its own.
 */
export async function recordUnpublish(env, answer) {
  const at = new Date().toISOString();
  const removal = { at, name: answer.package, removed: true, version: answer.held ?? "", target: answer.target, url: answer.url, branch: answer.branch, directory: answer.directory, commit: answer.commit ?? "", mode: answer.mode, files: answer.files.length };
  const docs = [removal, ...rows(answer, at).slice(1)];
  try {
    const store = env.storage?.(NAMESPACE);
    if (!store) return null;
    for (const doc of docs) await store.set(keyFor(doc, answer.target), doc);
    await store.set(`lastRemoval_${safeName(answer.target)}`, removal);
  } catch {
    return null;
  }
  return docs;
}

/**
 * What this person's record says about **one package** at one target: the last time they published it from
 * here, the last time they took it out, and which of the two is the later.
 *
 * This is not the same question as `lastPublish`, and the difference is the whole reason it exists. A
 * target's last publish is what last happened *there*, which is what a target card wants; a page drawing a
 * *package* card needs first-hand evidence about *that package*, because the record is the only thing that
 * knows a package was published to a registry this installation does not mirror. Reading the per-target key
 * for it worked until the next publish of anything else overwrote it, and then the badge that had been
 * telling the truth quietly went back to saying the package was never published. A badge that stops being
 * right is worse than one that never was, because nothing tells the person to look again.
 *
 * It is answered from the dated rows, which are the record, rather than from a summary key kept beside
 * them. A derived key would be a second thing to keep in step, and the one being fixed here is what
 * happens when a derived key and the truth part company. The cost is one `list` and, all but always, one
 * `get`: the keys sort by time because they begin with the timestamp, so the newest match is the last one.
 */
export async function packageRecord(env, targetName, name) {
  const answer = { published: null, publishedAt: null, removed: null, removedAt: null, latest: null, commit: null };
  if (!name) return answer;
  try {
    const store = env.storage?.(NAMESPACE);
    if (!store) return answer;
    // The key is `<stamp>_<target>_<name>`, all three written by the functions above, so the tail is an
    // exact string and not a guess: a target whose name contains an underscore cannot be mistaken for
    // another one. `last_` and `lastRemoval_` are excluded by the stamp the dated rows start with.
    const tail = `_${safeName(targetName)}_${safeName(name.replace("/", "-"))}`;
    const keys = (await store.list())
      .filter((k) => /^\d+_/.test(k) && k.slice(k.indexOf("_")) === tail)
      .sort();
    let published = null;
    let removed = null;
    for (let i = keys.length - 1; i >= 0 && !(published && removed); i--) {
      const doc = await store.get(keys[i]);
      if (!doc) continue;
      if (doc.removed) removed ??= doc;
      else published ??= doc;
    }
    // A tie goes to the removal. It cannot happen in practice -- one act never both publishes and removes
    // the same package -- and if it ever did, not claiming a package is published is the safer of the two.
    const latest = published && removed ? (published.at > removed.at ? "published" : "removed") : published ? "published" : removed ? "removed" : null;
    const winner = latest === "removed" ? removed : published;
    return {
      published: published?.version ?? null,
      publishedAt: published?.at ?? null,
      removed: removed?.version ?? null,
      removedAt: removed?.at ?? null,
      /** `published`, `removed`, or null when this person has done neither to this package here. */
      latest,
      commit: winner?.commit || null,
    };
  } catch {
    return answer;
  }
}

/** The last removal from one target, or null. The other half of what `publish_targets` shows per target. */
export async function lastRemoval(env, targetName) {
  try {
    const store = env.storage?.(NAMESPACE);
    return store ? ((await store.get(`lastRemoval_${safeName(targetName)}`)) ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The last publish to one target, or null. Read by `publish_targets` so the record is visible.
 *
 * This is the reason another package must reach this one through `env.invokeTool` and not by importing it:
 * `env.storage` is namespaced by the kernel under the *calling* package's name, so a direct import would
 * look for these documents under that package's namespace and quietly find an empty store.
 */
export async function lastPublish(env, targetName) {
  try {
    const store = env.storage?.(NAMESPACE);
    return store ? ((await store.get(`last_${safeName(targetName)}`)) ?? null) : null;
  } catch {
    return null;
  }
}

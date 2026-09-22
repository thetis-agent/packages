// Every git command this package runs. `env.exec` takes a shell line, so the quoting happens here once
// rather than at each call site: a branch name, a registry url and a package directory all arrive from
// configuration or from a person, and none of them is ours to trust with the shell. Every call names its
// directory with `-C`, so nothing depends on where the fence's exec happens to start.
import { refuse } from "./refuse.js";

const SAFE = /^[A-Za-z0-9@%_+=:,./-]+$/;

export function shq(arg) {
  const s = String(arg);
  return s !== "" && SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A git command in `dir`. Never throws: git's exit code is an answer here as often as it is a failure
 * (`rev-parse` asking whether this is a work tree, `show` asking whether the registry holds a file yet),
 * so the caller decides which it is. `mustGit` is the other half, for the calls where non-zero is a stop.
 */
export async function git(env, dir, args, opts = {}) {
  const cmd = ["git", "-C", dir, ...args].map(shq).join(" ");
  return env.exec(cmd, {
    timeoutMs: opts.timeoutMs ?? 180_000,
    env: {
      // A clone or a push that cannot authenticate has to fail, not sit waiting for a password at a
      // terminal nobody is watching. The fence's ssh agent is the whole credential: when it cannot answer
      // for this registry, that is the answer, and the refusal says so.
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      ...(opts.env ?? {}),
    },
  });
}

export async function mustGit(env, dir, args, why, opts) {
  const r = await git(env, dir, args, opts);
  if (r.code !== 0) refuse("git", `${why}: ${gitSays(r)}`);
  return r;
}

/** Git's own words for what went wrong, in one line, for a refusal that has to stand on its own. */
export function gitSays(r) {
  const lines = `${r.stderr ?? ""}\n${r.stdout ?? ""}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^(fatal|error|remote:)/i.test(l)) ?? lines.at(-1) ?? `git exited ${r.code}`;
}

export const out = (r) => String(r.stdout ?? "").trim();
export const lines = (r) => out(r).split("\n").filter(Boolean);

/** The root of the work tree `dir` is in, or null when it is in none. */
export async function topLevelOf(env, dir) {
  const r = await git(env, dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && out(r) ? out(r) : null;
}

export async function originOf(env, dir) {
  const r = await git(env, dir, ["remote", "get-url", "origin"]);
  return r.code === 0 && out(r) ? out(r) : null;
}

/**
 * The branch checked out, or null when HEAD is detached. `symbolic-ref` and not `rev-parse --abbrev-ref`,
 * because a freshly cloned empty repository has a branch with no commit on it yet and `rev-parse` cannot
 * name it; that is exactly the state a first publish into a new registry starts from.
 */
export async function currentBranch(env, dir) {
  const r = await git(env, dir, ["symbolic-ref", "--short", "HEAD"]);
  return r.code === 0 && out(r) ? out(r) : null;
}

export async function refExists(env, dir, ref) {
  return (await git(env, dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0;
}

export async function headCommit(env, dir) {
  const r = await git(env, dir, ["rev-parse", "HEAD"]);
  return r.code === 0 && out(r) ? out(r) : null;
}

/**
 * The identity git would sign a commit with here, or null when this host has none. A fence often has
 * none: it is a container with no `~/.gitconfig`, and the first thing anybody learns about that is a
 * commit failing with "please tell me who you are" in the middle of a publish. The caller supplies one
 * rather than failing, and says in its answer which identity the commit carries.
 */
export async function identityOf(env, dir) {
  const name = await git(env, dir, ["config", "user.name"]);
  const email = await git(env, dir, ["config", "user.email"]);
  return name.code === 0 && out(name) && email.code === 0 && out(email) ? `${out(name)} <${out(email)}>` : null;
}

/** What a commit is made as when the work tree has no identity of its own. */
export const FALLBACK_IDENTITY = { name: "thetis", email: "thetis@localhost" };
export const asIdentity = (id) => (id ? [] : ["-c", `user.name=${FALLBACK_IDENTITY.name}`, "-c", `user.email=${FALLBACK_IDENTITY.email}`]);

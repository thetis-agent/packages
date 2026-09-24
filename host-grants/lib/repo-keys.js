// Repository keys: an ssh key that belongs to the installation rather than to a person, and reaches exactly
// one repository -- a private registry, say. It is an ssh grant on the system userspace carrying `repo`, the
// key file sits at `<home>/fence-keys/_system/<alias>`, and the system fence's agent holds it. Here: which
// repository a url names, the host keys to trust for it, and whether the key actually gets in. The grant
// itself is the kernel's record, written by index.js.
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHosted, repoRoute, sameRepository } from "@thetis/runtime/lib/git-url";
import { assert } from "./error.js";
import { describeKeys } from "./ssh.js";

/** The route for a repository url, or an `invalid` refusal: a repository key is for a hosted repository reached over ssh, never a local path. */
export function routeOf(repo) {
  const text = String(repo ?? "").trim();
  const route = repoRoute(text);
  assert(route, `not a hosted repository url: ${text || "(empty)"} (git@host:owner/repo.git, ssh://, https://)`, "invalid");
  return route;
}

/** The grant for `repo` in a system grant list, matched as a repository whatever its spelling. */
export const grantFor = (grants, repo) => grants.find((g) => sameRepository(g.repo, repo));

/**
 * `RepoKeyState[]`: each system grant with its alias and what the host holds for it now -- `present`,
 * `publicKey`, `fingerprint` -- the same presence `sshList` answers, so a key that was granted and then lost
 * shows as missing rather than as working.
 */
export function describeRepoKeys(grants) {
  return describeKeys(grants).map((g) => ({
    repo: g.repo,
    key: g.key,
    alias: repoRoute(g.repo)?.alias ?? null,
    ...(g.hosts ? { hosts: g.hosts } : {}),
    present: g.present,
    publicKey: g.publicKey,
    fingerprint: g.fingerprint,
  }));
}

/**
 * The host keys the repository's host answers with, as known_hosts lines: `ssh-keyscan -T 10 [-p port]
 * <host>`, run on the host. Trust on first use, done once by an admin who is looking at the answer, instead
 * of by every clone; the lines are stored on the grant and the fence trusts those and nothing else. Nothing
 * found is a refusal, because a grant without host keys fails every connection with strict checking on.
 * `command` is there for the tests.
 */
export function keyscan(route, { command = "ssh-keyscan" } = {}) {
  const args = ["-T", "10", ...(route.port ? ["-p", String(route.port)] : []), route.host];
  const run = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  const lines = (run.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const why = (run.stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join("; ");
  assert(lines.length, `ssh-keyscan found no host keys for ${route.host}${route.port ? `:${route.port}` : ""}${why ? `: ${why}` : ""}; pass hosts, or scan again`, "invalid");
  return lines;
}

/** Known-hosts lines, trimmed, blanks dropped, each once, in the order first seen. */
export const mergeHosts = (...lists) => [...new Set(lists.flat().map((h) => String(h ?? "").trim()).filter(Boolean))];

/** `ssh://<user>@<host>[:port]/<path>.git`: the repository reached directly, not through the fence's alias. */
export function directUrl(repo) {
  const hosted = parseHosted(repo);
  assert(hosted, `not a hosted repository url: ${repo}`, "invalid");
  return `ssh://${hosted.user}@${hosted.host}${hosted.port ? `:${hosted.port}` : ""}/${hosted.path}.git`;
}

/**
 * Whether the key gets in: `git ls-remote <url> HEAD` on the host with this key alone -- no agent, no other
 * identity, no prompt, strict host checking against the grant's own host keys -- so the answer is about this
 * grant and not about whatever the host's own ssh setup happens to reach. Answers `{ ok, head?, error? }`,
 * `error` being git's own stderr, trimmed; the far end's words ("Permission denied (publickey)", "Repository
 * not found") say what to fix better than a paraphrase would. Never throws for a refusal, and gives up after
 * `timeout` ms. Asynchronous, because the daemon has other callers while the far end thinks.
 */
export async function testKey({ key, hosts = [], url, timeout = 20_000, git = "git" }) {
  const dir = mkdtempSync(join(tmpdir(), "thetis-repo-test-"));
  try {
    const knownHosts = join(dir, "known_hosts");
    writeFileSync(knownHosts, hosts.length ? `${hosts.join("\n")}\n` : "", { mode: 0o600 });
    const ssh = [
      "ssh", "-i", quote(key), "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${quote(knownHosts)}`,
    ].join(" ");
    const env = { ...process.env, GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
    delete env.SSH_AUTH_SOCK;
    const { code, stdout, stderr, timedOut } = await run(git, ["ls-remote", url, "HEAD"], { env, timeout, cwd: dir });
    if (timedOut) return { ok: false, error: `no answer from the repository within ${Math.round(timeout / 1000)} s` };
    if (code !== 0) return { ok: false, error: stderr.replace(/\r\n?/g, "\n").trim() || `git ls-remote exited ${code}` };
    const head = stdout.split(/\s+/)[0];
    return { ok: true, ...(head ? { head } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A path for a shell word: GIT_SSH_COMMAND is run by a shell. */
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function run(command, args, { env, timeout, cwd }) {
  return new Promise((done) => {
    execFile(command, args, { env, cwd, timeout, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const timedOut = Boolean(err?.killed);
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      done({ code, stdout: stdout ?? "", stderr: stderr || (err && !err.killed ? String(err.message) : ""), timedOut });
    });
  });
}

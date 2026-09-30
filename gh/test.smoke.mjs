// Smoke test: splitting, policy and gh api argument building offline, then the
// tools against the local gh and git (no token needed: resolve, help, status,
// refusals, a dry run, stdin plumbing, and git's credential wiring).
import assert from "node:assert/strict";
import { exec as cpExec } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as m from "./index.js";

let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

function makeEnv(config = {}, cwd = process.cwd()) {
  return {
    config,
    cwd,
    writeFile: (p, s) => writeFile(p, s),
    exec: (cmd, opts = {}) => new Promise((res) => {
      cpExec(cmd, { cwd: opts.cwd ?? cwd, timeout: opts.timeoutMs, env: { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, ...(opts.env ?? {}) }, maxBuffer: 64 << 20 },
        (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    }),
  };
}

await t("splitArgs honours quotes and ignores operators", () => {
  assert.deepEqual(m.splitArgs(`pr list --search "is:open label:\\"good first issue\\"" | head`),
    ["pr", "list", "--search", `is:open label:"good first issue"`, "|", "head"]);
  assert.throws(() => m.splitArgs(`a "b`));
});

await t("argsOf strips a leading gh or git", () => {
  assert.deepEqual(m.argsOf({ command: "gh pr list" }), ["pr", "list"]);
  assert.deepEqual(m.argsOf({ args: ["status"] }, "git"), ["status"]);
  assert.deepEqual(m.argsOf({ command: "git status" }, "git"), ["status"]);
  assert.throws(() => m.argsOf({}));
});

await t("pathFromHelp reads the USAGE line", () => {
  assert.equal(m.pathFromHelp("USAGE\n  gh pr view [<number> | <url> | <branch>] [flags]\n"), "pr view");
  assert.equal(m.pathFromHelp("USAGE\n  gh api <endpoint> [flags]"), "api");
  assert.equal(m.pathFromHelp("USAGE\n  gh <command> <subcommand> [flags]"), "");
  assert.equal(m.pathFromHelp("unknown flag: --zzz"), null);
});

await t("always-denied and settings", () => {
  assert.match(m.checkPolicy("auth login"), /always refused/);
  assert.match(m.checkPolicy("auth token"), /always refused/);
  assert.match(m.checkPolicy("codespace ssh"), /always refused/);
  assert.match(m.checkPolicy("alias set"), /always refused/);
  assert.equal(m.checkPolicy("alias list"), null);
  assert.equal(m.checkPolicy("auth status"), null);
  assert.match(m.checkPolicy("repo delete", { deny: "repo delete, secret" }), /deny/);
  assert.match(m.checkPolicy("secret set", { deny: ["secret"] }), /deny/);
  assert.equal(m.checkPolicy("pr list", { allow: "pr, issue" }), null);
  assert.match(m.checkPolicy("repo view", { allow: "pr, issue" }), /allow/);
});

await t("read-only mode", () => {
  const cfg = { mode: "read-only" };
  assert.equal(m.checkPolicy("pr list", cfg), null);
  assert.equal(m.checkPolicy("pr view", cfg), null);
  assert.equal(m.checkPolicy("pr checks", cfg), null);
  assert.equal(m.checkPolicy("search issues", cfg), null);
  assert.equal(m.checkPolicy("run download", cfg), null);
  assert.match(m.checkPolicy("pr merge", cfg), /read-only/);
  assert.match(m.checkPolicy("repo delete", cfg), /read-only/);
  assert.equal(m.checkPolicy("api", cfg, { reads: true }), null);
  assert.match(m.checkPolicy("api", cfg, { reads: false, why: "its method is POST" }), /method is POST/);
});

await t("apiArgs builds REST calls", () => {
  let a = m.apiArgs({ endpoint: "/repos/o/r/issues", params: { state: "open", per_page: 5 }, paginate: true, jq: ".[].title" });
  assert.deepEqual(a.args, ["api", "repos/o/r/issues", "-f", "state=open", "-F", "per_page=5", "--paginate", "--jq", ".[].title"]);
  assert.equal(a.reads, false); // fields without an explicit method make gh POST
  a = m.apiArgs({ endpoint: "https://api.github.com/repos/o/r/issues", method: "get", params: { state: "open" } });
  assert.deepEqual(a.args.slice(0, 5), ["api", "repos/o/r/issues", "--method", "GET", "-f"]);
  assert.equal(a.reads, true);
  a = m.apiArgs({ endpoint: "repos/o/r/issues", body: { title: "x", labels: ["a"] } });
  assert.deepEqual(a.args, ["api", "repos/o/r/issues", "--input", "-"]);
  assert.equal(a.stdin, '{"title":"x","labels":["a"]}');
  assert.equal(a.reads, false);
  a = m.apiArgs({ endpoint: "repos/o/r", paginate: true });
  assert.deepEqual(a.args, ["api", "repos/o/r", "--paginate", "--slurp"]);
  assert.equal(a.reads, true);
  assert.throws(() => m.apiArgs({ endpoint: "x", params: { nested: { a: 1 } } }), /body/);
  assert.throws(() => m.apiArgs({}), /endpoint/);
});

await t("apiArgs builds GraphQL calls", () => {
  const q = "query($owner:String!){ repositoryOwner(login:$owner){ login } }";
  let a = m.apiArgs({ graphql: q, variables: { owner: "octocat" } });
  assert.deepEqual(a.args, ["api", "graphql", "-f", `query=${q}`, "-f", "owner=octocat"]);
  assert.equal(a.reads, true);
  a = m.apiArgs({ graphql: "mutation { addStar(input:{starrableId:\"x\"}) { clientMutationId } }" });
  assert.equal(a.reads, false);
  assert.match(a.why, /mutation/);
});

await t("envOf carries the token, disables prompts and wires git credentials", () => {
  const e = m.envOf({ token: "ghp_x", gitUserName: "bot", gitUserEmail: "bot@example.com", ghPath: "/opt/bin/gh" });
  assert.equal(e.GH_TOKEN, "ghp_x");
  assert.equal(e.GH_PROMPT_DISABLED, "1");
  assert.equal(e.GIT_TERMINAL_PROMPT, "0");
  assert.equal(e.GIT_CONFIG_VALUE_1, "!/opt/bin/gh auth git-credential");
  assert.equal(e.GIT_AUTHOR_NAME, "bot");
  assert.equal(e.GIT_COMMITTER_EMAIL, "bot@example.com");
  assert.equal(m.envOf({}).GH_TOKEN, undefined);
});

const env = makeEnv();

await t("resolve reads the command path from a real gh, aliases and all", async () => {
  assert.deepEqual(await m.resolve(env, ["pr", "view", "12", "--repo", "o/r", "--json", "title"]), { ok: true, path: "pr view" });
  assert.deepEqual(await m.resolve(env, ["co", "12"]), { ok: true, path: "pr checkout" });
  assert.deepEqual(await m.resolve(env, ["api", "repos/o/r", "-H", "Accept: x"]), { ok: true, path: "api" });
  const bad = await m.resolve(env, ["pr", "view", "--zzz"]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown flag/);
  const none = await m.resolve(env, ["zzz"]);
  assert.equal(none.ok, false);
});

await t("gh_run refuses denied, malformed and token-showing commands without running", async () => {
  assert.match(await m.ghRun({ args: ["auth", "login", "--with-token"] }, env), /^refused: .*always refused/);
  assert.match(await m.ghRun({ args: ["codespace", "list"] }, env), /^refused: .*always refused/);
  assert.match(await m.ghRun({ command: "pr view --zzz" }, env), /refused before running/);
  assert.match(await m.ghRun({ args: ["auth", "status", "--show-token"] }, env), /^refused: .*token/);
  assert.match(await m.ghRun({ args: ["pr", "merge", "1", "--repo", "o/r"] }, makeEnv({ mode: "read-only" })), /read-only/);
});

await t("gh_run dry_run resolves the alias", async () => {
  const r = await m.ghRun({ args: ["co", "12"], dry_run: true }, env);
  assert.match(r, /^would run: gh co 12\ncommand: pr checkout/);
});

await t("gh_run runs a harmless command, quotes shell characters, notes a missing token", async () => {
  const r = await m.ghRun({ args: ["config", "get", "git_protocol;echo PWNED"] }, env);
  assert.match(r, /^\$ gh config get/);
  assert.doesNotMatch(r.replace(/^\$.*$/m, ""), /^PWNED$/m);
  const api = await m.ghRun({ args: ["repo", "view", "cli/cli"] }, env);
  assert.match(api, /exit [1-9]/);
  assert.match(api, /note: no `token` is set/);
  const withTok = await m.ghRun({ args: ["repo", "view", "cli/cli"] }, makeEnv({ token: "ghp_definitely_invalid" }));
  assert.match(withTok, /note: GitHub rejected the configured `token`/);
});

await t("gh_run feeds `input` to stdin and removes the file", async () => {
  // `gh config get` ignores stdin; use gh's own alias expansion instead: `gh alias import -` reads stdin, but is denied.
  // So check the plumbing with git, which shares run(): `git stripspace` echoes stdin.
  const r = await m.ghGit({ args: ["stripspace"], input: "hello  \n\n\n" }, env);
  assert.match(r, /exit 0/);
  assert.match(r, /--- stdout ---\nhello$/m);
  const left = await env.exec("ls .cache/thetis-gh 2>/dev/null | wc -l");
  assert.equal(left.stdout.trim(), "0");
});

await t("gh_api refuses a write in read-only mode and shows a dry run", async () => {
  const ro = makeEnv({ mode: "read-only" });
  assert.match(await m.ghApi({ endpoint: "repos/o/r/issues", body: { title: "x" } }, ro), /^refused: .*read-only/);
  assert.match(await m.ghApi({ graphql: "mutation { x }" }, ro), /GraphQL mutation/);
  const dry = await m.ghApi({ endpoint: "repos/o/r/issues", method: "GET", params: { state: "open" }, dry_run: true }, ro);
  assert.match(dry, /^would run: gh api repos\/o\/r\/issues --method GET -f state=open$/);
  const dryBody = await m.ghApi({ endpoint: "repos/o/r/issues", body: { title: "x" }, dry_run: true }, env);
  assert.match(dryBody, /--input -\n--- stdin ---\n\{"title":"x"\}/);
});

await t("gh_api without a token fails with the auth note", async () => {
  const r = await m.ghApi({ endpoint: "user" }, env);
  assert.match(r, /^\$ gh api user/);
  assert.match(r, /note: no `token` is set/);
});

await t("gh_git runs in cwd with the bot identity and gh as credential helper", async () => {
  const dir = await mkdtemp(`${tmpdir()}/gh-smoke-`);
  try {
    const e = makeEnv({ token: "ghp_fake", gitUserName: "Thetis Bot", gitUserEmail: "bot@users.noreply.github.com" }, dir);
    assert.match(await m.ghGit({ args: ["init", "-q", "-b", "main"] }, e), /exit 0/);
    await writeFile(`${dir}/a.txt`, "a\n");
    assert.match(await m.ghGit({ args: ["add", "a.txt"] }, e), /exit 0/);
    assert.match(await m.ghGit({ args: ["commit", "-q", "-F", "-"], input: "first\n" }, e), /exit 0/);
    const log = await m.ghGit({ args: ["log", "-1", "--format=%an <%ae> %s"] }, e);
    assert.match(log, /Thetis Bot <bot@users.noreply.github.com> first/);
    const helper = await m.ghGit({ args: ["config", "--get-all", "credential.helper"] }, e);
    assert.match(helper, /gh auth git-credential/);
    const cred = await e.exec("printf 'protocol=https\\nhost=github.com\\n' | git credential fill", { env: m.envOf(e.config) });
    assert.match(cred.stdout, /password=ghp_fake/);
    assert.match(await m.ghGit({ args: ["push"] }, makeEnv({ mode: "read-only" }, dir)), /^refused: .*read-only/);
    const ssh = await m.ghGit({ args: ["ls-remote", "git@github.com:o/r.git"], timeout_s: 20 }, e);
    assert.match(ssh, /exit [1-9]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await t("gh_help returns usage; gh_status reports version, token and policy", async () => {
  const h = await m.ghHelp({ command: "pr create" }, env);
  assert.match(h, /USAGE\s+gh pr create/);
  await assert.rejects(m.ghHelp({ command: "pr create --fill" }, env));
  const s = await m.ghStatus({}, makeEnv({ deny: ["repo delete"], mode: "read-only" }));
  assert.match(s, /^gh version \d/);
  assert.match(s, /token: NOT SET/);
  assert.match(s, /mode: read-only/);
  assert.match(s, /deny: repo delete/);
  const s2 = await m.ghStatus({}, makeEnv({ token: "ghp_fake" }));
  assert.match(s2, /token: set/);
  assert.doesNotMatch(s2, /ghp_fake/);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

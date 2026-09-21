// The git commands over a fake env: canned git output per command, so the parsing and the refusals are
// checked without a checkout. Every command refuses a package that is not installed here, and answers
// nulls and empties, not errors, for files outside a checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { packageCommit, packageDiff, packageLog, packagePush, packageReadme, pinOf } from "../git.js";

const SEP = "\u001e";
const FIELD = "\u001f";
const UPSTREAM = ["1111111111111111111111111111111111111111", "3333333333333333333333333333333333333333"];
const LOG = [
  `${SEP}2222222222222222222222222222222222222222${FIELD}2222222${FIELD}Make the nav a tree${FIELD}bitmuse${FIELD}2026-09-21T14:00:00+00:00\nui/index.js\nui/tree.js\n`,
  `${SEP}1111111111111111111111111111111111111111${FIELD}1111111${FIELD}Send screens only while open${FIELD}bitmuse${FIELD}2026-09-21T05:00:00+00:00\nindex.js\n`,
  `${SEP}3333333333333333333333333333333333333333${FIELD}3333333${FIELD}Drawer resize via stty${FIELD}alice${FIELD}2026-09-18T09:00:00+00:00\nui/shelf.js\nui/screen.js\nREADME.md\n`,
].join("");

const info = (source) => ({ name: "@thetis/terminal", version: "0.1.0", type: "tool", description: "Shells.", root: "/srv/packages/terminal", everyone: true, source });

/** An env whose git answers by the command's shape, recording what was asked. */
function envWith(answers, source = { kind: "system", ref: "terminal" }) {
  const execs = [];
  const env = {
    user: "root",
    role: "admin",
    kernel: { packages: { list: async () => [info(source)] } },
    readFile: async () => {
      throw new Error("no index");
    },
    exec: async (cmd) => {
      execs.push(cmd);
      for (const [needle, out] of answers) if (cmd.includes(needle)) return typeof out === "function" ? out(cmd) : { code: 0, stdout: out, stderr: "" };
      return { code: 1, stdout: "", stderr: `no answer for ${cmd}` };
    },
  };
  return { env, execs };
}

const checkout = [
  ["rev-parse --show-toplevel", "/srv\n"],
  ["status --porcelain", "## main\n M ui/index.js\n"],
  ["rev-list --left-right", "2\t0\n"],
  ["rev-parse --short HEAD", "2222222\n"],
  ["rev-parse HEAD", "2222222222222222222222222222222222222222\n"],
  ["rev-parse --show-prefix", "packages/terminal/\n"],
  ["rev-list -n 2000", UPSTREAM.join("\n") + "\n"],
  ["log --format=", LOG],
];

test("package-log: newest first, pushed from the upstream's set, pinned from the source, files counted per commit", async () => {
  const { env, execs } = envWith(checkout, { kind: "git", ref: "https://x/registry.git#terminal@3333333333333333333333333333333333333333" });
  const { data } = await packageLog({ name: "@thetis/terminal", limit: 3 }, env);
  assert.deepEqual({ branch: data.branch, upstream: data.upstream, ahead: data.ahead, behind: data.behind, head: data.head, pin: data.pin, registry: data.registry }, {
    branch: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 0,
    head: { hash: "2222222222222222222222222222222222222222", short: "2222222" },
    pin: { hash: "3333333333333333333333333333333333333333", short: "3333333" },
    registry: null,
  });
  assert.deepEqual(
    data.commits.map((c) => [c.short, c.subject, c.author, c.at, c.pushed, c.pinned, c.files]),
    [
      ["2222222", "Make the nav a tree", "bitmuse", "2026-09-21T14:00:00+00:00", false, false, 2],
      ["1111111", "Send screens only while open", "bitmuse", "2026-09-21T05:00:00+00:00", true, false, 1],
      ["3333333", "Drawer resize via stty", "alice", "2026-09-18T09:00:00+00:00", true, true, 3],
    ],
  );
  const log = execs.find((c) => c.includes("log --format="));
  assert.ok(log.includes("-n 3 -- .") && log.includes("--name-only"), "the log is capped and lists file names for the counts");
  assert.ok(execs.some((c) => c.includes("rev-list -n 2000 'origin/main'")), "pushed is read from the remote branch once");
});

test("package-log: no checkout answers empties; no upstream leaves whether a commit is pushed unknown; the limit is capped", async () => {
  const none = envWith([["rev-parse --show-toplevel", () => ({ code: 128, stdout: "", stderr: "not a git repository" })]]);
  const { data } = await packageLog({ name: "@thetis/terminal" }, none.env);
  assert.deepEqual(data, { branch: null, upstream: null, ahead: 0, behind: 0, head: null, pin: null, registry: null, commits: [] });
  const bare = envWith([
    ["rev-parse --show-toplevel", "/srv\n"],
    ["status --porcelain", "## main\n"],
    ["rev-list --left-right", () => ({ code: 128, stdout: "", stderr: "unknown revision" })],
    ["rev-parse --short HEAD", "2222222\n"],
    ["rev-parse HEAD", "2222222222222222222222222222222222222222\n"],
    ["log --format=", LOG],
  ]);
  const out = await packageLog({ name: "@thetis/terminal", limit: 9999 }, bare.env);
  assert.equal(out.data.upstream, null);
  assert.ok(out.data.commits.every((c) => c.pushed === null), "no upstream: pushed is unknown, not false");
  assert.ok(bare.execs.some((c) => c.includes("-n 200 -- .")), "the limit is capped at 200");
  assert.ok(!bare.execs.some((c) => c.includes("rev-list -n 2000")), "no upstream, nothing to compare against");
  await assert.rejects(packageLog({ name: "@thetis/nope" }, bare.env), /is not installed/);
  await assert.rejects(packageLog({ name: "terminal" }, bare.env), /looks like @scope\/name/);
});

test("pinOf reads the commit off a pinned git source only", () => {
  assert.equal(pinOf({ kind: "git", ref: "https://x/r.git#terminal@abcdef1234567" }), "abcdef1234567");
  assert.equal(pinOf({ kind: "git", ref: "https://x/r.git#terminal" }), null);
  assert.equal(pinOf({ kind: "system", ref: "terminal" }), null);
  assert.equal(pinOf(null), null);
});

test("package-commit: the message and this package's files with the repository prefix stripped; a bad hash is refused", async () => {
  const show = `2222222222222222222222222222222222222222${FIELD}2222222${FIELD}Make the nav a tree${FIELD}bitmuse${FIELD}2026-09-21T14:00:00+00:00${FIELD}A chevron per node.\n${SEP}\n41\t12\tpackages/terminal/ui/index.js\n9\t3\tpackages/terminal/ui/shelf.js\n-\t-\tpackages/terminal/ui/logo.png\n`;
  const { env, execs } = envWith([...checkout, ["show --numstat", show]]);
  const { data } = await packageCommit({ name: "@thetis/terminal", hash: "2222222" }, env);
  assert.deepEqual(data, {
    hash: "2222222222222222222222222222222222222222",
    short: "2222222",
    subject: "Make the nav a tree",
    author: "bitmuse",
    at: "2026-09-21T14:00:00+00:00",
    body: "A chevron per node.",
    pushed: false,
    files: [
      { path: "ui/index.js", added: 41, deleted: 12 },
      { path: "ui/shelf.js", added: 9, deleted: 3 },
      { path: "ui/logo.png", added: 0, deleted: 0 },
    ],
  });
  assert.ok(execs.find((c) => c.includes("show --numstat")).endsWith("'2222222' -- ."), "the hash is quoted and the files are this package's");
  await assert.rejects(packageCommit({ name: "@thetis/terminal", hash: "--output=/tmp/x" }, env), /7 to 40 hex digits/);
  await assert.rejects(packageCommit({ name: "@thetis/terminal", hash: "HEAD" }, env), /7 to 40 hex digits/);
  const missing = envWith([...checkout, ["show --numstat", () => ({ code: 128, stdout: "", stderr: "bad object" })]]);
  await assert.rejects(packageCommit({ name: "@thetis/terminal", hash: "abcdef0" }, missing.env), /is not a commit of this checkout/);
});

test("package-diff: numstat between two points or against the working tree, refs checked before git sees them", async () => {
  const { env, execs } = envWith([...checkout, ["diff --numstat", "10\t2\tpackages/terminal/index.js\n0\t5\tpackages/terminal/README.md\n"]]);
  const { data } = await packageDiff({ name: "@thetis/terminal", from: "3333333", to: "HEAD" }, env);
  assert.deepEqual(data, { from: "3333333", to: "HEAD", files: [{ path: "index.js", added: 10, deleted: 2 }, { path: "README.md", added: 0, deleted: 5 }], summary: "2 files changed, +10 −7" });
  assert.ok(execs.find((c) => c.includes("diff --numstat")).endsWith("'3333333' 'HEAD' -- ."));
  const tree = await packageDiff({ name: "@thetis/terminal", from: "HEAD", to: "WORKTREE" }, env);
  assert.ok(execs.filter((c) => c.includes("diff --numstat")).at(-1).endsWith("diff --numstat 'HEAD' -- ."), "the working tree is git's default second side");
  assert.equal(tree.data.to, "WORKTREE");
  for (const bad of ["HEAD~1", "main..HEAD", "-p", "HEAD ; rm", "origin/main"]) await assert.rejects(packageDiff({ name: "@thetis/terminal", from: bad, to: "HEAD" }, env), /commit hash, HEAD or WORKTREE/);
  await assert.rejects(packageDiff({ name: "@thetis/terminal", from: "WORKTREE", to: "HEAD" }, env), /from is a commit hash or HEAD/);
  const empty = envWith([...checkout, ["diff --numstat", ""]]);
  assert.equal((await packageDiff({ name: "@thetis/terminal", from: "HEAD", to: "HEAD" }, empty.env)).data.summary, "nothing changed");
});

test("package-push: a push that fails is an answer with git's words, not an error", async () => {
  const refused = envWith([...checkout, [" push", () => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" })]]);
  const { data } = await packagePush({ name: "@thetis/terminal" }, refused.env);
  assert.deepEqual(data, { ok: false, output: "fatal: could not read Username for 'https://github.com'" });
  const fine = envWith([...checkout, [" push", () => ({ code: 0, stdout: "", stderr: "To github.com:x/y.git\n   1111111..2222222  main -> main" })]]);
  assert.deepEqual((await packagePush({ name: "@thetis/terminal" }, fine.env)).data, { ok: true, output: "To github.com:x/y.git\n   1111111..2222222  main -> main" });
  const none = envWith([["rev-parse --show-toplevel", () => ({ code: 128, stdout: "", stderr: "" })]]);
  assert.deepEqual((await packagePush({ name: "@thetis/terminal" }, none.env)).data, { ok: false, output: "@thetis/terminal is not in a git checkout" });
});

test("package-readme: null when the root has none", async () => {
  const { env } = envWith(checkout);
  assert.deepEqual((await packageReadme({ name: "@thetis/terminal" }, env)).data, { text: null });
  await assert.rejects(packageReadme({ name: "@thetis/nope" }, env), /is not installed/);
});

test("a package the admin's own list lacks (a fork replaced it, or another person has it) is found through the operator", async () => {
  const { installedPackage } = await import("../git.js");
  const other = { name: "@thetis/probe", version: "0.0.1", root: "/srv/probe" };
  const calls = [];
  const env = {
    kernel: {
      packages: { list: async () => [{ name: "@alice/probe", replaced: "@thetis/probe" }] },
      // A method, not an arrow: the real operator's `call` needs its `this`, and an unbound copy would throw.
      operator: { async call(method, args) { if (!this) throw new Error("unbound"); calls.push(method + ":" + (args?.user ?? "")); if (method === "users.list") return [{ id: "alice" }, { id: "bob" }]; return args.user === "bob" ? [other] : []; } },
    },
  };
  assert.deepEqual(await installedPackage(env, "@thetis/probe"), other);
  assert.deepEqual(calls, ["users.list:", "packages.list:alice", "packages.list:bob"]);
  await assert.rejects(installedPackage(env, "@thetis/nope"), /not installed in any workspace/);
  await assert.rejects(installedPackage({ kernel: { packages: { list: async () => [] } } }, "@thetis/nope"), /not installed in any workspace/);
});

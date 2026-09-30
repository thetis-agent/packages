// @bitmuse/gh: the GitHub CLI as tools, run as a bot user over HTTPS.
//
// The shape follows @bitmuse/gcloud. One tool runs one gh command given as an
// argument list (never a shell line); `gh --help <words>` resolves the words to
// a command path first (aliases expanded, unknown flags refused) and that path
// is checked against a denylist that cannot be switched off plus the allow,
// deny and read-only settings of this package. The bot's token reaches gh and
// git as environment only: it is never an argument, and the commands whose
// output is the token itself are refused.

export const MAX_OUTPUT_CHARS = 18_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

// Always refused, whatever the settings say: flows that wait for a browser or a
// terminal, tunnels, changes to gh's own installation or to the person's git
// setup, aliases that could hide a shell command behind a name, and the commands
// whose output is the bearer token, which would land in the chat transcript.
export const ALWAYS_DENIED = [
  "auth login",
  "auth logout",
  "auth refresh",
  "auth setup-git",
  "auth switch",
  "auth token",
  "auth git-credential",
  "codespace",
  "extension",
  "alias set",
  "alias import",
  "browse",
  "completion",
  "run watch",
];

// Read-only mode admits a command when its last word is one of these verbs, or
// when it is `search …`, `status`, or `api` without a body (see ghApi).
const READ_VERBS = new Set([
  "list", "view", "status", "diff", "checks", "download", "get", "verify",
  "check", "clone", "checkout", "search", "ls",
]);
const READ_GROUPS = new Set(["search", "status", "help"]);

// ---------------------------------------------------------------- quoting ---

const SAFE = /^[A-Za-z0-9@%_+=:,./-]+$/;
export function shq(arg) {
  const s = String(arg);
  return s !== "" && SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Splits a command line the way a POSIX shell would split words, with single
 * and double quotes and backslash escapes, and nothing else: no expansion, no
 * operators. `|`, `>` and `;` are ordinary characters in a word.
 */
export function splitArgs(line) {
  const out = [];
  let cur = "", inWord = false, q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < line.length && /["\\$`]/.test(line[i + 1])) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; inWord = true; continue; }
    if (c === "\\" && i + 1 < line.length) { cur += line[++i]; inWord = true; continue; }
    if (/\s/.test(c)) { if (inWord) { out.push(cur); cur = ""; inWord = false; } continue; }
    cur += c; inWord = true;
  }
  if (q) throw new Error(`unbalanced ${q} quote in the command`);
  if (inWord) out.push(cur);
  return out;
}

/** The argument list a tool call means, without a leading `gh` (or `git`). */
export function argsOf(input, program = "gh") {
  let args;
  if (Array.isArray(input?.args) && input.args.length) args = input.args.map(String);
  else if (typeof input?.command === "string" && input.command.trim()) args = splitArgs(input.command.trim());
  else throw new Error(`give the command as \`args\` (a list of words) or \`command\` (one line), e.g. args: ${program === "gh" ? '["pr", "list", "--repo", "owner/repo", "--json", "number,title"]' : '["status", "--short"]'}`);
  if (args[0] === program) args = args.slice(1);
  if (!args.length) throw new Error(`the command is empty: name a ${program} command, e.g. \`${program === "gh" ? "repo view owner/repo" : "status"}\``);
  return args;
}

// ---------------------------------------------------------------- policy ----

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);

function listOf(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (t.startsWith("[")) { try { return listOf(JSON.parse(t)); } catch { /* fall through */ } }
    return t.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** True when `entry` (a command or group, words) is a prefix of `path` (words). */
function prefix(entry, path) {
  return entry.length <= path.length && entry.every((w, i) => w === path[i]);
}

/**
 * Checks a resolved command path against the fixed denylist, the `deny` and
 * `allow` settings, and read-only mode. `opts.reads`, when a boolean, settles
 * the read-only question for commands the verb list cannot (gh api). Returns
 * null when admitted, or the sentence saying why not.
 */
export function checkPolicy(commandPath, cfg = {}, opts = {}) {
  const path = words(commandPath);
  const always = ALWAYS_DENIED.find((e) => prefix(words(e), path));
  if (always) return `\`gh ${commandPath}\` is always refused here (\`${always}\`): it waits for a browser or a terminal, changes gh or the person's git setup, or prints the token into the chat.`;
  const deny = listOf(cfg.deny).find((e) => prefix(words(e), path));
  if (deny) return `\`gh ${commandPath}\` is refused by this package's \`deny\` setting (\`${deny}\`).`;
  const allow = listOf(cfg.allow);
  if (allow.length && !allow.some((a) => prefix(words(a), path)))
    return `\`gh ${commandPath}\` is not in this package's \`allow\` setting (${allow.map((a) => `\`${a}\``).join(", ")}).`;
  if (String(cfg.mode ?? "full") === "read-only") {
    const reads = typeof opts.reads === "boolean" ? opts.reads : READ_GROUPS.has(path[0]) || READ_VERBS.has(path.at(-1));
    if (!reads)
      return `\`gh ${commandPath}\` does not look read-only${opts.why ? ` (${opts.why})` : ` (its verb is \`${path.at(-1)}\`)`}, and this package's \`mode\` is read-only. The person can set \`mode\` to \`full\` in the extension settings.`;
  }
  return null;
}

/** The command path gh's own help resolves `args` to, from the USAGE line. */
export function pathFromHelp(text) {
  const m = /^USAGE\s*\r?\n\s*gh((?:\s+[a-z][a-z0-9-]*)*)/m.exec(String(text ?? ""));
  if (!m) return null;
  return m[1].trim();
}

// ----------------------------------------------------------------- running --

function clip(s, n = MAX_OUTPUT_CHARS) {
  s = String(s ?? "");
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.8), tail = n - head;
  return `${s.slice(0, head)}\n… [${s.length - n} characters cut; narrow it with --json/--jq, --limit or a smaller query] …\n${s.slice(-tail)}`;
}

export function timeoutOf(cfg, perCall) {
  const base = Number(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const ms = perCall ? Number(perCall) * 1000 : base;
  return Math.min(600_000, Math.max(5_000, ms));
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function ghBin(cfg) { return str(cfg.ghPath) ?? "gh"; }
function gitBin(cfg) { return str(cfg.gitPath) ?? "git"; }

/**
 * The environment every gh and git call runs with: prompts off, colour off,
 * the token from the settings, and git told to take its GitHub credentials
 * from `gh auth git-credential`, so that clone, fetch and push over https work
 * as the bot without touching the person's own git configuration or keys.
 */
export function envOf(cfg = {}) {
  const vars = {
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    CLICOLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: `!${shq(ghBin(cfg))} auth git-credential`,
  };
  const token = str(cfg.token);
  const host = str(cfg.host);
  if (token) {
    vars.GH_TOKEN = token;
    vars.GH_ENTERPRISE_TOKEN = token;
  }
  if (host) vars.GH_HOST = host;
  if (str(cfg.configDir)) vars.GH_CONFIG_DIR = str(cfg.configDir);
  const name = str(cfg.gitUserName), email = str(cfg.gitUserEmail);
  if (name) { vars.GIT_AUTHOR_NAME = name; vars.GIT_COMMITTER_NAME = name; }
  if (email) { vars.GIT_AUTHOR_EMAIL = email; vars.GIT_COMMITTER_EMAIL = email; }
  return vars;
}

/**
 * Writes `text` to a private file under home for one call. gh reads a body
 * from `--body-file -` or `--input -`, and env.exec has no stdin, so the file
 * is redirected in and removed after.
 */
async function withStdin(env, text, fn) {
  if (typeof text !== "string") return fn(null);
  const mk = await env.exec("umask 077 && mkdir -p .cache/thetis-gh && mktemp -d \"$PWD/.cache/thetis-gh/in.XXXXXX\"", { timeoutMs: 10_000, cwd: env.cwd });
  const dir = String(mk.stdout ?? "").trim();
  if (mk.code !== 0 || !dir) throw new Error("could not create a private directory for the command's input");
  const file = `${dir}/stdin`;
  try {
    await env.writeFile(file, text);
    return await fn(file);
  } finally {
    await env.exec(`rm -rf ${shq(dir)}`, { timeoutMs: 10_000 }).catch(() => {});
  }
}

/** Runs `bin args…` with the package's environment; `opts.stdin` is text fed to it. */
async function run(env, bin, args, opts = {}) {
  const cfg = env.config ?? {};
  return withStdin(env, opts.stdin, async (file) => {
    const cmd = [bin, ...args].map(shq).join(" ") + (file ? ` <${shq(file)}` : " </dev/null");
    return env.exec(cmd, { timeoutMs: opts.timeoutMs ?? timeoutOf(cfg), env: envOf(cfg), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  });
}

export function runGh(env, args, opts = {}) { return run(env, ghBin(env.config ?? {}), args, opts); }
export function runGit(env, args, opts = {}) { return run(env, gitBin(env.config ?? {}), args, opts); }

/** gh's own parse of a command: the resolved path, or its error. */
export async function resolve(env, args) {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "version")) return { ok: true, path: "version" };
  const r = await runGh(env, ["--help", ...args], { timeoutMs: 30_000 });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (/not found|No such file|command not found/i.test(`${r.stderr}`) || r.code === 127)
    throw new Error("gh is not on the PATH of this space. Install the GitHub CLI on the host, or set the `ghPath` setting of this package to its full path.");
  const path = pathFromHelp(text);
  if (r.code !== 0 || path === null) {
    const why = String(r.stderr ?? r.stdout ?? "").trim().split("\n").filter(Boolean)[0] ?? `exit ${r.code}`;
    return { ok: false, error: why };
  }
  return { ok: true, path };
}

function render(r, extra = []) {
  const parts = [...extra, `exit ${r.code}`];
  const out = String(r.stdout ?? "").trim();
  const err = String(r.stderr ?? "").trim();
  if (out) parts.push(`--- stdout ---\n${clip(out)}`);
  if (err) parts.push(`--- stderr ---\n${clip(err, 6000)}`);
  if (!out && !err) parts.push("(no output)");
  return parts.join("\n");
}

const NO_AUTH = /gh auth login|GH_TOKEN environment variable|HTTP 401|Bad credentials|authentication token is invalid/i;
const SSH_REMOTE = /Permission denied \(publickey\)|Could not read from remote repository|Host key verification failed/i;

function authNote(cfg, stderr) {
  if (!NO_AUTH.test(String(stderr ?? ""))) return null;
  return str(cfg.token)
    ? "note: GitHub rejected the configured `token`. Check that the bot user's token is valid, not expired, and has access to this repository (gh_status shows what gh sees)."
    : "note: no `token` is set in this package's settings, so gh has no credentials. See Setup in the package README.";
}

// ------------------------------------------------------------------- tools --

export async function ghRun(input, env) {
  const args = argsOf(input, "gh");
  const cfg = env.config ?? {};
  const l = await resolve(env, args);
  if (!l.ok) return `refused before running: gh rejected the command line.\n${l.error}\n\nFix it (gh_help shows a command's flags) and call again.`;
  if (l.path === "auth status" && args.some((a) => a === "--show-token" || a === "-t"))
    return "refused: `gh auth status --show-token` prints the token into the chat. Nothing was run.";
  const denied = checkPolicy(l.path, cfg);
  if (denied) return `refused: ${denied}\nNothing was run.`;
  if (input.dry_run) return `would run: gh ${args.map(shq).join(" ")}\ncommand: ${l.path || "(gh itself)"}\nadmitted by the allow/deny settings${cfg.mode === "read-only" ? " and read-only mode" : ""}.`;
  const r = await runGh(env, args, { timeoutMs: timeoutOf(cfg, input.timeout_s), cwd: input.cwd, stdin: typeof input.input === "string" ? input.input : undefined });
  const head = [`$ gh ${args.map(shq).join(" ")}`];
  const note = r.code !== 0 ? authNote(cfg, r.stderr) : null;
  if (note) head.push(note);
  if (r.code !== 0 && SSH_REMOTE.test(`${r.stderr}`)) head.push("note: this went over ssh, and this space has no ssh key for GitHub. Use an https remote (`https://github.com/owner/repo.git`); the bot's token covers it.");
  return render(r, head);
}

const isPlain = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** The `gh api` argument list a gh_api call means, and whether it only reads. */
export function apiArgs(input = {}) {
  const args = ["api"];
  const graphql = str(input.graphql);
  let endpoint = str(input.endpoint);
  if (graphql) endpoint = "graphql";
  if (!endpoint) throw new Error("give `endpoint` (a REST path such as repos/{owner}/{repo}/issues) or `graphql` (a query)");
  args.push(endpoint.replace(/^https:\/\/api\.github\.com\//, "").replace(/^\/+/, ""));
  const method = str(input.method)?.toUpperCase() ?? null;
  if (method) args.push("--method", method);
  for (const h of Array.isArray(input.headers) ? input.headers : []) args.push("-H", String(h));
  for (const p of Array.isArray(input.previews) ? input.previews : []) args.push("-p", String(p));
  const fields = { ...(input.params && typeof input.params === "object" ? input.params : {}), ...(graphql ? { query: graphql } : {}), ...(input.variables && typeof input.variables === "object" ? input.variables : {}) };
  let hasFields = false;
  for (const [k, v] of Object.entries(fields)) {
    if (!isPlain(v)) throw new Error(`\`${k}\` is an object or array: gh api fields take strings, numbers, booleans and null. Put the whole body in \`body\` instead.`);
    hasFields = true;
    if (typeof v === "string") args.push("-f", `${k}=${v}`);
    else args.push("-F", `${k}=${v === null ? "null" : String(v)}`);
  }
  let stdin;
  if (input.body !== undefined) {
    if (hasFields && !graphql) throw new Error("give either `body` or `params`, not both");
    stdin = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
    args.push("--input", "-");
  }
  if (input.paginate) {
    args.push("--paginate");
    if (!str(input.jq) && !graphql) args.push("--slurp");
  }
  if (str(input.jq)) args.push("--jq", str(input.jq));
  if (input.include) args.push("--include");
  const mutation = graphql ? /^\s*mutation\b/i.test(graphql) : false;
  const writes = mutation
    || (method ? !["GET", "HEAD"].includes(method) : (input.body !== undefined || (hasFields && !graphql)));
  return { args, stdin, reads: !writes, why: mutation ? "it is a GraphQL mutation" : method ? `its method is ${method}` : "a body or fields make gh api POST" };
}

export async function ghApi(input, env) {
  const cfg = env.config ?? {};
  const { args, stdin, reads, why } = apiArgs(input);
  const denied = checkPolicy("api", cfg, { reads, why });
  if (denied) return `refused: ${denied}\nNothing was run.`;
  const shown = args.map(shq).join(" ");
  if (input.dry_run) return `would run: gh ${shown}${stdin ? `\n--- stdin ---\n${clip(stdin, 4000)}` : ""}`;
  const r = await runGh(env, args, { timeoutMs: timeoutOf(cfg, input.timeout_s), stdin });
  const head = [`$ gh ${shown}`];
  const note = r.code !== 0 ? authNote(cfg, r.stderr) : null;
  if (note) head.push(note);
  return render(r, head);
}

export async function ghGit(input, env) {
  const args = argsOf(input, "git");
  const cfg = env.config ?? {};
  if (String(cfg.mode ?? "full") === "read-only" && /^(push|remote)$/.test(args.find((a) => !a.startsWith("-")) ?? ""))
    return `refused: \`git ${args[0]}\` can change GitHub, and this package's \`mode\` is read-only. Nothing was run.`;
  const r = await runGit(env, args, { timeoutMs: timeoutOf(cfg, input.timeout_s), cwd: input.cwd, stdin: typeof input.input === "string" ? input.input : undefined });
  const head = [`$ git ${args.map(shq).join(" ")}${input.cwd ? `   (in ${input.cwd})` : ""}`];
  if (r.code !== 0 && SSH_REMOTE.test(`${r.stderr}`)) head.push("note: this went over ssh, and this space has no ssh key for GitHub. Use an https remote (`git remote set-url origin https://github.com/owner/repo.git`); the bot's token covers it.");
  const note = r.code !== 0 ? authNote(cfg, r.stderr) : null;
  if (note) head.push(note);
  return render(r, head);
}

export async function ghHelp(input, env) {
  const cfg = env.config ?? {};
  const cmd = Array.isArray(input?.args) && input.args.length ? input.args.map(String)
    : typeof input?.command === "string" ? splitArgs(input.command.trim()) : [];
  const c = cmd[0] === "gh" ? cmd.slice(1) : cmd;
  if (c.some((w) => w.startsWith("-"))) throw new Error("give only the command path to gh_help, without flags, e.g. `pr create`");
  const r = await runGh(env, [...c, "--help"], { timeoutMs: timeoutOf(cfg) });
  const text = String(r.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  if (r.code !== 0) return render(r);
  return clip(text.trim(), input?.full ? MAX_OUTPUT_CHARS : 9000);
}

export async function ghStatus(input, env) {
  const cfg = env.config ?? {};
  const lines = [];
  const v = await runGh(env, ["--version"], { timeoutMs: 30_000 });
  if (v.code !== 0) return `gh did not run: ${String(v.stderr ?? "").trim() || `exit ${v.code}`}\nInstall the GitHub CLI where this space can reach it, or set \`ghPath\`.`;
  lines.push(String(v.stdout).trim().split("\n")[0]);
  lines.push(`token: ${str(cfg.token) ? "set (this package's `token` setting, passed as GH_TOKEN)" : "NOT SET: every command that reaches GitHub will fail. See Setup in the README."}`);
  if (str(cfg.host)) lines.push(`host: ${str(cfg.host)}`);
  const a = await runGh(env, ["auth", "status"], { timeoutMs: 60_000 });
  const auth = `${a.stdout ?? ""}\n${a.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^Token:/i.test(l));
  lines.push(`auth status (exit ${a.code}):`, ...auth.map((l) => `  ${l}`));
  const g = await runGit(env, ["--version"], { timeoutMs: 30_000 });
  lines.push(g.code === 0 ? `${String(g.stdout).trim()}, credentials for https://github.com from \`gh auth git-credential\`` : "git: not found on the PATH (gh_git and clone/checkout will not work)");
  if (str(cfg.gitUserName) || str(cfg.gitUserEmail)) lines.push(`git identity: ${str(cfg.gitUserName) ?? "(name not set)"} <${str(cfg.gitUserEmail) ?? "email not set"}>`);
  lines.push(`mode: ${cfg.mode === "read-only" ? "read-only" : "full (can create, change and delete things on GitHub)"}`);
  const allow = listOf(cfg.allow), deny = listOf(cfg.deny);
  lines.push(`allow: ${allow.length ? allow.join(", ") : "(everything not denied)"}`);
  lines.push(`deny: ${deny.length ? deny.join(", ") : "(none)"}`);
  lines.push(`always denied: ${ALWAYS_DENIED.join(", ")}`);
  return lines.join("\n");
}

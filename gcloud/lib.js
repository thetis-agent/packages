// @bitmuse/gcloud: the gcloud CLI as tools, modelled on googleapis/gcloud-mcp.
//
// The shape follows the MCP server: one tool runs one gcloud command given as an
// argument list (never a shell line), gcloud's own `meta lint-gcloud-commands`
// parses it into a command path with no arguments, and that path is checked
// against a denylist that cannot be switched off plus the allow/deny lists in
// this package's settings. Arguments are quoted one by one, so a pipe, a
// redirection or a `$(...)` in them is passed to gcloud as text and does nothing.

export const MAX_OUTPUT_CHARS = 18_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

// Always refused, whatever the settings say. The first block is gcloud-mcp's own
// default denylist (interactive sessions and tunnels, which would hang an exec
// with no terminal). The second is what this package adds: flows that wait for a
// browser, changes to the shared SDK installation, and the commands whose whole
// output is a bearer token, which would land in the chat transcript.
export const ALWAYS_DENIED = [
  "compute start-iap-tunnel",
  "compute connect-to-serial-port",
  "compute tpus tpu-vm ssh",
  "compute tpus queued-resources ssh",
  "compute ssh",
  "cloud-shell ssh",
  "workstations ssh",
  "app instances ssh",
  "interactive",
  // added here
  "init",
  "auth login",
  "auth application-default login",
  "auth print-access-token",
  "auth print-identity-token",
  "auth application-default print-access-token",
  "components",
  "feedback",
  "survey",
];

// Read-only mode admits a command when its last word is one of these verbs.
const READ_VERBS = new Set([
  "list", "describe", "get", "get-iam-policy", "read", "tail", "search",
  "search-all-resources", "search-all-iam-policies", "analyze-iam-policy",
  "get-value", "get-ancestors", "get-ancestors-iam-policy", "get-effective-org-policy",
  "list-tags", "list-grantable-roles", "list-testable-permissions", "list-files",
  "ls", "cat", "du", "hash", "logs", "log", "versions", "status", "check",
  "lint-condition", "troubleshoot", "query", "export", "show", "print-settings",
  "get-server-config", "get-credentials", "info",
]);
const TRACKS = new Set(["alpha", "beta", "preview"]);

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

/** The argument list a tool call means, without a leading `gcloud`. */
export function argsOf(input) {
  let args;
  if (Array.isArray(input?.args) && input.args.length) args = input.args.map(String);
  else if (typeof input?.command === "string" && input.command.trim()) args = splitArgs(input.command.trim());
  else throw new Error("give the command as `args` (a list of words) or `command` (one line), e.g. args: [\"compute\", \"instances\", \"list\", \"--format=json\"]");
  if (args[0] === "gcloud") args = args.slice(1);
  if (!args.length) throw new Error("the command is empty: name a gcloud command group, e.g. `projects list`");
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
 * gcloud-mcp's rules. A GA entry denies every release track of that command; an
 * `alpha`/`beta` entry denies only that track. An allow entry admits exactly the
 * track it names. Returns null when admitted, or the sentence saying why not.
 */
export function checkPolicy(commandPath, cfg = {}) {
  const path = words(commandPath);
  const ga = TRACKS.has(path[0]) ? path.slice(1) : path;
  const matchesDeny = (entry) => {
    const e = words(entry);
    return TRACKS.has(e[0]) ? prefix(e, path) : prefix(e, ga);
  };
  const always = ALWAYS_DENIED.find(matchesDeny);
  if (always) return `\`gcloud ${commandPath}\` is always refused here (\`${always}\`): it is interactive, changes the SDK installation, or prints a credential into the chat.`;
  const deny = listOf(cfg.deny).find(matchesDeny);
  if (deny) return `\`gcloud ${commandPath}\` is refused by this package's \`deny\` setting (\`${deny}\`).`;
  const allow = listOf(cfg.allow);
  if (allow.length && !allow.some((a) => prefix(words(a), path)))
    return `\`gcloud ${commandPath}\` is not in this package's \`allow\` setting (${allow.map((a) => `\`${a}\``).join(", ")}).`;
  if (String(cfg.mode ?? "full") === "read-only") {
    const verb = ga.at(-1);
    if (!READ_VERBS.has(verb))
      return `\`gcloud ${commandPath}\` does not look read-only (its verb is \`${verb}\`), and this package's \`mode\` is read-only. The person can set \`mode\` to \`full\` in the extension settings.`;
  }
  return null;
}

// ----------------------------------------------------------------- running --

function clip(s, n = MAX_OUTPUT_CHARS) {
  s = String(s ?? "");
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.8), tail = n - head;
  return `${s.slice(0, head)}\n… [${s.length - n} characters cut; narrow it with --format=json(field,…), --filter or --limit] …\n${s.slice(-tail)}`;
}

function timeoutOf(cfg, perCall) {
  const base = Number(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const ms = perCall ? Number(perCall) * 1000 : base;
  return Math.min(600_000, Math.max(5_000, ms));
}

/**
 * Runs gcloud with the package's settings applied as environment, never as
 * flags, so a command that takes no --project is not broken by a default one.
 */
export async function runGcloud(env, args, opts = {}) {
  const cfg = env.config ?? {};
  const bin = typeof cfg.gcloudPath === "string" && cfg.gcloudPath.trim() ? cfg.gcloudPath.trim() : "gcloud";
  const vars = {
    CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
    CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "1",
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "1",
    PYTHONUNBUFFERED: "1",
  };
  const put = (k, v) => { if (typeof v === "string" && v.trim()) vars[k] = v.trim(); };
  put("CLOUDSDK_CORE_PROJECT", cfg.project);
  put("CLOUDSDK_COMPUTE_REGION", cfg.region);
  put("CLOUDSDK_COMPUTE_ZONE", cfg.zone);
  put("CLOUDSDK_CORE_ACCOUNT", cfg.account);
  put("CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT", cfg.impersonateServiceAccount);
  put("CLOUDSDK_CONFIG", cfg.configDir);
  put("CLOUDSDK_ACTIVE_CONFIG_NAME", cfg.configuration);
  put("CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", cfg.credentialFile);
  put("CLOUDSDK_CORE_BILLING_QUOTA_PROJECT", cfg.billingProject);

  let keyFile = null;
  if (typeof cfg.credentialsJson === "string" && cfg.credentialsJson.trim() && !vars.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE) {
    // A key pasted into the settings is written to a private file for the one
    // call and removed after it: gcloud reads credentials from a path only.
    // It lives under home (the one place env.writeFile is sure to reach), in a
    // directory only this user can read.
    const mk = await env.exec("umask 077 && mkdir -p .cache/thetis-gcloud && mktemp -d \"$PWD/.cache/thetis-gcloud/k.XXXXXX\"", { timeoutMs: 10_000, cwd: env.cwd });
    const dir = String(mk.stdout ?? "").trim();
    if (mk.code !== 0 || !dir) throw new Error("could not create a private directory for the configured credentialsJson");
    keyFile = `${dir}/key.json`;
    await env.writeFile(keyFile, cfg.credentialsJson.trim());
    await env.exec(`chmod 600 ${shq(keyFile)}`, { timeoutMs: 10_000 });
    vars.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE = keyFile;
  }

  const cmd = [bin, ...args].map(shq).join(" ") + " </dev/null";
  try {
    return await env.exec(cmd, { timeoutMs: opts.timeoutMs ?? timeoutOf(cfg), env: vars, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  } finally {
    if (keyFile) await env.exec(`rm -rf ${shq(keyFile.replace(/\/key\.json$/, ""))}`, { timeoutMs: 10_000 }).catch(() => {});
  }
}

/** gcloud's own parse of a command: the path without arguments, or its error. */
export async function lint(env, args) {
  const line = ["gcloud", ...args].map(shq).join(" ");
  const r = await runGcloud(env, ["meta", "lint-gcloud-commands", "--command-string", line], { timeoutMs: 60_000 });
  let parsed;
  try { parsed = JSON.parse(String(r.stdout ?? ""))[0]; } catch { parsed = null; }
  if (!parsed) {
    const why = String(r.stderr ?? "").trim().split("\n").filter(Boolean).at(-1) ?? `exit ${r.code}`;
    if (/not found|No such file|command not found/i.test(`${r.stderr}`) || r.code === 127)
      throw new Error("gcloud is not on the PATH of this space. Install the Google Cloud SDK on the host, or set the `gcloudPath` setting of this package to its full path.");
    throw new Error(`gcloud could not parse the command: ${why}`);
  }
  if (!parsed.success) {
    return { ok: false, error: `${parsed.error_type ? parsed.error_type + ": " : ""}${String(parsed.error_message ?? "").trim()}` };
  }
  return { ok: true, path: String(parsed.command_string_no_args ?? "").replace(/^gcloud\s*/, "").trim() };
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

// ------------------------------------------------------------------- tools --

export async function gcloudRun(input, env) {
  const args = argsOf(input);
  const cfg = env.config ?? {};
  const l = await lint(env, args);
  if (!l.ok) return `refused before running: gcloud rejected the command line.\n${l.error}\n\nFix the flags (gcloud_help shows a command's flags) and call again.`;
  const denied = checkPolicy(l.path, cfg);
  if (denied) return `refused: ${denied}\nNothing was run.`;
  if (input.dry_run) return `would run: gcloud ${args.map(shq).join(" ")}\ncommand: ${l.path}\nadmitted by the allow/deny settings${cfg.mode === "read-only" ? " and read-only mode" : ""}.`;
  const r = await runGcloud(env, args, { timeoutMs: timeoutOf(cfg, input.timeout_s), cwd: input.cwd });
  const head = [`$ gcloud ${args.map(shq).join(" ")}`];
  if (r.code !== 0 && /You do not currently have an active account|Reauthentication failed|credentials.*not found|gcloud auth login/i.test(`${r.stderr}`))
    head.push("note: gcloud has no usable credentials in this space. Call gcloud_status, and see the package README (Setup) for the ways to give it some.");
  return render(r, head);
}

export async function gcloudHelp(input, env) {
  const cfg = env.config ?? {};
  let args;
  if (typeof input?.search === "string" && input.search.trim()) {
    args = ["help", "--", ...words(input.search)];
  } else {
    const cmd = Array.isArray(input?.args) && input.args.length ? input.args.map(String)
      : typeof input?.command === "string" ? splitArgs(input.command.trim()) : [];
    const c = cmd[0] === "gcloud" ? cmd.slice(1) : cmd;
    if (c.some((w) => w.startsWith("-"))) throw new Error("give only the command path to gcloud_help, without flags, e.g. `compute instances create`");
    args = [...c, "--help"];
  }
  const r = await runGcloud(env, args, { timeoutMs: timeoutOf(cfg) });
  const text = String(r.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/.\x08/g, "");
  if (r.code !== 0) return render(r);
  return clip(text.trim(), input?.full ? MAX_OUTPUT_CHARS : 9000);
}

export async function gcloudStatus(input, env) {
  const cfg = env.config ?? {};
  const lines = [];
  const v = await runGcloud(env, ["version", "--format=json"], { timeoutMs: 60_000 });
  if (v.code !== 0) {
    return `gcloud did not run: ${String(v.stderr ?? "").trim() || `exit ${v.code}`}\nInstall the Google Cloud SDK where this space can reach it, or set \`gcloudPath\`.`;
  }
  try {
    const j = JSON.parse(v.stdout);
    lines.push(`gcloud ${j["Google Cloud SDK"] ?? "?"}` + Object.entries(j).filter(([k]) => k !== "Google Cloud SDK").map(([k, x]) => `, ${k} ${x}`).join(""));
  } catch { lines.push(String(v.stdout).trim().split("\n")[0]); }

  const a = await runGcloud(env, ["auth", "list", "--format=json(account,status)"], { timeoutMs: 60_000 });
  let accounts = [];
  try { accounts = JSON.parse(a.stdout || "[]"); } catch { /* ignore */ }
  const active = accounts.find((x) => x.status === "ACTIVE")?.account;
  lines.push(`accounts: ${accounts.length ? accounts.map((x) => x.account + (x.status === "ACTIVE" ? " (active)" : "")).join(", ") : "none"}`);
  if (cfg.credentialFile || cfg.credentialsJson) lines.push(`credentials: ${cfg.credentialFile ? `file override ${cfg.credentialFile}` : "credentialsJson setting (a service account key, written per call)"}`);
  if (cfg.impersonateServiceAccount) lines.push(`impersonating: ${cfg.impersonateServiceAccount}`);
  if (!active && !cfg.credentialFile && !cfg.credentialsJson) lines.push("note: no active account, so every command that calls an API will fail. See Setup in the README.");

  const c = await runGcloud(env, ["config", "list", "--format=json"], { timeoutMs: 60_000 });
  try {
    const j = JSON.parse(c.stdout || "{}");
    const core = j.core ?? {}, compute = j.compute ?? {};
    lines.push(`project: ${core.project ?? "(none)"}${cfg.project ? " (from this package's settings)" : ""}`);
    if (compute.region || compute.zone) lines.push(`region/zone: ${compute.region ?? "-"} / ${compute.zone ?? "-"}`);
  } catch { /* ignore */ }

  lines.push(`mode: ${cfg.mode === "read-only" ? "read-only" : "full (can create, change and delete resources)"}`);
  const allow = listOf(cfg.allow), deny = listOf(cfg.deny);
  lines.push(`allow: ${allow.length ? allow.join(", ") : "(everything not denied)"}`);
  lines.push(`deny: ${deny.length ? deny.join(", ") : "(none)"}`);
  lines.push(`always denied: ${ALWAYS_DENIED.join(", ")}`);
  return lines.join("\n");
}

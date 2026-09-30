# @bitmuse/gh

The GitHub CLI as five tools for the model, run as a **bot user** with a token
and no ssh key. Nothing about this space's own GitHub identity is touched: the
token goes to `gh` and `git` as environment for each call, git takes its
https credentials from `gh auth git-credential`, and commits are authored as
the bot. It is a tool group (`gh`), so it joins a chat when the chat mentions
GitHub, pull requests, issues, Actions and the like, or when `tool_search`
loads it.

| Tool | Changes things | What it's for |
|---|---|---|
| `gh_run` | yes | Run one gh command: `args` (a list of words after `gh`) or `command` (one line). `input` is text for stdin (`--body-file -`). `cwd` for commands that act on a checkout. `dry_run` checks it against the policy without running. |
| `gh_api` | yes | The REST (`endpoint`, `method`, `params` or `body`) and GraphQL (`graphql`, `variables`) API through `gh api`, with `paginate`, `jq`, `headers`. |
| `gh_git` | yes | One git command with the bot's credentials, https only: clone, fetch, pull, push, checkout, commit … in a checkout under home. |
| `gh_help` | no | A command's `--help` (usage, flags, examples). |
| `gh_status` | no | gh version, whether a token is set and what GitHub says about it (account, scopes), the git identity, and the policy in force. Call first. |

## How a command is checked

1. The words are quoted one by one and handed to gh, never to a shell.
   `|`, `>`, `&&` and `$(...)` reach gh as text, so chaining does nothing; use
   gh's own `--json`, `--jq`, `--template` and `--limit`.
2. `gh --help <words>` resolves the line first: aliases are expanded (`co` is
   `pr checkout`), an unknown command or flag is refused with gh's own message
   and nothing runs. The USAGE line gives the command path without arguments
   (`pr view`), which is what the policy is checked against, so a flag cannot
   move a command past a deny entry.
3. The policy:
   - **Always refused**: `auth login/logout/refresh/switch/setup-git`,
     `auth token` and `auth git-credential` (their output is the token, which
     would sit in the chat), `auth status --show-token`, `codespace`
     (tunnels and ssh), `extension` (installs code), `alias set` and
     `alias import` (a name could hide a shell command), `browse`,
     `completion`, `run watch` (waits).
   - **`deny`** setting, then **`allow`** setting: comma-separated lists or
     JSON arrays of commands or groups (`repo delete`, `secret`, `pr`).
   - **`mode: read-only`** admits only commands whose last word reads
     (`list`, `view`, `status`, `diff`, `checks`, `download`, `clone`,
     `checkout`, …), `search …`, GET API calls and GraphQL queries, and refuses
     `git push`.
4. It runs with prompts disabled, no pager, no colour, stdin closed (or fed
   from `input` through a private file under `~/.cache/thetis-gh/`, removed
   after), and a timeout (120 s by default, up to 600 s per call with
   `timeout_s`). Output is clipped to 18,000 characters.

## Setup

`gh` (and `git`) must be on the space's `PATH`, or set `ghPath` / `gitPath`.

1. Make a bot user on GitHub (a machine account), or use a GitHub App.
2. Give it access to the repositories the work needs: add it as a collaborator
   or to a team, with the least role that does the job.
3. Create a token for it. A **fine-grained personal access token** scoped to
   those repositories with only the permissions needed (Contents, Pull
   requests, Issues, Actions, Metadata …) is the safest; a classic token with
   `repo` (and `read:org`, `workflow` as needed) also works, as does a GitHub
   App installation token.
4. Paste it into the `token` setting of this extension (it is a secret: the
   panel never shows it, and the tools never print it). Set `gitUserName` and
   `gitUserEmail` so commits made through `gh_git` are the bot's; GitHub's
   noreply form is `<id>+<login>@users.noreply.github.com`.
5. `gh_status` shows what gh sees: the account, its scopes, and the policy.

| Key | Meaning |
|---|---|
| `token` | Secret. The bot's token, passed as `GH_TOKEN` per call. |
| `host` | GitHub Enterprise host (`GH_HOST`). |
| `gitUserName`, `gitUserEmail` | The identity commits carry. |
| `mode` | `full` (default) or `read-only`. |
| `allow`, `deny` | Comma-separated lists or JSON arrays of gh commands or groups. |
| `configDir` | gh's config directory (`GH_CONFIG_DIR`); the token does not live there. |
| `ghPath`, `gitPath` | The executables, when not on the PATH. |
| `timeoutMs` | Default per-command timeout, 120000, clamped 5000–600000. |

As a file layer, for an installation-wide default (under the name it is
installed as, `@thetis/gh` from the registry):

```json
{ "packages": { "@thetis/gh": { "token": "${GH_BOT_TOKEN}", "gitUserName": "thetis-bot", "gitUserEmail": "1234567+thetis-bot@users.noreply.github.com", "deny": "repo delete, secret, ssh-key, gpg-key" } } }
```

## Git without an ssh key

`gh_git` sets `credential.helper` to `gh auth git-credential` for the one
call (through `GIT_CONFIG_*`, so nothing is written to the person's git
config) and `GIT_TERMINAL_PROMPT=0`. Any `https://github.com/…` remote then
authenticates as the bot. An `git@github.com:` remote fails, and the tool says
so and how to switch the remote. `gh repo clone` and `gh pr checkout` through
`gh_run` get the same environment, and gh's own `git_protocol` should stay
`https` (the default).

## Permissions

What the tools can do is what the bot's token can do. The allow/deny lists
and read-only mode are guard rails for the model, not a security boundary:
for that, scope the token and the bot's repository access.

## Test

`node test.smoke.mjs` checks the splitter, the policy and the `gh api`
argument builder offline, then the tools against the local gh and git
(resolution and aliases, refusals, a dry run, stdin plumbing, the git identity
and credential helper, the auth notes). No token is needed.

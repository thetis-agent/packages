# @thetis/tool-exec

The tools that let the model run code in its own userspace and change what is installed there: a shell, package install and removal, forks, deletion, and subagents. It is a `tool` package in the default `systemPackages["*"]`, so it runs in each person's fence; every command it runs and every package it installs stays inside that fence. Reading, editing and searching files is `@thetis/tools-files`.

## What it provides

Six tools, declared in `thetis.tools`:

| Tool | Arguments | Returns |
|---|---|---|
| `exec` | `cmd` (required), `cwd` (relative to home), `timeoutMs` | `exit <code>`, then `stdout:` and `stderr:` blocks when they are not empty. |
| `install_package` | `source` (required): a path relative to home, a git URL, or `url#dir` | `installed <name>@<version> (<type>); steps: ...; tools: ...; replaced <name>. Live on the next turn.` |
| `uninstall_package` | `name` (required) | `uninstalled <name>`. The files stay. When the package was a fork, the original comes back. |
| `fork_package` | `name` (required, an installed package), `as` (directory under `packages/`; default the unscoped name) | `forked <name>@<version> to packages/<as> as @<you>/<as>@<version>-fork.N ...` and the next step. Does not install. |
| `delete_package` | `name` (required) | `deleted <name> and its files at <path>; <original> is back in place. Live on the next turn.` Refuses `@thetis/*` packages. |
| `spawn_subagent` | `task` (required) | `[subagent <session id>]` and the subagent's final reply. The subagent runs in the same userspace with the same files and packages. |

Bench suites: `assembly-cost@1` and `tool-recall@1`, peer group `tools`. `BENCH.md` in this directory is the generated comparison.

![tool-recall@1 comparison](bench/tool-recall-v1/chart.svg)

No steps, no service, no UI.

`fork_package` copies the package without `node_modules`, renames it `@<you>/<as>`, gives it the version `<origin>-fork.1` (or `fork.N+1` when a fork is already installed), removes `scripts` and `devDependencies`, links the dependencies the original resolves, and writes `thetis.forkedFrom`. Installing the fork replaces the original in one operation; uninstalling or deleting the fork puts the original back. `as` must be one plain directory name.

## Configuration

`config.packages["@thetis/tool-exec"]` has no keys. The package reads no environment variables. The install rules are the kernel's: a person's package must be scoped `@<you>/<name>`, and a `@thetis/*` name installs only for an admin.

## Use

The cycle the model runs to change its own behaviour: write a package with `@thetis/tools-files`, test it, install it.

```
write_path { path: "packages/hello/package.json", contents: "..." }
write_path { path: "packages/hello/index.js", contents: "..." }
exec { cmd: "node -e \"import('./packages/hello/index.js').then(m => console.log(Object.keys(m)))\"" }
install_package { source: "packages/hello" }
```

Change a shipped package, then put it back:

```
fork_package { name: "@thetis/tools-plan" }
edit_path { path: "packages/tools-plan/index.js", old_text: "...", new_text: "..." }
install_package { source: "packages/tools-plan" }
delete_package { name: "@alice/tools-plan" }
```

Hand a task to a subagent and wait for its reply:

```
spawn_subagent { task: "Read docs/ and list every command the CLI accepts." }
```

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: six tools and the bench declaration. |
| `src/index.ts` | The six tool functions. Forking is `forkPackage` from `@thetis/lib/pkg-fs`; install, uninstall and delete go through `env.kernel.packages`; subagents through `env.kernel.sessions`. |
| `BENCH.md`, `bench/` | The generated benchmark view and reports. |

## Tests

The package has no test directory of its own. `npm test` from the runtime root covers it through the host tests: `packages/host/test/e2e.test.ts` runs the write, exec and install cycle through a real fence.

See docs/20-tools.md in the runtime repository.

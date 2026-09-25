---
name: developing
description: Changing Thetis's own source on the host: build and test commands, the two git repositories, the three guards, where new code belongs, the end-to-end fixture. Use when you build or test the runtime, a change was rejected or is not live, you add a package to the runtime, or you cross the fence protocol.
metadata:
  title: Changing Thetis itself
  tags: [development, build, test, guards, loc, boundaries, layering, submodule, git, tsconfig, ci, fixtures, rpc, self-modification]
  related: [thetis/packages, thetis/configuration, thetis/troubleshooting, thetis/using]
  version: 1
---
# Changing Thetis itself

This is the host side. You are editing the source the daemon runs, not writing a package in a userspace. For a package inside a fence, read `thetis/packages` instead: that world has no build step and no compiler.

## Build and test

There is no test framework. It is `node:test` and `node:assert/strict`.

```sh
npm run build        # tsc -b over the project references in the root tsconfig.json
npm run build:runtime # only runtime/src; no extension source required
npm test             # builds, then runs every suite in both repositories
npm run clean        # remove runtime and extension build output
node bin/thetis.js <command>          # the CLI, against a running daemon if there is one
```

`npm test` builds first, then runs runtime architecture tests under `test/`, compiled runtime tests under `dist/test/`, compiled extension tests under `packages/*/dist/test/`, and plain-JavaScript extension tests under `packages/*/test/`.

One file, after a build:

```sh
node --test dist/test/kernel/loc.test.js
node --test --test-name-pattern "tool loop" dist/test/host/e2e.test.js
THETIS_TEST_SANDBOX=none npm test     # no bubblewrap: faster, and the only way on a host without it
THETIS_TEST_VERBOSE=1 npm test        # the browser and gateway suites print their logs
```

## Two repositories, and the order

`src/` and `test/` belong to the runtime repository. `packages/` is a git submodule for extensions and host applications, with its own history. A change to an extension requires **two commits**:

```sh
cd packages && git add -A && git commit      # first: the package change itself
cd ..       && git add packages && git commit # then: the runtime, recording the new pointer
```

Get this wrong and the work looks done and is not. Commit only in `runtime` and you have recorded nothing but a pointer to an old tree. Commit only in `packages` and `runtime` still points at the old tree, so a fresh clone, and CI, which checks out recursively, both build the code you did not change.

Not every runtime commit moves the pointer. A commit that touches only the runtime's own files says so, and the pointer moves in a commit of its own or alongside the next change. What is never right is a package change that no runtime commit ever points at.

## The three guards

Each of these is a test. Each fails loudly, and each is telling you something about where your code belongs.

**The kernel line count.** `test/kernel/loc.test.ts` fails when the kernel is at or over its limit, which the `LIMIT` constant in that file states and is the only place that states it truly. The counter excludes blank lines, comment-only lines, `import` statements including multi-line ones, `export ... from` re-exports, and test files. So comments are free and cost you nothing: the way to buy room is to move mechanism out, not to compress prose.

Raising the limit is a real option and has been taken twice, but only after the mechanism went elsewhere. If your change is authority, the kernel is where it belongs and the raise is honest. If it is mechanism, the guard has just told you it is in the wrong package.

**The layering.** `test/architecture.test.mjs` parses imports and enforces the internal module boundaries in `ARCHITECTURE.md`. The kernel imports only contracts and library mechanisms. Runtime modules use relative imports; extensions use the public `@thetis/runtime` exports. Only the host resolves the IoC container. `test/kernel/seams.test.ts` separately snapshots the fence operations, RPC and control methods, door routes, contract constants and configuration tiers.

**The skills lint.** `packages/skills-thetis/test/skills.test.js` checks frontmatter, body limits, a style deny-list, that every relative link resolves inside the package, and that the set of skills matches a list in the test. Adding a skill means adding its id to that list.

## Where a new thing goes

The import rule above is not the same question as this one, and passing it is not evidence you got this right. The daemon (`kernel`, `host`, `sandbox`, `door`, `lib`, `contracts`, `gateway-cli`) is finished: it is identity, package authority, the fence, the pipe, the record, the port and the latch. It runs steps and moves their results. It never makes a model call, never runs a tool, never interprets a `ProviderCall`, never knows a package by name. **A feature that seems to need the daemon is a feature in the wrong package.** Inside the daemon the rule is: mechanism goes to `@thetis/runtime/lib` or `@thetis/runtime/sandbox`, and the decision about who may use it stays in `@thetis/runtime/kernel`. A part stays in the kernel only when delegating it would lose a guarantee that rests on the kernel being the one that does it.

| What you are adding | Where |
|---|---|
| A decision about who may do what | `src/kernel` |
| A mechanism: something that does work and has no opinion about who asked | `src/lib`, or `src/sandbox` when it is fence machinery |
| A type in the shared vocabulary | `src/contracts` |
| A capability: a tool, a step, a provider, a service, a page | a package, never the kernel |
| The model-call loop, or any other turn-time behaviour | a step in a package; the default is the `call` step of `@thetis/harness-core` in phase `execute` |
| A default for a package's setting | that package's manifest, `thetis.config.<key>.default` |
| An admin feature that needs the host itself: its filesystem, a key store, the grant records | a package of type `host`, such as `@thetis/host-grants`; the host loads it by `thetis.host.name`, and it answers `host.<name>.<export>` on the operator channel |

An agent that knows only the import rule will put mechanism in the kernel, pass the boundary test, and fail the line count without understanding why. That is the line count doing its job.

Kernel services take their collaborators through constructors. `createKernel` in `src/host/kernel.ts` is the composition root: it registers typed factories, accepts binding overrides, and then resolves services. Keep container lookups there; do not introduce service locators in domain code. Share contracts once and keep classes focused on one responsibility. `ARCHITECTURE.md` records the SOLID, DRY and clean-code rules, and `test/host/runtime.test.ts` proves that injected adapters work without installed extensions.

## Adding a TypeScript package to the runtime

Five steps, and the fourth is the one that fails silently:

1. `packages/<dir>/tsconfig.json` extending `../../tsconfig.base.json`, with `rootDir: "."`, `outDir: "dist"`, `include: ["src/**/*.ts", "test/**/*.ts"]`, and a reference to `../../tsconfig.runtime.json` plus any other extension projects it imports.
2. `packages/<dir>/package.json` with `"main": "dist/src/index.js"`, and `"@thetis/runtime": "^0.1.0"` in `peerDependencies` and `"@thetis/runtime": "file:../.."` in `devDependencies`.
3. Source under `src/`, tests under `test/`.
4. A `{ "path": "packages/<dir>" }` entry in the **root** `tsconfig.json`, after the packages it references. Miss this and `tsc -b` never compiles the package: no error, an empty `dist/`, and a runtime complaint that the main entry does not exist.
5. `npm install` to link the workspace, then `npm run build`.

## House rules the compiler will not teach you

Strict TypeScript, ECMAScript modules. **Relative import paths end in `.js`** even though the sources are `.ts`. Extensions import shared mechanisms by subpath, such as `@thetis/runtime/lib/ids`; the runtime package's `exports` map exposes `./lib/*`. Runtime build output is `dist/src/` and `dist/test/`. Extensions retain their own `dist/` directories.

## What it takes for a change to be live

Editing a file changes nothing by itself. Four answers, and `thetis/troubleshooting` has the full table:

- Package code a fence loads per call, a manifest, a host package's entry: the next call has it.
- A service's module graph, a provider, the agent: `thetis reload --user <id>`, or `--all`.
- `thetis.config.json` or `.env`: `thetis config reload`.
- The daemon itself (the kernel, the host, the sandbox, the door, `lib`, `contracts`, the `thetis` command): a new process, only for the daemon's own bugs, and the daemon does it: `thetis restart`. It waits for every turn to end, counts down, and exits so systemd starts it again; no sudo.

For configuration, `CONFIG_TIERS` in `src/kernel/config.ts` declares per key which of those applies, and `thetis config reload` prints which keys it applied and which are still waiting on a process. **A key with no entry there is treated as needing a restart**, so adding a configuration key without declaring its tier makes it quietly un-reloadable. See `thetis/configuration`.

The installer follows the same rule: an update builds, runs `thetis config reload` and `thetis reload --all`, and asks the daemon for a restart only when the systemd unit changed or `thetis status --json` reports `daemon.stale`.

The control panel's **Overview** does the same from the browser, through `@thetis/host-update` on the host: **Check for updates** fetches and lists the incoming commits of the runtime and of the packages submodule, **Update now** pulls, moves the submodule to the pinned commit, runs `npm ci` and the build, and writes its record to `$THETIS_HOME/update/last.json` as it goes. Nothing running changes by itself: the card then offers **Reload N workspaces** and **Restart the daemon**. Node, the OS packages and the systemd unit stay the installer's.

## Testing something that crosses the fence

Add a case to `test/host/e2e.test.ts`, which shares one kernel and collects events from `kernel.sessions.send(...)`. **Run it through the real agent. Do not mock the fence.** That suite exists because the fence is where the interesting failures are.

New model behaviour means teaching the echo provider fixture a trigger word. Its current vocabulary is in `references/e2e-fixture.md`. The loop's own cases (cancel mid-stream, dangling tool calls closed, an unknown tool refused, a withheld tool honoured, partial text kept) are tests of `@thetis/harness-core`, not of the kernel.

## Changing the fence protocol

A new RPC method a fence may call has to be added in three files at once, and missing one gives a runtime error with no compile-time signal. A new fence operation is two. Both lists are in `references/fence-protocol.md`.

## What CI checks that your suite does not

- `npm test` twice, with `THETIS_TEST_SANDBOX` set to `auto` and to `none`.
- The benchmark reports are regenerated and compared; a difference fails. If you changed scoring, bump the version in `packages/bench/package.json`, because the scorer version is part of a report's digest and an unbumped report stays authoritative. The suites are then rerun to prove nothing is written the second time, since a suite that is not deterministic cannot be compared.
- Every commit of every ref of both repositories is grepped for key shapes, and a tracked `.env`, `.thetis/`, `*.pem`, `*.key` or `id_rsa` fails the job. A `.env` committed while iterating fails CI long after the commit that did it.

## Sources

- ARCHITECTURE.md, test/kernel/loc.test.ts, test/architecture.test.mjs, test/kernel/seams.test.ts
- packages/skills-thetis/test/skills.test.js and packages/skills-thetis/README.md
- package.json (scripts), tsconfig.json, tsconfig.base.json, .gitmodules
- src/host/kernel.ts, src/kernel/config.ts
- test/host/e2e.test.ts and test/host/fixtures/provider-echo/index.js
- .github/workflows/ci.yml

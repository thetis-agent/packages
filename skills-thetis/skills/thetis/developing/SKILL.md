---
name: developing
description: Changing Thetis's own source on the host, as opposed to writing a package inside a fence. The build and test commands, the two git repositories and the order you commit them in, the three guards that reject a change and how to satisfy them, where a new thing belongs (mechanism, authority, type, capability), adding a TypeScript package to the runtime, what CI checks beyond the suite, the end-to-end fixture's trigger words, and the files that have to move together when the fence protocol changes. Use when you ask "how do I build and test the runtime", "why was my change rejected", "where does this code belong", "the kernel is too many lines", "I added a package and nothing compiled it", "how do I commit a change to packages", "why is my change not live", or "how do I test something that crosses the fence".
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
npm test             # builds, then runs every suite in both repositories
npm run clean        # rm -rf packages/*/dist and the tsbuildinfo files
node bin/thetis.js <command>          # the CLI, against a running daemon if there is one
```

`npm test` runs two globs, and the reason matters: `packages/*/dist/test/**/*.test.js` for TypeScript packages, which are compiled first, and `packages/*/test/**/*.test.js` for plain-JavaScript packages, which are not. A test you wrote in TypeScript and did not build will silently not run.

One file, after a build:

```sh
node --test packages/kernel/dist/test/loc.test.js
node --test --test-name-pattern "tool loop" packages/host/dist/test/e2e.test.js
THETIS_TEST_SANDBOX=none npm test     # no bubblewrap: faster, and the only way on a host without it
THETIS_TEST_VERBOSE=1 npm test        # the browser and gateway suites print their logs
```

## Two repositories, and the order

`packages/` is a git submodule with its own history. A change to any package is **two commits**:

```sh
cd packages && git add -A && git commit      # first: the package change itself
cd ..       && git add packages && git commit # then: the runtime, recording the new pointer
```

Get this wrong and the work looks done and is not. Commit only in `runtime` and you have recorded nothing but a pointer to an old tree. Commit only in `packages` and `runtime` still points at the old tree, so a fresh clone, and CI, which checks out recursively, both build the code you did not change.

Not every runtime commit moves the pointer. A commit that touches only the runtime's own files says so, and the pointer moves in a commit of its own or alongside the next change. What is never right is a package change that no runtime commit ever points at.

## The three guards

Each of these is a test. Each fails loudly, and each is telling you something about where your code belongs.

**The kernel line count.** `packages/kernel/test/loc.test.ts` fails when the kernel is at or over its limit, which the `LIMIT` constant in that file states and is the only place that states it truly. The counter excludes blank lines, comment-only lines, `import` statements including multi-line ones, `export ... from` re-exports, and test files. So comments are free and cost you nothing: the way to buy room is to move mechanism out, not to compress prose.

Raising the limit is a real option and has been taken twice, but only after the mechanism went elsewhere. If your change is authority, the kernel is where it belongs and the raise is honest. If it is mechanism, the guard has just told you it is in the wrong package.

**The layering.** `packages/kernel/test/boundaries.test.ts` enforces `contracts < lib < sandbox` and `kernel < host`. The kernel may not import `@thetis/sandbox`. Only `@thetis/host` and `@thetis/gateway-cli` may import the kernel.

**The skills lint.** `packages/skills-thetis/test/skills.test.js` checks frontmatter, body limits, a style deny-list, that every relative link resolves inside the package, and that the set of skills matches a list in the test. Adding a skill means adding its id to that list.

## Where a new thing goes

The import rule above is not the same question as this one, and passing it is not evidence you got this right. The rule is: **mechanism goes to `@thetis/lib` or `@thetis/sandbox`, and the decision about who may use it stays in `@thetis/kernel`.** A part stays in the kernel only when delegating it would lose a guarantee that rests on the kernel being the one that does it.

| What you are adding | Where |
|---|---|
| A decision about who may do what | `packages/kernel` |
| A mechanism: something that does work and has no opinion about who asked | `packages/lib`, or `packages/sandbox` when it is fence machinery |
| A type in the shared vocabulary | `packages/contracts` |
| A capability: a tool, a step, a provider, a service, a page | a package, never the kernel |

An agent that knows only the import rule will put mechanism in the kernel, pass the boundary test, and fail the line count without understanding why. That is the line count doing its job.

Every class takes its dependencies through its constructor. No class builds its own, and there is no global state. `createKernel` in `packages/host/src/kernel.ts` is the only place kernel services are constructed, which is why a change there is often the whole of wiring a new service.

## Adding a TypeScript package to the runtime

Five steps, and the fourth is the one that fails silently:

1. `packages/<dir>/tsconfig.json` extending `../../tsconfig.base.json`, with `rootDir: "."`, `outDir: "dist"`, `include: ["src/**/*.ts", "test/**/*.ts"]`, and a `references` entry for each package it imports.
2. `packages/<dir>/package.json` with `"main": "dist/src/index.js"`, and `@thetis/contracts` in **both** `peerDependencies` and `devDependencies`.
3. Source under `src/`, tests under `test/`.
4. A `{ "path": "packages/<dir>" }` entry in the **root** `tsconfig.json`, after the packages it references. Miss this and `tsc -b` never compiles the package: no error, an empty `dist/`, and a runtime complaint that the main entry does not exist.
5. `npm install` to link the workspace, then `npm run build`.

## House rules the compiler will not teach you

Strict TypeScript, ECMAScript modules. **Import paths end in `.js`** even though the sources are `.ts`. `@thetis/lib` is imported by subpath only, as `@thetis/lib/ids`, and has no root export: adding a module there means adding it to the `exports` map in `packages/lib/package.json`. Build output is `dist/src/` and `dist/test/`.

## What it takes for a change to be live

Editing a file changes nothing by itself. Three answers, and `thetis/troubleshooting` has the full table:

- Package code a fence loads per call: the next call has it.
- A service's module graph, a provider, the agent: `thetis reload --user <id>`.
- The kernel, the host, the sandbox, the door: a daemon restart.

For configuration, `CONFIG_TIERS` in `packages/kernel/src/config.ts` declares per key which of those applies, and `thetis config reload` prints which keys it applied and which are still waiting on a process. **A key with no entry there is treated as needing a restart**, so adding a configuration key without declaring its tier makes it quietly un-reloadable. See `thetis/configuration`.

## Testing something that crosses the fence

Add a case to `packages/host/test/e2e.test.ts`, which shares one kernel and collects events from `kernel.sessions.send(...)`. **Run it through the real agent. Do not mock the fence.** That suite exists because the fence is where the interesting failures are.

New model behaviour means teaching the echo provider fixture a trigger word. Its current vocabulary is in `references/e2e-fixture.md`.

## Changing the fence protocol

A new RPC method a fence may call has to be added in three files at once, and missing one gives a runtime error with no compile-time signal. A new fence operation is two. Both lists are in `references/fence-protocol.md`.

## What CI checks that your suite does not

- `npm test` twice, with `THETIS_TEST_SANDBOX` set to `auto` and to `none`.
- The benchmark reports are regenerated and compared; a difference fails. If you changed scoring, bump the version in `packages/bench/package.json`, because the scorer version is part of a report's digest and an unbumped report stays authoritative. The suites are then rerun to prove nothing is written the second time, since a suite that is not deterministic cannot be compared.
- Every commit of every ref of both repositories is grepped for key shapes, and a tracked `.env`, `.thetis/`, `*.pem`, `*.key` or `id_rsa` fails the job. A `.env` committed while iterating fails CI long after the commit that did it.

## Sources

- packages/kernel/test/loc.test.ts, packages/kernel/test/boundaries.test.ts
- packages/skills-thetis/test/skills.test.js and packages/skills-thetis/README.md
- package.json (scripts), tsconfig.json, tsconfig.base.json, .gitmodules
- packages/host/src/kernel.ts, packages/kernel/src/config.ts
- packages/host/test/e2e.test.ts and packages/host/test/fixtures/provider-echo/index.js
- .github/workflows/ci.yml

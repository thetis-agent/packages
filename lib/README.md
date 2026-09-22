# @thetis/lib

Mechanism with no policy: ids, JSON files, queues, the container, the journal, the RPC framing, the socket server and client, the userspace layout, package file operations, scrypt, the store checks and mirror, the storage conformance suite, and the configuration layers. Nothing here decides who may do what; the kernel decides, with these parts. The package runs in the host process, where the kernel, the sandbox, the host, and the command line import it, and inside each fence, where the userspace agent imports the RPC framing.

## What it provides

A library: nothing in `thetis`. Each module is a subpath export: `import { newId } from "@thetis/lib/ids"`. There is no root export.

The layering rule: `lib` imports only `@thetis/contracts`. `sandbox`, `kernel`, and `host` import it. The test `packages/kernel/test/boundaries.test.ts` enforces the rule.

| Subpath | Content |
|---|---|
| `ids` | `newId(prefix)`, `now()`. |
| `json` | `readJson`, `writeJson` (through a temporary file and a rename), `JsonFile`. |
| `async` | `AsyncQueue`. |
| `error` | `CodedError`, `assert`, `errorMessage`, `errorCode`. |
| `container` | `Container`, `token`. |
| `journal` | `Journal`, `JournalRow`, `JournalFilter`. |
| `json-store` | `JsonDirStore`: one JSON file per record, ids checked before they become paths. |
| `rpc-frames` | `PendingCalls`, `callHandler`, `readFrames`, `encodeFrame`: the `{ id, method, args }` framing. |
| `ndjson-socket` | `RpcSocketServer`, `connectRpcSocket`: the framing over a Unix socket. |
| `userspace-layout` | `UserspaceLayout`: `pathFor`, `exists`, `ensure`, `remove`. |
| `pkg-fs` | `splitSource`, `isGitSource`, `cloneCommand`, `buildCommand`, `isInside`, `linkDir`, `removeLink`, `copyPackageAs`, `findDependency`, `forkVersion`, `forkPackage`, and the other package file operations. |
| `crypto` | `randomHex`, `scryptHex`. |
| `freshness` | `newestMtime`. |
| `restart` | `RestartLatch`, `isSupervised`. The latch reads `control` through the configuration reference on each use, so a reloaded `control.*` is what it sees. |
| `store` | `assertStoreId`, `storeId`, `assertStoreDoc`, `assertJsonValue`: the shared checks every driver runs. `memoryStore()`: a Map-backed driver for tests and the bench. `StoreMirror`: one namespace held in memory and written through in order, so the kernel's records stay synchronous; `flush()` on shutdown. |
| `store-conformance` | `storeConformance(name, open, close?)`: the `node:test` cases a storage driver passes. |
| `config` | `validateDecls`, `forkChain`, `mergedDecls`, `defaultsOf`, `isSecretKey`, `checkValue`, `mergeDocs`, `findRefs`, `resolveRefs`, `describe`, `changedPackages`, `parseDotEnv`, `EnvFile` (the `.env` file re-read on change, a shell value winning over the file's), `LayeredConfig` (the four layers over a driver in `config/*` and `secrets/*`, layer-major along a fork chain). |

The mount and ssh mechanism that used to be here (`mounts`, `ssh`) is the lib of `@thetis/host-grants`, the host package that answers `host.grants.*`: it needs the host, not the daemon, and moving it out is what made the daemon's last restart the last one.

## Use

The container. `bind` registers a factory; a second `bind` on the same token replaces the first and clears the cached instance. `get` calls the factory on the first call, returns the same instance later, and throws when the token has no binding.

```ts
import { Container, token } from "@thetis/lib/container";

const Log = token<(line: string) => void>("log");
const c = new Container().bind(Log, () => (line) => process.stderr.write(line + "\n"));
c.get(Log)("hello");
```

The journal. Rows go to `<home>/journal.jsonl`, one JSON object per line; past 16 MiB the file rolls to `journal.1.jsonl`. What goes in a row is the caller's decision.

```ts
import { Journal } from "@thetis/lib/journal";

const journal = new Journal(home);
journal.append({ kind: "user.create", actor: "operator", target: "alice", data: { role: "user" } });
const rows = journal.tail(20, { kind: "user.create" });
```

The socket client, the way the command line reaches a running kernel. `connectRpcSocket` resolves `undefined` when no socket file exists or nothing listens on it.

```ts
import { connectRpcSocket } from "@thetis/lib/ndjson-socket";

const remote = await connectRpcSocket(socketPath);
if (remote) {
  const users = await remote.call("users.list", {});
  remote.close();
}
```

## Files

| File | Content |
|---|---|
| `src/ids.ts` | Random ids with a prefix, ISO timestamps. |
| `src/json.ts` | Atomic JSON file read and write. |
| `src/async.ts` | An async iterable queue. |
| `src/error.ts` | Errors with a `code` string. |
| `src/container.ts` | The inversion-of-control container. |
| `src/journal.ts` | The append-only record. |
| `src/json-store.ts` | One JSON file per record. |
| `src/rpc-frames.ts` | Pending calls, frame encoding, line reading. |
| `src/ndjson-socket.ts` | The Unix socket server (mode `0600`) and client. |
| `src/userspace-layout.ts` | The directories of one userspace. |
| `src/pkg-fs.ts` | Sources, clones, links, copies, forks. |
| `src/crypto.ts` | Random hex and scrypt. |
| `src/freshness.ts` | The newest modification time under a set of directories. |
| `src/restart.ts` | The restart latch. |
| `src/store.ts` | Store ids and documents, the memory driver, the mirror. |
| `src/store-conformance.ts` | The driver test suite. |
| `src/config.ts` | Declarations, chains, layers, references, the env file. |

## Tests

`npm test` from the runtime root builds and runs every suite. The suites of this package are under `packages/lib/test/`: `lib.test.ts` (the container, the async queue, package sources, the JSON directory store, the RPC framing), `store.test.ts` (ids, documents, the memory driver, the mirror), `config.test.ts` (declarations, the fork chain, layer-major merging, references, `describe`, the env file, `LayeredConfig` over `memoryStore()`), `freshness.test.ts` and `restart.test.ts`. To run one alone after `npm run build`: `node --test packages/lib/dist/test/lib.test.js`.

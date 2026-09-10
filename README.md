# Thetis packages

The deployment registry of versioned packages. This repository is separate
from the kernel, contracts, and shared libraries.

A package is a directory with `package.json` and `index.ts`. It may export
`stages`, `skills`, and `spawn`. A package with no exports is a library.
Packages declare what they require; another package or the kernel provides
it. The kernel matches names and names no package itself.

| Package | Role |
| --- | --- |
| `core` | The loop, the event pipeline, the stored prefix, spill, notices, compaction |
| `cli` | Person-scoped command service over a Unix socket |
| `gateway-web` | WebSocket gateway and the lifted web surface, served per person on the target's public socket |
| `gateway-login` | The `password` authority |
| `tools-files` | File read/search/edit handlers with canonical grant checks |
| `storage-files` | Default bounded byte objects and durable append logs behind `contract/storage` |
| `retriever-local` | BM25 + dense with fusion as a setting; answers `retrieve` |
| `provider-mock` | Scripted provider with a cache model |
| `provider-openai-compatible` | HTTP/SSE adapter, OpenRouter-compatible |
| `registries` | Immutable local git registry delivery |
| `metrics` | Metrics service |
| `evaluator` | Paired-run scoring behind the gate |

A package may depend only on shared libraries and contracts. Importing
another package directly is refused.

`storage-files` exports the storage factory from the shared `lib/storage`
implementation. It uses existing filesystem grants and adds no service process.
The runtime's [storage contract](https://github.com/thetis-agent/runtime/blob/main/docs/contracts/storage.md)
documents bounds, durability and the kernel's fixed reviewed default.

GitHub `CI` checks this repository with the sibling runtime, including the full
conformance, deployment and performance suite. Manual `Release` delivery requires
an existing version tag and an exact reviewed runtime commit; it publishes the
offline distribution without repeating CI acceptance checks (ADR 0055).
Tag identity, transferred checksums and release signatures remain checked. Configure the peer checkout
and release environment using the runtime's
[CI and delivery guide](https://github.com/thetis-agent/runtime/blob/main/docs/ci-delivery.md).
Production promotion remains the kernel's evaluator-backed, code-confirmed act.

Imports of shared runtime code use `@/lib/...` and `@/contracts/...`; `@/`
means the installed runtime root. Imports within a package stay relative.
Run checks and tests through the sibling runtime's npm scripts, which install
the resolution preload before loading source code.

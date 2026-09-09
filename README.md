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
| `gateway-web` | WebSocket gateway (wire protocol only; the UI is not yet lifted) |
| `gateway-login` | The `password` authority |
| `tools-files` | File read/search/edit handlers with canonical grant checks |
| `retriever-local` | BM25 + dense with fusion as a setting; answers `retrieve` |
| `provider-mock` | Scripted provider with a cache model |
| `provider-openai-compatible` | HTTP/SSE adapter, OpenRouter-compatible |
| `registries` | Immutable local git registry delivery |
| `metrics` | Metrics service |
| `evaluator` | Paired-run scoring behind the gate |

A package may depend only on shared libraries and contracts. Importing
another package directly is refused.

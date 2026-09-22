# @thetis/skills-orleans

The skills that teach an agent Microsoft Orleans, the .NET framework for distributed virtual actors. It is a `skill` package: a directory of `SKILL.md` files and nothing else. A loader package puts the skills in front of the model. The text is Simplified Technical English (ASD-STE100).

The subject is the framework as the official documentation at https://learn.microsoft.com/en-us/dotnet/orleans/ describes it for Orleans 10 on .NET 10. Each skill ends with a `## Sources` list of the pages it was written from. Nothing here is about a particular application; a project that uses Orleans keeps its own skills in its own package.

## What it provides

The manifest declares `"thetis": { "type": "skill", "skills": "skills" }`. No steps, no tools, no service, no UI, no bench suites.

Fifteen skills under `skills/orleans/`. None is universal: the loader puts one brief per top-level skill in the prompt, and a body is fetched by id. The first one, `orleans`, is the index.

| Id | Content |
|---|---|
| `orleans` | What a grain, a silo and a cluster are, the runtime guarantees, and which child skill to fetch. The index. |
| `orleans/grains` | Grain classes and interfaces, keys, references, lifecycle, reentrancy, one-way calls, stateless workers, call filters, RequestContext. |
| `orleans/hosting` | Silo and client builders, options, endpoints, local development, co-hosting with ASP.NET Core, startup tasks. |
| `orleans/clustering` | Membership providers, ClusterId and ServiceId, liveness options, gateways, the grain directory. |
| `orleans/placement` | Placement strategies and filters, grain migration, activation rebalancing, heterogeneous silos. |
| `orleans/persistence` | `IPersistentState<T>`, storage providers, etags, custom storage. |
| `orleans/timers-reminders` | Grain timers, persistent reminders, reminder tables. |
| `orleans/streams` | Stream providers, explicit and implicit subscriptions, sequence tokens. |
| `orleans/observers` | Push notifications to clients with `IGrainObserver` and `ObserverManager`. |
| `orleans/serialization` | The Orleans serializer, ids and aliases, immutability, surrogates, JSON integration. |
| `orleans/transactions` | ACID transactions across grains, `ITransactionalState<T>`, transaction options. |
| `orleans/testing` | `TestCluster`, in-memory providers, unit tests for grains. |
| `orleans/deployment` | Kubernetes and Docker, versioning and rolling upgrades, telemetry, shutdown, scaling. |
| `orleans/migration` | Moving from Orleans 3 to 7 and on to 8, 9 and 10; breaking changes. |
| `orleans/best-practices` | Sizing grains, async rules, fan-out, timeouts, idempotency, project layout. |

## Test

`npm test` runs `test/skills.test.js`: the manifest shape, the expected ids, every frontmatter field and limit of the skill format, the `## Sources` section, relative links, and a short deny-list for the style.

---
name: orleans
description: "Microsoft Orleans, the .NET framework for distributed virtual actors (grains) hosted in silos: what a grain and a silo are, the runtime guarantees, the NuGet packages, and an index of the child skills that cover grains, hosting, clustering, placement, persistence, timers and reminders, streams, observers, serialization, transactions, testing, deployment, migration and best practices. Use when you write, review or design any C# code that uses Orleans 7 to 10, or when you need to know which orleans/* skill to fetch for a detail."
metadata:
  title: Microsoft Orleans
  tags: [orleans, dotnet, csharp, actor, grain, silo, cluster, distributed, framework, index]
  related: [orleans/grains, orleans/hosting, orleans/clustering, orleans/placement, orleans/persistence, orleans/timers-reminders, orleans/streams, orleans/observers, orleans/serialization, orleans/transactions, orleans/testing, orleans/deployment, orleans/migration, orleans/best-practices]
  universal: "true"
  version: 1
---

# Microsoft Orleans

Orleans is a cross-platform .NET framework for building distributed applications from **grains**: virtual actors with an identity, behaviour and optional state. A grain is a class that implements a grain interface. The runtime activates it on demand in a **silo**, runs its calls one at a time, deactivates it when idle, and reactivates it anywhere in the cluster on the next call. A **client** talks to the cluster through a gateway. Silos find each other through a **membership** provider and form a **cluster**.

These skills document Orleans 10 on .NET 10 from https://learn.microsoft.com/en-us/dotnet/orleans/. They are framework documentation only. A project that uses Orleans has its own skills.

## Rules that always hold

- A grain interface extends `IGrainWithGuidKey`, `IGrainWithIntegerKey`, `IGrainWithStringKey` or a compound key interface, and every method returns `Task`, `Task<T>` or `ValueTask`.
- One activation runs one request at a time. `await` inside a grain yields the turn. Mark a grain `[Reentrant]` or a method `[AlwaysInterleave]` only on purpose.
- Every type that crosses a grain call or is stored as state carries `[GenerateSerializer]` and `[Id(n)]` on each member. Add `[Alias]` to types and interfaces you will rename.
- Packages: `Microsoft.Orleans.Sdk` for interfaces and grains, `Microsoft.Orleans.Server` for a silo, `Microsoft.Orleans.Client` for a client, plus one package per provider.
- Host a silo with `builder.UseOrleans(silo => ...)` on `Host.CreateApplicationBuilder`; host a client with `builder.UseOrleansClient(client => ...)`.

## Which skill to fetch

| Id | Fetch when |
|---|---|
| `orleans/grains` | Grain classes, interfaces, keys, lifecycle, reentrancy, one-way calls, stateless workers, call filters, RequestContext. |
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

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/overview?pivots=orleans-10-0

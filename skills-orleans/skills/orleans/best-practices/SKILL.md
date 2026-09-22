---
name: best-practices
description: "Orleans best practices: when Orleans fits, grain sizing, async everywhere, short calls, small immutable state, fan-out, stateless workers, reentrancy. Use when you design, review or optimize Orleans grains and clusters, or need the runtime's guarantees and non-guarantees."
metadata:
  title: Orleans best practices
  tags: [orleans, dotnet, csharp, best-practices, design, grains, async, reentrancy, deadlock, timeouts, retries, idempotency, serialization, immutable, stateless-worker, testing, testcluster, requestcontext, logging, guarantees, project-structure]
  related: [orleans, orleans/grains, orleans/placement, orleans/persistence, orleans/serialization, orleans/testing, orleans/timers-reminders, orleans/streams, orleans/deployment, orleans/migration]
  version: 1
---

# Orleans best practices

Orleans is a virtual actor framework: grains are single-threaded, distributed, always addressable objects with a stable identity, and the runtime places, activates, and collects them. The docs describe the design goal as "scalable by default" for the 80% case: scalability and availability come before raw performance, and problems are detected and fixed rather than assumed impossible. The rules below follow from that. They are written for Orleans 10 on .NET 10.

## When Orleans fits

Consider Orleans when:

- there are many loosely coupled entities (hundreds to billions), only a subset of which is active at any moment: users, sessions, orders, devices, accounts, stocks;
- each entity is small enough to be single-threaded;
- the workload is interactive (request-response, start/monitor/complete);
- more than one server is expected or may be required;
- global coordination is unnecessary, or happens between a few entities at a time.

Orleans is a poor fit when:

- memory must be shared between entities (each grain owns its state);
- there are a few large entities that should be multithreaded (a microservice may fit better);
- global coordination or global consistency is required;
- the work is long-running batch or SIMD processing (sometimes still workable).

You do not need hundreds of servers. The distributed-systems problems start at 2 or 3 servers, and the same code runs on 3 or 300. A single-process deployment is legitimate if you value isolation and safe concurrency.

## Grain sizing

- One entity, one grain. Map grains to natural domain entities (user, order, device).
- Throughput is better with many small grains than a few large ones. A grain can handle a few thousand trivial calls per second, but hundreds of requests per second on one grain is a warning sign; decompose it.
- An entity is too small when other grains talk to it constantly. Merge tightly interacting entities into one grain so they call each other in memory.
- Avoid bottleneck grains: single coordinators, registries, monitors. Use staged aggregation: hash or modulo reporting grains onto N intermediate aggregators that roll up to the central one.
- Keep state small. Azure Table storage caps a state cell at 64 KB; storage providers differ.
- Do not pin grains to silos with custom placement unless you know the state's locality. Restrictive placement hurts elasticity and recovery when silos restart.

## Async everywhere, never block

- Every grain method returns `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>`, or `IAsyncEnumerable<T>`.
- Never block a grain thread: no `.Result`, `.Wait()`, `Thread.Sleep`, locks, synchronous I/O, or spin-waiting on a condition. Blocking stalls the activation and the scheduler.
- Prefer `await`. `return Task.FromResult(value)` for a synchronous result; `return other.Foo()` to pass a task through.
- Orleans uses cooperative multitasking. A long call is not preempted; the runtime only warns about long-running turns (`orleans-scheduler-long-running-turns`). Return quickly and split long work into steps, timers, or reminders.
- Accept a `CancellationToken` as the last parameter of long operations and check it (`ThrowIfCancellationRequested`) at each step. Only one token per method.

Fan out with `Task.WhenAll`:

```csharp
public async Task<int> CountActive(IReadOnlyList<string> userIds)
{
    var tasks = new List<Task<bool>>(userIds.Count);
    foreach (var id in userIds)
    {
        tasks.Add(GrainFactory.GetGrain<IUserGrain>(id).IsActive());
    }
    var results = await Task.WhenAll(tasks);
    return results.Count(active => active);
}
```

## Messages and serialization

- Mark every type sent between grains or stored as state with `[GenerateSerializer]`, `[Id(n)]` on each member, and `[Alias("name")]`. Types without `[GenerateSerializer]` are not serialized.
- Orleans deep-copies arguments and results by default to prevent shared mutable state. Mark types or members that are never mutated after creation with `[Immutable]` to skip the copy. Records and read-only collections are natural candidates.
- Keep messages small and flat. Serialization cost counts twice on a chatty edge. Sometimes sending a pre-serialized `byte[]` beats deserializing twice.
- Follow the version rules: never change an id or a field type (except numeric widening), never insert a base class, never reorder record constructor parameters. See `orleans/serialization`.
- Foreign types need a surrogate plus `[RegisterConverter]`.
- Only simple values (strings, GUIDs, numbers) belong in `RequestContext`; large objects add serialization overhead to every hop.

## Avoid chatty grain graphs

- Message passing costs far more than a local call. Grains that exchange many small messages should be merged, or the data should be batched into one call.
- Hot-path stateless work (decryption, decompression, validation, routing, pre-aggregation) belongs in `[StatelessWorker]` grains. They run locally on the silo that received the request, scale to one activation per core per silo (or `[StatelessWorker(n)]`), and are never registered in the grain directory. Address them with one key such as `0` or `Guid.Empty`. Two calls may hit different activations, so do not keep per-request state in them.
- Stateless workers can hold a local cache of hot read-only data; there is no coordination between activations, so treat it as a cache with staleness.
- Activation repartitioning (`AddActivationRepartitioner()`, experimental) can move grains next to the grains they call when patterns are stable; it is not a substitute for a sane grain graph.

## Reentrancy and deadlocks

- Grains are non-reentrant by default: one request runs to completion before the next starts. This protects state but can deadlock on call cycles: A calls A, A calls B calls A, or A and B call each other at the same time. A deadlocked call fails with a timeout, not a hang.
- Options, from broad to narrow: `[Reentrant]` on the class (all requests interleave), `[AlwaysInterleave]` on an interface method, `[ReadOnly]` on an interface method (interleaves with other read-only calls), `[MayInterleave(nameof(Predicate))]` on the class, and `using var _ = RequestContext.AllowCallChainReentrancy();` at the call site (only callers further down that chain may re-enter, until disposed).
- Reentrant grains are still single-threaded, but state observed before an `await` may have changed after it. The classic bug: read `_value`, await, write `_value + 1`. Prefer non-reentrant grains for stateful logic and use targeted reentrancy for callbacks.
- Transactional grains must be `[Reentrant]`.
- Timer callbacks registered with `RegisterGrainTimer` do not interleave unless `Interleave = true`.

## Timeouts, retries, and idempotency

- Every grain call has a timeout (`SiloMessagingOptions.ResponseTimeout`, `ClientMessagingOptions.ResponseTimeout`). On expiry the awaited task throws `TimeoutException`. Orleans 7.2.2 added per-call timeouts.
- Delivery is at-most-once by default: Orleans does not retry. A timed-out call may or may not have executed. If you retry (Polly, or from the front end), the same call may run twice, so make grain methods idempotent or carry an operation id.
- Retrying forever gives at-least-once delivery because grains never stay dead; a failed grain reactivates on another silo.
- Common practice: retry end to end from the client or front end, with a bounded count, rather than inside grains.
- `SiloUnavailableException` means the target silo died or is shutting down. The grain reference is still valid; retry and Orleans routes to the new activation.
- After a silo failure there is a detection delay (about 15 s with 9.x defaults). Calls to grains on that silo fail until membership catches up.
- Orleans 10 changed `CancelRequestOnTimeout` to default `false`; set it to `true` if callees should be told about timeouts.

## Exceptions and error handling

- Exceptions thrown in a grain method propagate to the caller, across silos and to clients. Catch them where the application can act.
- Getting a grain reference never fails; only calls fail.
- Storage failures are not retried by built-in providers. Catch, retry, or re-read (`ReadStateAsync`) as needed. Except for the initial read, a failed storage operation does not destroy the activation.
- Recovery choices after a failed multi-grain operation: retry, reset state from storage, reset related grains, or use transactions or a process-manager grain. Design so partial completion is visible and repairable.
- Do not rely on `OnDeactivateAsync` for critical writes; a host can die at any time.
- `OrleansTransactionAbortedException` is retryable; other `OrleansTransactionException` results are unknown-state, so wait `SystemResponseTimeout` before checking.

## Persistence habits

- Use `IPersistentState<T>` injected with `[PersistentState("name", "storeName")]`, or `Grain<T>`. State is read before `OnActivateAsync`.
- Call `WriteStateAsync` at the end of a method that changed state and return that task. Alternatively batch writes on a timer when eventual consistency is acceptable.
- Re-read with `ReadStateAsync` (or on a timer) when external systems change the data.
- Memory storage is for tests only.
- Adding and removing state fields is provider-dependent; JSON stores tolerate it.

## RequestContext

`RequestContext.Set(key, value)` and `RequestContext.Get(key)` flow metadata (trace ids, tenant, caller identity) with each call down the chain. Values do not flow back with responses. Callbacks scheduled with `StartNew` or `ContinueWith` see a copy taken at scheduling time. It is async-local, so it is safe across `await`. Placement directors read it from `PlacementTarget.RequestContextData`.

## Logging and telemetry

- Inject `ILogger<MyGrain>` and use structured messages. Orleans logs go through `Microsoft.Extensions.Logging`.
- Subscribe to the `Microsoft.Orleans` meter and the `Microsoft.Orleans.Application` and `Microsoft.Orleans.Lifecycle` activity sources with OpenTelemetry; call `AddActivityPropagation()` on silos and clients.
- Watch `orleans-app-requests-latency`, `orleans-app-requests-timedout`, `orleans-catalog-activations`, `orleans-messaging-rejected`, and `orleans-gateway-load-shedding`.
- Grain call filters (`AddIncomingGrainCallFilter`, `AddOutgoingGrainCallFilter`) are the place for cross-cutting logging, authorization, and error mapping.
- The Orleans 10 dashboard (`AddDashboard()`, `MapOrleansDashboard()`) shows activations, method profiles, and reminders; protect it with authorization.

## Testing

- `Microsoft.Orleans.TestingHost` provides `InProcessTestCluster` (recommended in 9 and 10) and `TestCluster`.
- Share one cluster across tests with an xUnit collection fixture; starting a cluster is slow.

```csharp
public sealed class ClusterFixture : IAsyncLifetime
{
    public InProcessTestCluster Cluster { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        var builder = new InProcessTestClusterBuilder(initialSilosCount: 2);
        builder.ConfigureSilo((options, silo) => silo.AddMemoryGrainStorageAsDefault());
        builder.ConfigureHost(host => host.Services.AddSingleton<IClock, FakeClock>());
        Cluster = builder.Build();
        await Cluster.DeployAsync();
    }

    public Task DisposeAsync() => Cluster.DisposeAsync().AsTask();
}
```

- `TestCluster` uses `ISiloConfigurator` and `IClientConfigurator` classes and can run silos in separate processes.
- `StartSiloAsync`, `StopSiloAsync`, and `RestartAsync` exercise membership changes.
- Mocking a grain directly (Moq, `OrleansTestKit`) works for pure logic but skips scheduling, reentrancy, and serialization.

## Runtime guarantees and non-guarantees

Guaranteed:

- At most one activation of a normal grain in a healthy cluster; the default directory may allow a duplicate while membership is unstable. The strongly consistent directory or an external directory removes that window.
- Single-threaded execution per activation; requests to a non-reentrant grain run one at a time.
- A message is delivered at most once when nobody retries; never twice.
- Exceptions propagate to the caller.
- Failed grains reactivate on demand on another silo; reminders survive restarts.
- Membership never declares a live silo dead because the membership store is unreachable.

Not guaranteed:

- Ordering of messages between grains, even from one sender. `[Unordered]` never changed this and is obsolete in 10.
- Delivery when a call times out; it may or may not have run.
- Exactly-once with retries.
- Reminder ticks missed while the cluster was down; only the next tick fires.
- That timer callbacks keep an activation alive (set `KeepAlive = true`) or that `DelayDeactivation` pins a grain.
- That existing activations move when a silo joins; only new placements use it, unless a rebalancer is enabled.
- Preemption of a long-running grain call.
- That clients learn about grain types added to a heterogeneous cluster after they connected.

## Project structure

The samples use four projects:

- `MyApp.Abstractions` (or `GrainInterfaces`): grain interfaces and message types; references `Microsoft.Orleans.Sdk`.
- `MyApp.Grains`: grain classes and state types; references Abstractions and `Microsoft.Orleans.Sdk`.
- `MyApp.Silo`: the host; references Grains and `Microsoft.Orleans.Server` plus provider packages.
- `MyApp.Client` (web API, worker, or co-hosted in the silo): references Abstractions and `Microsoft.Orleans.Client`.

Interfaces and message types must be shared by silo and client, so keep them free of implementation dependencies. Grain classes belong only on the silos that host them. Clients in the same process as a silo can use the silo's `IGrainFactory` and `IClusterClient` directly; do not configure a client inside a silo host.

## Source generator constraints

- Code generation runs at build time only. Every project with grains, interfaces, or serializable types needs `Microsoft.Orleans.Sdk` (directly or via Client or Server).
- Grain interfaces must be `public` interfaces deriving from `IGrainWithGuidKey`, `IGrainWithIntegerKey`, `IGrainWithStringKey`, `IGrainWithGuidCompoundKey`, or `IGrainWithIntegerCompoundKey`. Methods must return `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>`, or `IAsyncEnumerable<T>`.
- Types in other assemblies or other languages get code through `[assembly: GenerateCodeForDeclaringAssembly(typeof(SomeType))]`.
- One `CancellationToken` per method (`ORLEANS0109`).
- Never change a grain interface method signature once deployed; add a method and `[Version(n)]` the interface instead. Even renaming parameters breaks old callers because arguments map by position.
- Mark constructors that need DI services with `[GeneratedActivatorConstructor]`; do not use it to steer serialization.
- Suppress experimental warnings (`ORLEANSEXP001`, `ORLEANSEXP002`) only for features you chose knowingly.

## Deployment habits worth repeating

- Use a durable clustering store in production; localhost and development clustering are for one box.
- Keep `ServiceId` stable across deployments.
- Configure server GC.
- Give the process enough shutdown time (`DOTNET_SHUTDOWNTIMEOUTSECONDS`, `terminationGracePeriodSeconds`).
- Use Azure Table membership for local troubleshooting: the `OrleansSiloInstances` table shows cluster state. Check ports 11111 and 30000 when a silo or client cannot connect.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/resources/best-practices?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/resources/frequently-asked-questions?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/resources/orleans-architecture-principles-and-approach?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/resources/orleans-thinking-big-and-small?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/overview?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/request-scheduling?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/stateless-worker-grains?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/request-context?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/cancellation-tokens?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/timers-and-reminders?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/transactions?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-placement?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/code-generation?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/serialization?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/activation-collection?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/local-development-configuration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/grain-directory?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/heterogeneous-silos?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/monitoring/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/messaging-delivery-guarantees?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/cluster-management?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/load-balancing?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/testing?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/handling-failures?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/troubleshooting-deployments?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/migration-guide?pivots=orleans-10-0

---
name: migration
description: "Migrating Orleans from 3.x through 7, 8, 9 and 10: package renames, the new builders, the version-tolerant serializer, POCO grains, stream and timer changes. Use when you upgrade Orleans across major versions or read old Orleans code."
metadata:
  title: Orleans migration
  tags: [orleans, dotnet, csharp, migration, upgrade, breaking-changes, serialization, generateserializer, hosting, timers, streams, adonet, orleans7, orleans8, orleans9, orleans10, release-notes]
  related: [orleans, orleans/grains, orleans/hosting, orleans/serialization, orleans/timers-reminders, orleans/streams, orleans/transactions, orleans/deployment, orleans/best-practices]
  version: 1
---

# Orleans migration

This skill covers moving an Orleans code base forward: 3.x to 7.0 (the big break), then 7 to 8, 8 to 9, and 9 to 10. Orleans 4.0, 5.0, and 6.0 never shipped as stable releases; the 4.0 previews became 7.0.

## Release timeline and .NET targets

| Orleans | Released | Targets | Headline |
| --- | --- | --- | --- |
| 3.x | legacy | .NET Standard 2.0 | `SiloHostBuilder`, `ClientBuilder`, application parts, old serializer. No longer supported. |
| 7.0 | 2022-11 | .NET 7 and later | `UseOrleans` and `UseOrleansClient`, source generators, version-tolerant serializer, string grain and stream ids, new wire protocol. 7.2 added `IAsyncEnumerable` grain methods and Cosmos DB providers; 7.2.2 per-call timeouts. |
| 8.0 | 2024-01 | .NET 8 | Aspire integration, `ResourceOptimizedPlacement`. 8.2 added `RegisterGrainTimer`, activation repartitioning (experimental), MessagePack serializer, Cassandra clustering. |
| 9.0 | 2024-11 | .NET 8 and .NET 9 | Full `CancellationToken` support, strong-consistency grain directory, memory-based activation shedding, faster membership, `InProcessTestCluster`, activation rebalancing stable. 9.2 changed the default placement to `ResourceOptimizedPlacement` and added an ADO.NET grain directory. |
| 10.0 | 2026-01 | .NET 8, .NET 9, .NET 10 | Built-in Orleans Dashboard (preview), stable Redis providers, NATS stream provider, durable jobs, cancellation for system targets and observers, `Microsoft.Data.SqlClient`. |

The migration guide treats 7, 8, and 9 as one lineage: read the "3.x to 7.0" section first, then the per-release notes below.

## Rolling upgrades across major versions

- 3.x to 7.0: not possible. The wire protocol changed. A cluster cannot mix 7.0 silos with older silos.
- 7.x to 10.0: not recommended because of protocol and API changes.
- Within one major family (8.x with 8.y): supported by the version-tolerant serializer.

Procedure for a major jump: deploy a new cluster on the new version (same `ServiceId`, new `ClusterId` if the stores are shared), migrate or verify state, switch traffic, decommission the old cluster. Reminders, streams, and grain persistence from 3.x do not migrate automatically because grain and stream identities changed.

## Step 1: packages (3.x to 7.0)

- Clients reference `Microsoft.Orleans.Client`.
- Silos reference `Microsoft.Orleans.Server`.
- Every other project (interfaces, grains, shared types) references `Microsoft.Orleans.Sdk`. Client and Server already include it.
- Remove `Microsoft.Orleans.CodeGenerator.MSBuild`, `Microsoft.Orleans.OrleansCodeGenerator.Build`, and `Microsoft.Orleans.OrleansRuntime`. The Sdk package brings the C# source generator `Microsoft.Orleans.CodeGenerator`; Server brings `Microsoft.Orleans.Runtime`.
- Replace `Microsoft.Orleans.OrleansServiceBus` with `Microsoft.Orleans.Streaming.EventHubs`.
- Add `Microsoft.Orleans.Reminders` if you use reminders and `Microsoft.Orleans.Streaming` if you use streams. Transactions live in `Microsoft.Orleans.Transactions`. The core no longer contains these features.
- Replace `[assembly: KnownAssembly(...)]` with `[assembly: GenerateCodeForDeclaringAssembly(typeof(SomeType))]` for assemblies (F#, VB, third-party) that need generated code.
- With `<ImplicitUsings>enable</ImplicitUsings>`, the Sdk adds global usings for `Orleans` and `Orleans.Hosting`.

## Step 2: hosting

`ISiloHostBuilder` and `SiloHostBuilder` are gone. `ClientBuilder` is gone. Configure both on the generic host:

```csharp
// Silo
var builder = Host.CreateApplicationBuilder(args);
builder.UseOrleans(siloBuilder =>
{
    siloBuilder.UseAzureStorageClustering(o => o.ConfigureTableServiceClient(connectionString));
    siloBuilder.Configure<ClusterOptions>(o => { o.ClusterId = "prod"; o.ServiceId = "MyService"; });
});
using var host = builder.Build();
await host.RunAsync();

// Client
var clientHost = Host.CreateApplicationBuilder(args);
clientHost.UseOrleansClient(clientBuilder =>
{
    clientBuilder.UseAzureStorageClustering(o => o.ConfigureTableServiceClient(connectionString));
});
```

- Remove every `ConfigureApplicationParts` call. Application parts no longer exist; the source generator emits the equivalent.
- The client connects during `IHost.StartAsync`. Register `UseOrleansClient` before `ConfigureWebHostDefaults` so Orleans starts before ASP.NET Core.
- A host is either a silo or a client, not both. A silo already registers `IGrainFactory` and `IClusterClient`; do not configure a client inside a silo.
- Old 3.x pattern of a standalone client: create a separate `HostBuilder` with `UseOrleansClient`.

## Step 3: grain lifecycle signatures

```csharp
public override Task OnActivateAsync(CancellationToken cancellationToken) => Task.CompletedTask;

public override Task OnDeactivateAsync(DeactivationReason reason, CancellationToken cancellationToken) => Task.CompletedTask;
```

`OnActivateAsync` gained a `CancellationToken`. `OnDeactivateAsync` gained a `DeactivationReason` and a token. Abandon activation if the token is cancelled; finish deactivation promptly. Do not put critical persistence in `OnDeactivateAsync`.

## Step 4: POCO grains and IGrainBase

Grains no longer have to inherit `Grain`. A class that implements `IGrainBase` (a `GrainContext` property injected through the constructor) is a grain. Extension methods such as `DeactivateOnIdle`, `AsReference`, `Cast`, `GetPrimaryKey`, `GetReminder`, `RegisterOrUpdateReminder`, `UnregisterReminder`, `GetStreamProvider`, and `RegisterGrainTimer` work on `IGrainBase`. `Grain` and `Grain<TState>` still work; `Grain<TState>` with `[StorageProvider]` still reads state before activation and exposes `State`, `ReadStateAsync`, `WriteStateAsync`, `ClearStateAsync`. New code prefers injected `IPersistentState<T>` with `[PersistentState("name", "store")]`.

Because reminders and streams moved to extension methods, unqualified calls inside a grain fail to compile. Write `this.GetReminders()`, `this.RegisterOrUpdateReminder(...)`, `this.GetStreamProvider(...)`.

## Step 5: serialization

Orleans 7 replaced the serializer with a version-tolerant one. Types are no longer serialized implicitly. Every type that crosses a grain call, goes into grain state, or goes into a stream must be marked:

```csharp
[GenerateSerializer, Alias("my-app.order")]
public sealed class Order
{
    [Id(0)] public string Id { get; set; } = "";
    [Id(1)] public long Amount { get; set; }
}

[GenerateSerializer]
public record Money(decimal Value, string Currency);   // primary constructor parameters get implicit ids
```

- Replace `[Serializable]` with `[GenerateSerializer]` plus `[Id(n)]` on each member. The Orleans analyzer offers a code fix that adds the `[Id]` attributes.
- Ids are scoped per inheritance level; a base class and a subclass may both use `[Id(0)]`. Start at 0 in every class.
- `[Alias("name")]` makes the type name stable across renames and moves. Generic aliases carry the arity: `[Alias("mytype`2")]`.
- Version rules: add or remove members freely; never change an id; never change a field type except numeric widening (narrowing throws on overflow; sign changes are invalid); never add, change, or remove a base class; do not turn a `record` into a `class` or back; do not reorder record primary constructor parameters.
- Foreign types: write a surrogate struct marked `[GenerateSerializer]` and a `[RegisterConverter]` class implementing `IConverter<TValue, TSurrogate>` (plus `IPopulator` if the type is a base class).
- Objects passed in grain calls are deep-copied by default. `[Immutable]` on a type or member skips the copy.
- External serializers: `Microsoft.Orleans.Serialization.SystemTextJson`, `.NewtonsoftJson`, `.Protobuf`, `.MessagePack` (8.2+), and MemoryPack (10.1+) can be registered with `siloBuilder.Services.AddSerializer(sb => sb.AddMessagePackSerializer(...))`.
- Grain storage serialization is a separate concern. Providers expose `IGrainStorageSerializer` on their options (`GrainStorageSerializer`), defaulting to `Newtonsoft.Json`. Existing 3.x JSON state is usually readable; existing binary state written by the old Orleans serializer is not.
- The new serializer gives up to 170% more end-to-end throughput.

## Step 6: grain identities and interface names

- A `GrainId` is now `type/key`, both strings. `IGrainWithStringKey` is the common case. Guid, long, and compound keys still work through the same string form.
- Interfaces are identified by a readable name, not a hash code.
- `[GrainType("name")]` on a grain class fixes the type part of the id. `[DefaultGrainType("name")]` on an interface picks the class `GetGrain<IMyGrain>` resolves to. `[GrainInterfaceType("name")]` fixes an interface name so the interface can be renamed later; pair it with `[Alias]` because interface identities are serialized.
- Because ids changed, reminders and persisted state keyed by 3.x ids do not line up with 7.0 ids without a data migration.

## Step 7: streams

- Streams are identified by `Orleans.Runtime.StreamId` with `Namespace`, `Key`, and `FullKey` (UTF-8 strings). Create with `StreamId.Create("namespace", "key")`. 3.x used a `Guid` plus a string namespace.
- `SimpleMessageStreams` (SMS) was removed. Use `BroadcastChannel` when only implicit subscriptions are needed: `builder.AddBroadcastChannel("name", o => o.FireAndForgetDelivery = false)`, `ChannelId.Create(ns, key)`, `provider.GetChannelWriter<T>(channelId)`, and `[ImplicitChannelSubscription]` on a grain that implements `IOnBroadcastChannelSubscribed`. Use `AddMemoryStreams<DefaultMemoryMessageBodySerializer>("name", o => o.ConfigurePartitioning(8))` when you need explicit subscriptions or the persistent stream interface. Do not change the partition count of memory streams during a rolling deployment.
- `[ImplicitStreamSubscription("namespace")]` is unchanged for persistent stream providers. It is not supported on heterogeneous silos.
- `IRemindable` and `ReceiveReminder(string name, TickStatus status)` are unchanged. Reminders need a configured reminder store (`UseAzureTableReminderService`, `UseAdoNetReminderService`, `UseRedisReminderService`, `UseCosmosReminderService`, `UseInMemoryReminderService` for development).

## Step 8: transactions

- Add `siloBuilder.UseTransactions()` and `clientBuilder.UseTransactions()`.
- `ITransactionClient` (7.0) lets a client or grain run a transaction without an intermediary grain: `await transactionClient.RunTransaction(TransactionOption.Create, () => Task.WhenAll(from.Withdraw(100), to.Deposit(100)))`.
- Per-method coordination replaced the old per-call check on every grain method, so non-transactional grains pay nothing.
- Transactional grains must be `[Reentrant]`. Failures surface as `OrleansTransactionException` (retry only `OrleansTransactionAbortedException`); wait `SiloMessagingOptions.SystemResponseTimeout` before checking an unknown-state transaction.

## Step 9: reentrancy and call chains

Grains are non-reentrant by default. Orleans 7 added call chain reentrancy: `using var _ = RequestContext.AllowCallChainReentrancy();` lets grains further down the chain call back into this grain for the duration of the scope; `RequestContext.SuppressCallChainReentrancy()` stops it. Both return a value that must be disposed. `[Reentrant]`, `[AlwaysInterleave]`, `[ReadOnly]`, and `[MayInterleave]` still exist.

## Step 10: telemetry

`Microsoft.Orleans.TelemetryConsumers.*` and `ITelemetryConsumer` were removed in 7.0. Orleans emits `System.Diagnostics.Metrics` on the meter `Microsoft.Orleans` and traces through `ActivitySource`. Subscribe with OpenTelemetry (`AddMeter("Microsoft.Orleans")`, `AddSource(Orleans.Diagnostics.ActivitySources.ApplicationGrainActivitySourceName)`) and call `AddActivityPropagation()` on silo and client builders. The 10.x line added an official dashboard; before 10 use the community `OrleansDashboard`.

## Step 11: ADO.NET

Apply the SQL migration scripts, in order, for your database from the Orleans repository: `src/AdoNet/Orleans.Clustering.AdoNet/Migrations`, `src/AdoNet/Orleans.Persistence.AdoNet/Migrations`, `src/AdoNet/Orleans.Reminders.AdoNet/Migrations`. Orleans 10 requires the `Microsoft.Data.SqlClient` package and invariant instead of `System.Data.SqlClient`:

```csharp
siloBuilder.UseAdoNetClustering(options =>
{
    options.ConnectionString = connectionString;
    options.Invariant = "Microsoft.Data.SqlClient";   // "System.Data.SqlClient" in 7.x to 9.x
});
```

## 7.x to 8.x

- Aspire integration: `builder.AddOrleans("cluster").WithClustering(redis)` in an AppHost, `builder.UseOrleans()` with no arguments in the silo.
- `ResourceOptimizedPlacement` became available (opt-in with `[ResourceOptimizedPlacement]` in 8.x).
- 8.2: `RegisterTimer` was obsoleted in favour of `RegisterGrainTimer`. Activation repartitioning shipped as experimental (`AddActivationRepartitioner()`, warning `ORLEANSEXP001`). MessagePack serializer and Cassandra clustering were added.

Timer migration:

```csharp
// Orleans 7.x
RegisterTimer(DoWork, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(10));

// Orleans 8.2 and later
_timer = this.RegisterGrainTimer(
    static (state, ct) => state.DoWorkAsync(ct),
    this,
    new GrainTimerCreationOptions
    {
        DueTime = TimeSpan.FromSeconds(1),
        Period = TimeSpan.FromSeconds(10),
        Interleave = true   // old RegisterTimer callbacks interleaved; the new default is false
    });
```

`RegisterGrainTimer` returns `IGrainTimer` (with `Change`), takes a typed state and a `CancellationToken` that is cancelled on dispose or deactivation, supports `KeepAlive` to stop idle collection, is subject to grain call filters, and appears in traces. Callbacks do not interleave unless `Interleave = true` or the grain is reentrant. The period counts from when the previous callback's task completes.

## 8.x to 9.x

- `CancellationToken` parameters in grain interface methods are supported end to end, including `IAsyncEnumerable<T>` methods with `[EnumeratorCancellation]`. Only one token per method (`ORLEANS0109` otherwise). Adding or removing a token parameter is wire-compatible. The legacy `GrainCancellationToken` and `GrainCancellationTokenSource` remain but are not recommended.
- Strong-consistency in-cluster grain directory (`AddDistributedGrainDirectory()`).
- Memory-based activation shedding via `GrainCollectionOptions.EnableActivationSheddingOnMemoryPressure`.
- Membership: each silo probes 10 others (was 3) and the overview quotes failure detection dropping from about 10 minutes to about 90 seconds in the worst case.
- `InProcessTestCluster` and `InProcessTestClusterBuilder` in `Microsoft.Orleans.TestingHost`; `TestCluster` still works.
- 9.2: default placement changed from `RandomPlacement` to `ResourceOptimizedPlacement`. Restore the old behaviour if you depend on it:

```csharp
siloBuilder.Services.AddSingleton<PlacementStrategy, RandomPlacement>();

[RandomPlacement]
public class MyGrain : Grain, IMyGrain { }
```

- 9.2 also added log-structured grain storage, an ADO.NET grain directory, and silo metadata with placement filtering.

## 9.x to 10.0

Breaking changes listed by the migration guide:

| Change | Effect | Fix |
| --- | --- | --- |
| `AddGrainCallFilter` on `IServiceCollection` removed | compile error | `siloBuilder.AddIncomingGrainCallFilter<T>()`; `AddOutgoingGrainCallFilter<T>()` on silo or client builder |
| `LeaseAquisitionPeriod` typo fixed | compile error | `LeaseBasedQueueBalancerOptions.LeaseAcquisitionPeriod` |
| `LoadSheddingOptions.LoadSheddingLimit` renamed | compile error | `LoadSheddingOptions.CpuThreshold` |
| `MessagingOptions.CancelRequestOnTimeout` default changed | behaviour | it is now `false`; set `true` on `SiloMessagingOptions` and `ClientMessagingOptions` to keep sending cancellation on timeout |
| ADO.NET requires `Microsoft.Data.SqlClient` | compile or runtime error | swap the package and the invariant |
| `[Unordered]` obsoleted | warning | remove it; ordering was never guaranteed |
| `OrleansConstructorAttribute` obsoleted | warning | `[GeneratedActivatorConstructor]` or `[ActivatorUtilitiesConstructor]`, only on constructors that take DI services |
| `RegisterTimer` obsoleted | warning | `RegisterGrainTimer` (see above) |

```csharp
// Orleans 10 call filters
siloBuilder.AddIncomingGrainCallFilter(async context =>
{
    // before
    await context.Invoke();
    // after
});
```

New in 10: `Microsoft.Orleans.Dashboard` (`AddDashboard()`, `MapOrleansDashboard()`), stable Redis clustering, persistence, and reminders, NATS streams, durable jobs, activation rebalancing (`AddActivationRebalancer()`, `ORLEANSEXP002`), cancellation for system targets and observers, a `BigInteger` codec. The 10.x point releases added a MemoryPack serializer, SQLite ADO.NET persistence, `IServiceLifecycle`, `System.Text.Json` grain storage serialization, and JSON type allow-lists on by default for JSON storage.

## Analyzers and diagnostics

The `Microsoft.Orleans.Sdk` package installs Roslyn analyzers and code fixes. Rely on them during migration:

- A code fix adds missing `[Id]` attributes to members of a `[GenerateSerializer]` type.
- `ORLEANS0109`: more than one `CancellationToken` parameter on a grain method.
- `ORLEANSEXP001` and `ORLEANSEXP002`: experimental features (repartitioner, rebalancer). Suppress with `#pragma warning disable` or `<NoWarn>`.
- Obsolete warnings point at `RegisterTimer`, `[Unordered]`, and `[OrleansConstructor]`.
- `Microsoft.Orleans.Analyzers` is included through the Sdk; there is no separate package to add.

## Migration checklist

1. Move all projects to a supported target framework (.NET 8, 9, or 10 for Orleans 10).
2. Swap packages: Client, Server, Sdk, Reminders, Streaming, Transactions, provider packages at the same version.
3. Delete `SiloHostBuilder`, `ClientBuilder`, and `ConfigureApplicationParts`; move to `UseOrleans` and `UseOrleansClient`.
4. Fix `OnActivateAsync` and `OnDeactivateAsync` overrides.
5. Mark every serialized type with `[GenerateSerializer]`, `[Id]`, and `[Alias]`; run the code fix; replace `[Serializable]`.
6. Qualify reminder and stream helpers with `this.`; replace SMS with `BroadcastChannel` or memory streams; convert stream ids to `StreamId`.
7. Replace `RegisterTimer` with `RegisterGrainTimer` and decide `Interleave` per timer.
8. Replace `AddGrainCallFilter` with `AddIncomingGrainCallFilter`; rename `LoadSheddingLimit` and `LeaseAquisitionPeriod`; review `CancelRequestOnTimeout`.
9. Switch ADO.NET to `Microsoft.Data.SqlClient` and run the migration scripts.
10. Replace telemetry consumers with OpenTelemetry; consider the dashboard.
11. Decide whether random placement must be restored.
12. Build with warnings as errors for `ORLEANS*` diagnostics, run the test cluster, then cut over to a new cluster rather than a rolling upgrade.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/migration-guide?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/overview?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/timers-and-reminders?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/cancellation-tokens?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-placement?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/code-generation?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/transactions?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/request-scheduling?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/serialization?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/typical-configurations?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/activation-collection?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/grain-directory?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/monitoring/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/dashboard/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/testing?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/cluster-management?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/troubleshooting-deployments?pivots=orleans-10-0
- https://github.com/dotnet/orleans/releases
- https://github.com/dotnet/orleans/releases/tag/v10.0.0
- https://github.com/dotnet/orleans/releases/tag/v9.0.0
- https://github.com/dotnet/orleans/releases/tag/v4.0.0-preview1

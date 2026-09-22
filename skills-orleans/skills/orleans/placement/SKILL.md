---
name: placement
description: "Orleans grain placement: the strategies and attributes, custom directors, placement filters and silo metadata, migration, repartitioning and rebalancing. Use when you decide where grains activate, balance load, pin grains to zones or roles, move activations, or plan a rolling upgrade."
metadata:
  title: Orleans placement
  tags: [orleans, dotnet, csharp, placement, placement-strategy, resource-optimized, random, prefer-local, hash-based, activation-count, silo-role, iplacementdirector, placement-filter, silo-metadata, migration, migrateonidle, immovable, repartitioning, rebalancing, load-balancing, heterogeneous-silos, versioning, version-attribute, rolling-upgrade, stateless-worker]
  related: [orleans, orleans/grains, orleans/hosting, orleans/clustering, orleans/deployment, orleans/best-practices]
  version: 1
---
# Orleans placement

## What placement is

When a call arrives for a grain that has no activation, the silo that received the call runs a *placement strategy* to choose a silo, then activates the grain there. Placement is one of the main load-balancing levers in Orleans: a good spread of busy grains keeps all silos working. Placement runs once per activation; after that the grain directory routes calls to the existing activation until it deactivates or migrates.

Placement is configurable globally and per grain class. Placement filters (Orleans 9 and later) narrow the candidate silos before the strategy picks one.

## Strategies

| Strategy | Attribute on the grain class | Behaviour |
|---|---|---|
| Resource-optimized (default since 9.2) | `[ResourceOptimizedPlacement]` | Scores each silo by CPU, memory, and activation count, with a smoothing filter, and picks the lowest score. Has a tunable preference for the local silo. Available since Orleans 8.1. |
| Random (default before 9.2) | `[RandomPlacement]` | Uniform random over compatible silos. Good for large numbers of small grains with unpredictable load. |
| Prefer local | `[PreferLocalPlacement]` | The calling silo if it can host the type, else random. |
| Hash-based | `[HashBasedPlacement]` | Hash of the grain id modulo the number of compatible silos, ordered by address. Not stable across membership changes; the directory hides that. |
| Activation-count-based | `[ActivationCountBasedPlacement]` | Power-of-two-choices over recently published activation counts. Picks the predicted least-loaded of two random silos (`ActivationCountBasedPlacementOptions.ChooseOutOf`). |
| Silo-role-based | `[SiloRoleBasedPlacement]` | Deterministic placement on silos with a given role. |
| Stateless worker | `[StatelessWorker]` | Like prefer-local, but many activations per silo and no directory entry. See `orleans/grains`. |

```csharp
[ActivationCountBasedPlacement]
public sealed class OrderGrain : Grain, IOrderGrain { }
```

### Resource-optimized placement options

```csharp
silo.Configure<ResourceOptimizedPlacementOptions>(options =>
{
    options.CpuUsageWeight = 40;            // default 40
    options.MemoryUsageWeight = 20;         // default 20
    options.AvailableMemoryWeight = 20;     // default 20
    options.MaxAvailableMemoryWeight = 5;   // default 5, favours silos with more physical memory
    options.ActivationCountWeight = 15;     // default 15
    options.LocalSiloPreferenceMargin = 5;  // default 5; 0 = always lowest score, 100 = always local
});
```

Weights are relative; they do not need to sum to 100. Recommended `LocalSiloPreferenceMargin` is 5 to 10.

### Change the default strategy

The default applies to every grain class without a placement attribute.

```csharp
// Orleans 9.2 and later: revert to random
silo.Services.AddSingleton<PlacementStrategy, RandomPlacement>();

// Any version: your own default
silo.Services.AddSingleton<PlacementStrategy, MyPlacementStrategy>();
```

### Choosing

Random needs many grains (10,000 or more) for the law of large numbers to hold. Activation-count and resource-optimized react to actual load and suit clusters that scale in and out; new silos fill up sooner. Prefer-local removes network hops when the caller is a good host. Measure with your workload; the docs are explicit that no single answer fits every application.

## Custom placement

Three pieces: a strategy (marker), an attribute (applies the strategy to a class), and a director (the decision).

```csharp
[Serializable]
public sealed class FixedSiloPlacement : PlacementStrategy { }

[AttributeUsage(AttributeTargets.Class, AllowMultiple = false)]
public sealed class FixedSiloPlacementAttribute() : PlacementAttribute(new FixedSiloPlacement());

public sealed class FixedSiloPlacementDirector : IPlacementDirector
{
    public Task<SiloAddress> OnAddActivation(PlacementStrategy strategy, PlacementTarget target, IPlacementContext context)
    {
        var silos = context.GetCompatibleSilos(target).OrderBy(s => s).ToArray();
        var index = (int)(GetHash(target.GrainIdentity) % (uint)silos.Length);
        return Task.FromResult(silos[index]);
    }
}

silo.Services.AddPlacementDirector<FixedSiloPlacement, FixedSiloPlacementDirector>();

[FixedSiloPlacement]
public sealed class MyGrain : Grain, IMyGrain { }
```

`PlacementTarget` carries the grain identity, the interface, and `RequestContextData`. The static `RequestContext` is empty during placement because there is no activation yet; read `target.RequestContextData` instead. `PreferLocalPlacementDirector` in the Orleans repository is a short second example.

### Placement hint

A caller can name a target silo for the next activation of a grain:

```csharp
RequestContext.Set(IPlacementDirector.PlacementHintKey, targetSilo); // SiloAddress
```

The built-in directors honour the hint when the silo is compatible. Migration uses the same key.

## Placement filters (Orleans 9 and later)

A filter runs after the compatible silos are found and before the strategy chooses. Several filters on one class need an explicit, unique `order`.

### Silo metadata

Filters compare metadata of the *calling* silo with each candidate. Configure metadata first:

```csharp
silo.UseSiloMetadata();                                          // reads Orleans:Metadata from configuration
silo.UseSiloMetadata(configuration.GetSection("Orleans:Metadata"));
silo.UseSiloMetadata(new Dictionary<string, string>
{
    ["zone"] = "us-east-1a",
    ["tier"] = "premium",
});
```

Environment variables work as `ORLEANS__METADATA__zone=us-east-1a`. Code values override configuration values. Metadata is immutable for the life of a silo and cached cluster-wide; read it with `ISiloMetadataCache.GetSiloMetadata(siloAddress)`.

```csharp
// Only silos whose "zone" equals the caller's zone. No match: placement fails.
[RequiredMatchSiloMetadataPlacementFilter(new[] { "zone" })]
public sealed class ZoneBoundGrain : Grain, IZoneBoundGrain { }

// Prefer "zone" and "rack" matches; drop keys from the front until at least minCandidates remain; else all.
[PreferredMatchSiloMetadataPlacementFilter(new[] { "zone", "rack" }, minCandidates: 2)]
public sealed class LocalityGrain : Grain, ILocalityGrain { }
```

`minCandidates` (default 2) stops the filter from funnelling every activation onto one silo that happens to match best. Set it to 1 only when moving to a weaker match is expensive and throughput is low.

### Custom filter

```csharp
[AttributeUsage(AttributeTargets.Class, AllowMultiple = false)]
public sealed class PreferLocalFilterAttribute(int order)
    : PlacementFilterAttribute(new PreferLocalFilterStrategy(order));

public sealed class PreferLocalFilterStrategy(int order) : PlacementFilterStrategy(order)
{
    public PreferLocalFilterStrategy() : this(0) { }
}

internal sealed class PreferLocalFilterDirector(ILocalSiloDetails local) : IPlacementFilterDirector
{
    public IEnumerable<SiloAddress> Filter(PlacementFilterStrategy strategy, PlacementTarget target, IEnumerable<SiloAddress> silos)
    {
        var list = silos.ToList();
        var mine = list.FirstOrDefault(s => s == local.SiloAddress);
        return mine is null ? list : [mine];
    }
}

silo.Services.AddPlacementFilter<PreferLocalFilterStrategy, PreferLocalFilterDirector>();

[PreferLocalFilter(order: 1)]
[ActivationCountBasedPlacement]
public sealed class MyGrain : Grain, IMyGrain { }
```

This is the documented way to get prefer-local behaviour with any strategy as the fallback instead of random.

## Grain migration (Orleans 8 and later)

An activation can move to another silo without losing in-memory state. The runtime dehydrates state on the source, transfers it, and rehydrates it on the target before `OnActivateAsync` runs there.

- `Grain<TState>` and `IPersistentState<T>` state migrates automatically.
- Other in-memory fields migrate if the grain implements `IGrainMigrationParticipant`:

```csharp
public sealed class SessionGrain : Grain, ISessionGrain, IGrainMigrationParticipant
{
    private int _cached;
    private string? _session;

    public void OnDehydrate(IDehydrationContext context)
    {
        context.TryAddValue("cached", _cached);
        context.TryAddValue("session", _session);
    }

    public void OnRehydrate(IRehydrationContext context)
    {
        context.TryGetValue("cached", out _cached);
        context.TryGetValue("session", out _session);
    }
}
```

Trigger a move from inside the grain:

```csharp
this.MigrateOnIdle();                                           // any silo the placement strategy picks
RequestContext.Set(IPlacementDirector.PlacementHintKey, silo);  // prefer a silo
this.MigrateOnIdle();
```

The move happens once the current request finishes and the activation is idle.

`[Immovable]` blocks automatic moves by the repartitioner and rebalancer; `[Immovable(ImmovableKind.Repartitioner)]` or `ImmovableKind.Rebalancer` blocks one of them. `MigrateOnIdle()` still works on an `[Immovable]` grain. Client grains, system targets, grain services, and stateless workers cannot migrate.

## Activation repartitioning (Orleans 8.2 and later, experimental)

The repartitioner watches which grains call which and migrates activations next to their most frequent partners while keeping counts balanced. It tracks the heaviest edges in a probabilistic structure and runs rounds at random intervals.

```csharp
#pragma warning disable ORLEANSEXP001
silo.AddActivationRepartitioner();
silo.Configure<ActivationRepartitionerOptions>(options =>
{
    options.MaxEdgeCount = 10_000;                      // edges tracked; more = accuracy and memory
    options.MinRoundPeriod = TimeSpan.FromMinutes(1);
    options.MaxRoundPeriod = TimeSpan.FromMinutes(2);   // aim for ~10 s times the max silo count
    options.RecoveryPeriod = TimeSpan.FromMinutes(1);   // must be <= MinRoundPeriod
    options.AnchoringFilterEnabled = true;              // skip grains already well placed
});
#pragma warning restore ORLEANSEXP001
```

Use it when call patterns are stable and cross-silo latency matters. Skip it on two or three silos, or when grains churn or call random partners.

## Activation rebalancing (Orleans 10, experimental)

The rebalancer is a cluster-wide singleton grain that equalizes memory use and activation counts. Silos report statistics, it computes an entropy score, and heavy silos migrate activations to light ones in sessions of cycles until the score stops improving.

```csharp
#pragma warning disable ORLEANSEXP002
silo.AddActivationRebalancer();
silo.Configure<ActivationRebalancerOptions>(options =>
{
    options.RebalancerDueTime = TimeSpan.FromSeconds(60);   // delay after the cluster stabilizes
    options.SessionCyclePeriod = TimeSpan.FromSeconds(15);  // at least twice the statistics interval
    options.MaxStagnantCycles = 3;
    options.ActivationMigrationCountLimit = int.MaxValue;   // throttle per cycle
});
#pragma warning restore ORLEANSEXP002
```

Needs at least two silos and non-zero memory statistics from every silo. Both features may run together; the repartitioner reads the rebalancer's imbalance report and adjusts its tolerance.

| | Rebalancing (`ORLEANSEXP002`) | Repartitioning (`ORLEANSEXP001`) |
|---|---|---|
| Optimizes | memory and activation count balance | call locality |
| Scope | cluster-wide singleton | pairwise silos |
| Trigger | resource imbalance | communication patterns |

## Heterogeneous silos

Silos in one cluster may host different sets of grain classes. All silos and clients must reference all grain *interfaces*; only the hosting silos reference the grain *classes*. Placement only considers silos that can host the type ("compatible silos"), which is what `SiloRoleBasedPlacement` and metadata filters build on.

- No configuration is needed. Deploy different binaries.
- A grain type's implementation must be identical on every silo that hosts it.
- `TypeManagementOptions.TypeMapRefreshInterval` sets how often silos and clients refresh the supported-type map.
- `GrainClassOptions.ExcludedGrainTypes` excludes classes on a silo, mainly for tests.

Limitations: connected clients are not told when the set changes (calls to a type whose last silo left fail with `OrleansException`; a client that connected before the only host joined fails with `ArgumentException`). Stateless workers must exist on every silo. Implicit stream subscriptions are not supported; use explicit subscriptions.

## Grain interface versioning basics

Silos in one cluster may run different versions of a grain interface, so a rolling upgrade keeps working.

```csharp
[Version(2)]
public interface IOrderGrain : IGrainWithStringKey
{
    Task Place(Order order);         // unchanged from version 1
    Task Cancel(string reason);      // added in version 2
}
```

- No attribute means version 0.
- Default compatibility is *backward compatible*: version n can serve calls from version m < n if the interface name is unchanged and every method of m still exists with the same signature. Never change an existing method's signature or parameter order; the serializer matches by position. Remove methods in two steps (`[Obsolete]` first).
- *Fully compatible* means no methods were added, so both directions work.
- When a call needs a new activation and several compatible versions exist, `GrainVersioningOptions.DefaultVersionSelectorStrategy` picks: `AllCompatibleVersions` (random, default), `LatestVersion`, or `MinimumVersion`. An existing incompatible activation is deactivated and recreated on a compatible silo.
- Stateless workers and streaming interfaces are not versioned.

```csharp
silo.Configure<GrainVersioningOptions>(options =>
{
    options.DefaultCompatibilityStrategy = nameof(BackwardCompatible);
    options.DefaultVersionSelectorStrategy = nameof(AllCompatibleVersions); // rolling upgrade
    // nameof(MinimumVersion) for a staging slot that must not create new-version activations yet
});
```

The rollout procedures (rolling upgrade versus a staging slot in the same cluster) are in `orleans/deployment`.

## Checklist

- Leave the default strategy unless measurements say otherwise. On Orleans 9.2 and later that is resource-optimized; on 7 to 9.1 it is random.
- One placement attribute per class. Filters compose; strategies do not.
- Read placement inputs from `PlacementTarget.RequestContextData`, not `RequestContext`.
- Wrap `AddActivationRepartitioner` and `AddActivationRebalancer` in the `ORLEANSEXP001` / `ORLEANSEXP002` pragmas or `<NoWarn>`.
- Mark grains with process-bound state `[Immovable]` if you enable automatic migration.
- Bump `[Version]` and keep old method signatures when you change a grain interface in a live cluster.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-placement?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-placement-filtering?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-lifecycle?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/request-context?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/silo-metadata?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/heterogeneous-silos?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/load-balancing?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/grain-versioning?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/backward-compatibility-guidelines?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/compatible-grains?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/version-selector-strategy?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/deploying-new-versions-of-grains?pivots=orleans-10-0

---
name: grains
description: "Orleans grains: interfaces and keys, Grain against IGrainBase, the lifecycle, the single-threaded turn, reentrancy, one-way calls, timeouts, cancellation. Use when you write or review a grain, choose a key type, debug a deadlock or timeout, or need the exact attribute or API name."
metadata:
  title: Orleans grains
  tags: [orleans, dotnet, csharp, grains, virtual-actor, actors, grain-interface, grain-identity, grain-reference, lifecycle, activation, deactivation, reentrancy, interleave, readonly, oneway, response-timeout, request-context, cancellation, call-filters, interceptors, grain-extensions, stateless-worker, igrainbase, alias, generateserializer]
  related: [orleans, orleans/hosting, orleans/placement, orleans/persistence, orleans/timers-reminders, orleans/serialization, orleans/observers, orleans/testing, orleans/best-practices]
  version: 1
---
# Orleans grains

## What a grain is

A grain is the unit of computation and state in Orleans. It is a virtual actor:

- A grain always exists, logically. You never create or delete it. You get a reference by identity and call it.
- The runtime creates an in-memory *activation* on some silo when a call arrives. It removes the activation when the grain is idle. Your code does not manage this.
- At most one activation of a grain exists in the cluster at a time (the grain directory enforces this, with rare duplicates during instability). Stateless workers are the exception.
- Each activation runs single-threaded. Requests are processed one at a time unless you opt into interleaving.
- A grain reference is location-independent. It stays valid across activations, silo moves, and full restarts.

Grain interfaces and grain classes live in class libraries that reference the `Microsoft.Orleans.Sdk` NuGet package. Silo hosts reference `Microsoft.Orleans.Server`; external clients reference `Microsoft.Orleans.Client` (see `orleans/hosting`).

## Grain interfaces

A grain interface extends one of the key marker interfaces. Every method must return `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>`, or `IAsyncEnumerable<T>`.

```csharp
[Alias("IPlayerGrain")]
public interface IPlayerGrain : IGrainWithGuidKey
{
    [Alias("GetCurrentGame")]
    Task<IGameGrain?> GetCurrentGame(CancellationToken cancellationToken = default);

    [Alias("JoinGame")]
    Task JoinGame(IGameGrain game, CancellationToken cancellationToken = default);

    [ResponseTimeout("00:00:05")]
    Task LeaveGame(IGameGrain game, CancellationToken cancellationToken = default);
}
```

Key marker interfaces:

| Interface | Key type | `GetGrain` argument |
|---|---|---|
| `IGrainWithGuidKey` | `Guid` | `GetGrain<T>(Guid)` |
| `IGrainWithIntegerKey` | `long` | `GetGrain<T>(long)` |
| `IGrainWithStringKey` | `string` | `GetGrain<T>(string)` |
| `IGrainWithGuidCompoundKey` | `Guid` + `string` | `GetGrain<T>(Guid, string)` |
| `IGrainWithIntegerCompoundKey` | `long` + `string` | `GetGrain<T>(long, string)` |

`[Alias]` gives a type or method a stable serialized name. Put it on grain interfaces, grain methods, and message types so you can rename them later without breaking wire or storage compatibility. Aliases are globally scoped and must be unique. For generic types include the arity: `[Alias("mytype`2")]`.

Message and state types must be marked for the Orleans serializer:

```csharp
[GenerateSerializer, Alias("PlayerState")]
public sealed class PlayerState
{
    [Id(0)] public string? DisplayName { get; set; }
    [Id(1)] public List<Guid> Games { get; set; } = [];
}
```

Records get implicit ids for primary-constructor parameters. See `orleans/serialization` for the rules.

## Grain identity and keys

A grain identity is `type/key`, both strings, for example `shoppingcart/bob65`.

- The type name comes from the class name: strip a trailing `Grain`, lower-case the rest. `ShoppingCartGrain` becomes `shoppingcart`. Override it with `[GrainType("cart")]` on the class. Generic classes include arity: `[GrainType("dict`2")]`.
- The key is chosen by the caller. Guid, long, string, and the two compound forms are all encoded as strings, so they are interchangeable in storage.
- Use a fixed key such as `"default"` or `0` for a singleton grain. This is a convention, not a runtime feature.
- Use printable characters only (letters, digits, `-`, `_`, `@`, `=`) in type names and keys.

Read the key inside the grain:

```csharp
Guid guid = this.GetPrimaryKey();
long id = this.GetPrimaryKeyLong();
string s = this.GetPrimaryKeyString();
long id2 = this.GetPrimaryKeyLong(out string keyExtension); // compound key
GrainId full = this.GetGrainId();
```

`GrainId.Create("up-counter", "my-counter")` builds an identity directly. Pass it to `GetGrain<T>(GrainId)` to skip interface-to-type resolution.

Since Orleans 7 identities are plain strings; the older numeric type codes and categories are gone.

## Grain classes: `Grain` versus `IGrainBase`

Inherit from `Grain` for the common case. It gives you `GrainFactory`, `GrainContext`, `OnActivateAsync`, `OnDeactivateAsync`, `DeactivateOnIdle()`, `DelayDeactivation()`, `RegisterGrainTimer`, and the `this.GetPrimaryKey*()` extension methods.

```csharp
public sealed class PlayerGrain(ILogger<PlayerGrain> logger) : Grain, IPlayerGrain
{
    private IGameGrain? _currentGame;

    public Task<IGameGrain?> GetCurrentGame(CancellationToken ct = default)
        => Task.FromResult(_currentGame);

    public Task JoinGame(IGameGrain game, CancellationToken ct = default)
    {
        _currentGame = game;
        logger.LogInformation("Player {Id} joined {Game}", this.GetPrimaryKey(), game.GetPrimaryKey());
        return Task.CompletedTask;
    }

    public Task LeaveGame(IGameGrain game, CancellationToken ct = default)
    {
        _currentGame = null;
        return Task.CompletedTask;
    }
}
```

Since Orleans 7 a grain does not have to inherit from `Grain`. A POCO grain implements `IGrainBase` and takes `IGrainContext` in its constructor. The extension methods (`GetPrimaryKey`, `DeactivateOnIdle`, `AsReference`, reminders, streams) work on any `IGrainBase`.

```csharp
public sealed class PingGrain(IGrainContext context) : IGrainBase, IPingGrain
{
    public IGrainContext GrainContext { get; } = context;

    public Task OnActivateAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task OnDeactivateAsync(DeactivationReason reason, CancellationToken cancellationToken) => Task.CompletedTask;

    public ValueTask Ping() => ValueTask.CompletedTask;
}
```

Grain classes are resolved through dependency injection. Constructor-inject `ILogger<T>`, `IGrainFactory`, `IPersistentState<T>` (see `orleans/persistence`), and your own services.

## Grain references

A grain reference is a generated proxy that implements the grain interface and carries the grain type, key, and interface. Get one from `IGrainFactory` (inside a silo, also the `GrainFactory` property on `Grain`) or from `IClusterClient` on a client. Both expose the same `GetGrain` methods.

```csharp
IPlayerGrain player = GrainFactory.GetGrain<IPlayerGrain>(playerId);     // in a grain
IPlayerGrain player2 = clusterClient.GetGrain<IPlayerGrain>(playerId);  // in a client
```

- References are cheap and local to create. Creating one never contacts the cluster.
- Store references in grain state, pass them as arguments, return them from methods. They serialize.
- `this.AsReference<IPlayerGrain>()` gets a reference to the current grain, for example to pass yourself to another grain.
- Calls go through the reference. Await the returned task. Exceptions from the grain propagate to the caller across silos. An exception type unknown on the caller arrives as `UnavailableExceptionFallbackException` with the original message and stack.
- An exception does not deactivate the grain, except `InconsistentStateException` from storage.

When several classes implement one interface, `GetGrain<ICounterGrain>(key)` throws `ArgumentException` ("Unable to identify a single appropriate grain type"). Resolve it with one of:

- Distinct marker interfaces per implementation (`IUpCounterGrain : ICounterGrain`).
- `GetGrain<ICounterGrain>(key, grainClassNamePrefix: "Up")`.
- `[DefaultGrainType("up-counter")]` on the interface with `[GrainType("up-counter")]` on the class.
- The naming convention: `ICounterGrain` picks `CounterGrain` if it exists.
- `GetGrain<ICounterGrain>(GrainId.Create("up-counter", key))`.

## Lifecycle

Activation runs an observable lifecycle with these stages:

```csharp
public static class GrainLifecycleStage
{
    public const int First = int.MinValue;
    public const int SetupState = 1_000; // persistent state is loaded here
    public const int Activate = 2_000;   // OnActivateAsync / OnDeactivateAsync
    public const int Last = int.MaxValue;
}
```

Override the hooks on `Grain` (signatures since Orleans 7):

```csharp
public override Task OnActivateAsync(CancellationToken cancellationToken)
{
    // Runs once per activation, after state is loaded. An exception here fails the activation.
    return base.OnActivateAsync(cancellationToken);
}

public override Task OnDeactivateAsync(DeactivationReason reason, CancellationToken cancellationToken)
{
    // Best effort only. Not called on silo crash. Do not put critical writes here.
    return base.OnDeactivateAsync(reason, cancellationToken);
}
```

Subscribe other code to a stage by overriding `Participate(IGrainLifecycle lifecycle)` and calling `lifecycle.Subscribe(name, stage, onStart, onStop)`. Injected components can also participate through `IGrainContext.ObservableLifecycle`.

### Activation collection (idle deactivation)

The silo scans for idle activations and deactivates them after the collection age. The default is 15 minutes (Orleans 7 and later; it was 2 hours in 3.x). Only incoming calls, reminders, and stream events count as activity. Outgoing calls and timer ticks do not.

```csharp
siloBuilder.Configure<GrainCollectionOptions>(options =>
{
    options.CollectionAge = TimeSpan.FromMinutes(10);
    options.ClassSpecificCollectionAge[typeof(PlayerGrain).FullName!] = TimeSpan.FromMinutes(5);
});
```

Per-activation control:

- `DeactivateOnIdle()`: deactivate as soon as the current request finishes. Queued requests go to the next activation. Overrides everything else.
- `DelayDeactivation(TimeSpan)`: keep the activation at least this long. A negative value cancels a previous delay. This is an optimization, not a pin; failures can still deactivate the grain.
- `[KeepAlive]` on the class: the idle collector never collects this grain type.
- Orleans 9 and 10 add memory-based activation shedding. Set `GrainCollectionOptions.EnableActivationSheddingOnMemoryPressure = true` with `MemoryUsageLimitPercentage` (default 80) and `MemoryUsageTargetPercentage` (default 75). Least recently used activations go first, even `[KeepAlive]` ones under severe pressure.

Grains can also migrate between silos while keeping in-memory state (`MigrateOnIdle()`, `IGrainMigrationParticipant`). See `orleans/placement`.

## Execution model: single-threaded, turn-based

Each activation has its own `TaskScheduler`. Every `await` splits a request into turns; the scheduler runs one turn at a time and never runs two turns in parallel, although it can use a different thread pool thread each time. Grain code never needs locks for its own fields.

By default requests do not interleave: a request runs from start to finish, including its awaits, before the next request begins. This is safe, and it can deadlock. If grain A awaits a call to B while B awaits a call to A, both wait until the call times out (default 30 seconds) and `TimeoutException` is thrown.

Options to allow interleaving:

| Option | Where | Effect |
|---|---|---|
| `[Reentrant]` | grain class | Any request may interleave with any other at await points. |
| `[AlwaysInterleave]` | interface method | This method always interleaves with everything, and everything may interleave with it. |
| `[ReadOnly]` | interface method | Marks a method that does not change state. It runs concurrently with other `[ReadOnly]` requests. |
| `[MayInterleave(nameof(Predicate))]` | grain class | A static `bool Predicate(IInvokable request)` decides per call. |
| `RequestContext.AllowCallChainReentrancy()` | call site | Callees further down this call chain may call back into this grain until the returned scope is disposed. |

```csharp
public interface ISlowpokeGrain : IGrainWithIntegerKey
{
    Task GoSlow();
    [AlwaysInterleave] Task GoFast();
    [ReadOnly] Task<int> GetCount();
}

public sealed class UserGrain : Grain, IUserGrain
{
    public async ValueTask JoinRoom(string roomName)
    {
        using var scope = RequestContext.AllowCallChainReentrancy(); // room may call back into us
        var room = GrainFactory.GetGrain<IChatRoomGrain>(roomName);
        await room.OnJoinRoom(this.AsReference<IUserGrain>());
    }
}
```

Reentrant code is still single-threaded, but different requests' turns interleave. Guard multi-step invariants across awaits yourself. Prefer non-reentrant grains unless you have a measured need or a call cycle to break.

## One-way calls and response timeouts

`[OneWay]` on an interface method returning `Task` or `ValueTask` (not the generic forms) makes the call return immediately. No completion, no exception, no delivery guarantee. Use it only where the saved response message matters.

`[ResponseTimeout("00:00:05")]` or `[ResponseTimeout(0, 2, 0)]` on an interface method sets a per-method timeout. The attribute must be on the interface, since both caller and callee need it. The global default is 30 seconds, set through `SiloMessagingOptions.ResponseTimeout` on silos and `ClientMessagingOptions.ResponseTimeout` on clients.

## Cancellation tokens

Since Orleans 9, grain methods take a plain `System.Threading.CancellationToken`. Make it the last parameter with a default. Only one token per method is allowed (`ORLEANS0109` build error otherwise).

- The runtime checks the token before sending. A canceled token throws `OperationCanceledException` without a request.
- While the call runs, cancellation propagates to the remote silo. Cancellation is cooperative: the grain must observe the token. After the call completes, later cancellation is not propagated.
- Callbacks registered on the token inside a grain run on the grain's scheduler, so they may touch grain state.
- `IAsyncEnumerable<T>` grain methods take `[EnumeratorCancellation] CancellationToken` and stop at the next yield.
- Adding or removing a token parameter is wire-compatible with older callers; a missing token arrives as `CancellationToken.None`.
- `SiloMessagingOptions.CancelRequestOnTimeout` (default `true`) sends a cancel when a request times out. `WaitForCancellationAcknowledgement` (default `false`) waits for the callee to acknowledge.
- `GrainCancellationToken` and `GrainCancellationTokenSource` are the legacy mechanism. Do not use them in new code.

## RequestContext

`RequestContext` is async-local metadata that flows with every outgoing call from client to grain and grain to grain. It does not flow back with responses.

```csharp
RequestContext.Set("TraceId", traceId);           // caller
var traceId = RequestContext.Get("TraceId") as string; // inside the grain
```

Keep values small and simple (strings, Guids, numbers). Values must be serializable. Placement directors and filters read it through `PlacementTarget.RequestContextData`, since no activation exists yet at placement time.

## Grain call filters

Filters intercept calls for logging, authorization, error translation, or result rewriting. They are async and can read `InterfaceMethod`, `ImplementationMethod`, `Arguments`, and `RequestContext`, and set `Result` after `await context.Invoke()`.

```csharp
public sealed class LoggingCallFilter(ILogger<LoggingCallFilter> logger) : IIncomingGrainCallFilter
{
    public async Task Invoke(IIncomingGrainCallContext context)
    {
        try
        {
            await context.Invoke(); // runs the next filter, then the grain method
            logger.LogInformation("{Grain}.{Method} returned {Result}",
                context.Grain.GetType(), context.InterfaceMethod.Name, context.Result);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "{Grain}.{Method} failed", context.Grain.GetType(), context.InterfaceMethod.Name);
            throw; // swallowing the exception marks it handled
        }
    }
}

siloBuilder.AddIncomingGrainCallFilter<LoggingCallFilter>();
siloBuilder.AddIncomingGrainCallFilter(async ctx => { await ctx.Invoke(); }); // delegate form
siloBuilder.AddOutgoingGrainCallFilter<OutgoingLoggingCallFilter>();          // also on IClientBuilder
```

Order: DI-registered incoming filters in registration order, then the grain itself if it implements `IIncomingGrainCallFilter`, then the method. Incoming filters also see calls to grain extensions (streams, cancellation), so `ImplementationMethod` is not always on your class. Outgoing filters run on the caller, silo or client, and see system calls too.

## Grain extensions

A grain extension adds methods to a grain without changing its interface. Define an interface that extends `IGrainExtension`, implement it (the implementation can take `IGrainContext` from DI), register it, and call it through `AsReference<TExtension>()` on any grain reference.

```csharp
public interface IGrainDeactivateExtension : IGrainExtension
{
    Task Deactivate(string reason);
}

public sealed class GrainDeactivateExtension(IGrainContext context) : IGrainDeactivateExtension
{
    public Task Deactivate(string reason)
    {
        context.Deactivate(new DeactivationReason(DeactivationReasonCode.ApplicationRequested, reason));
        return Task.CompletedTask;
    }
}

siloBuilder.AddGrainExtension<IGrainDeactivateExtension, GrainDeactivateExtension>();

await grainRef.AsReference<IGrainDeactivateExtension>().Deactivate("operator request");
```

A grain can also install an extension on itself in `OnActivateAsync` with `GrainContext.SetComponent<TExtension>(instance)`. Orleans uses extensions internally for streams and cancellation.

## Stateless worker grains

`[StatelessWorker]` on a grain class changes the activation rules:

- Many activations may exist, on every silo. The runtime adds one when all local ones are busy, up to the CPU count per silo by default, or `[StatelessWorker(1)]` for an explicit limit.
- Calls run on the local silo when it can host the type, with no network hop or serialization.
- Activations are not individually addressable and are not in the grain directory. Two calls with the same key may hit different activations.
- Idle activations are collected as usual, so the pool shrinks with load.
- Reentrancy is unchanged: still non-reentrant unless you add `[Reentrant]`.
- Stateless workers cannot migrate and are not versioned.

Use them for functional work (decoding, routing, pre-aggregation, local caches) keyed by a fixed id such as `0`. They may hold state, but nothing coordinates state between activations.

```csharp
[StatelessWorker]
public sealed class DecoderGrain : Grain, IDecoderGrain { /* ... */ }

var worker = GrainFactory.GetGrain<IDecoderGrain>(0);
await worker.Decode(payload);
```

## Checklist

- Interface methods return `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>`, or `IAsyncEnumerable<T>`.
- `[Alias]` on interfaces, methods, and message types; `[GenerateSerializer]` and `[Id(n)]` on every serialized type.
- One `CancellationToken` per method, last, with a default.
- Do not `.Wait()` or `.Result` on grain calls inside a grain. Await them.
- Break call cycles with `AllowCallChainReentrancy` or `[AlwaysInterleave]`, or restructure. Non-reentrant is the safe default.
- Never rely on `OnDeactivateAsync` for durable work. Write state when it changes.
- Put `[ResponseTimeout]` on the interface, not the class.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/grains/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-identity?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-references?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-lifecycle?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/request-scheduling?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/request-context?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/oneway?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/cancellation-tokens?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/stateless-worker-grains?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-extensions?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/interceptors?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/activation-collection?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/scheduler?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/serialization?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/migration-guide?pivots=orleans-10-0

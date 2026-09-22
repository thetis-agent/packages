---
name: observers
description: "Orleans grain observers: push from a grain to a client or grain with IGrainObserver, object references, ObserverManager, re-subscription, one-way calls. Use when a client must receive events without polling, a subscription silently stops, object references leak, or you choose between observers, streams and polling."
metadata:
  title: Orleans grain observers
  tags: [orleans, dotnet, csharp, observers, igrainobserver, observermanager, notifications, pubsub, client, signalr, oneway, createobjectreference]
  related: [orleans, orleans/grains, orleans/streams, orleans/timers-reminders, orleans/hosting, orleans/best-practices]
  version: 1
---
# Orleans grain observers

## What an observer is

A grain call is request and response. When a client needs to be told about something later, for example a new chat message, the grain needs a way to call the client. An observer is that way. The client (or another grain) implements an interface derived from `IGrainObserver`, turns the object into a reference the runtime can address, and hands that reference to the grain. The grain later calls methods on the reference like on any grain reference. The runtime delivers the request and, unless the method is one-way, the response.

Observers are not durable and not fault tolerant. A client process that dies is gone; its observer reference points nowhere. A client that restarts gets new, random identities for its observers. Every design built on observers must expect that and re-subscribe.

## Define the observer interface

```csharp
public interface IChatObserver : IGrainObserver
{
    Task ReceiveMessage(string message);
}
```

Rules:

- The interface inherits `IGrainObserver` (namespace `Orleans`).
- Methods return `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>` or `void`. Avoid `void`: it invites `async void`, and an exception thrown there can crash the process.
- For best-effort notifications add `[OneWay]` (`Orleans.Concurrency.OneWayAttribute`) to the method. The caller does not wait for a response and the receiver sends none. The call returns as soon as the message is sent.
- Arguments cross the wire. Mark message types `[GenerateSerializer]` with `[Id]` members.

```csharp
[GenerateSerializer, Immutable]
public sealed record ChatEvent([property: Id(0)] string From, [property: Id(1)] string Text);

public interface IChatObserver : IGrainObserver
{
    [OneWay]
    Task OnEvent(ChatEvent evt);
}
```

## The observed grain

The grain keeps a set of observer references and offers `Subscribe` and `Unsubscribe`. `ObserverManager<TObserver>` (namespace `Orleans.Utilities`, assembly `Orleans.Core`, in Orleans since 7.0) does the bookkeeping. It stores each observer with a timestamp and drops it after `ExpirationDuration` unless the observer subscribes again.

```csharp
public interface IChatRoomGrain : IGrainWithStringKey
{
    Task Subscribe(IChatObserver observer);
    Task Unsubscribe(IChatObserver observer);
    Task Post(ChatEvent evt);
}

public sealed class ChatRoomGrain(ILogger<ChatRoomGrain> logger) : Grain, IChatRoomGrain
{
    private readonly ObserverManager<IChatObserver> _observers = new(TimeSpan.FromMinutes(5), logger);

    public Task Subscribe(IChatObserver observer)
    {
        _observers.Subscribe(observer, observer);   // idempotent; renews the expiry
        return Task.CompletedTask;
    }

    public Task Unsubscribe(IChatObserver observer)
    {
        _observers.Unsubscribe(observer);
        return Task.CompletedTask;
    }

    public Task Post(ChatEvent evt)
    {
        _observers.Notify(o => o.OnEvent(evt));     // sync overload: fire and forget per observer
        return Task.CompletedTask;
    }
}
```

`ObserverManager<TObserver>` API (it derives from `ObserverManager<TIdentity, TObserver>` with `IAddressable` as the identity):

- `new ObserverManager<T>(TimeSpan expiration, ILogger logger)`.
- `Subscribe(id, observer)`: add or renew. `Unsubscribe(id)`: remove.
- `Notify(Action<T>)` and `Notify(Func<T, Task>)`, both with an optional `Func<T, bool>` predicate. The `Task` overload awaits each observer. Both overloads catch exceptions from a notification and remove that observer. The docs' cancellation example spells the `Task` overload `NotifyAsync`; the member in `Orleans.Core` is named `Notify`.
- `Count`, `Observers` (a copy), `ExpirationDuration`, `ClearExpired()`, `Clear()`, enumeration.
- `GetDateTime` is a replaceable clock for tests.

Choose the expiry to be a few times the client's re-subscription period. Five minutes with a one-minute client timer is the documented pattern.

Do not persist observer references in grain state. They are only valid while the client process lives. A grain that reactivates starts with an empty observer set, and clients refill it through their re-subscription timer.

## The client side

```csharp
public sealed class ChatObserver : IChatObserver
{
    public Task OnEvent(ChatEvent evt)
    {
        Console.WriteLine($"{evt.From}: {evt.Text}");
        return Task.CompletedTask;
    }
}
```

```csharp
// IGrainFactory or IClusterClient
var room = grainFactory.GetGrain<IChatRoomGrain>("lobby");

var observer = new ChatObserver();
IChatObserver reference = grainFactory.CreateObjectReference<IChatObserver>(observer);

await room.Subscribe(reference);

// Keep the subscription alive. The grain drops it after ExpirationDuration otherwise.
using var renew = new PeriodicTimer(TimeSpan.FromMinutes(1));
_ = Task.Run(async () =>
{
    while (await renew.WaitForNextTickAsync())
    {
        await room.Subscribe(reference);
    }
});

// ... later
await room.Unsubscribe(reference);
grainFactory.DeleteObjectReference<IChatObserver>(reference);
```

- `CreateObjectReference<T>(T obj)` registers `obj` in the client's object manager and returns an addressable reference. Each call creates a new reference with a new identity, even for the same object.
- Since Orleans 7 the method is synchronous. Older versions returned `Task<T>`.
- The client holds the object through a `WeakReference<T>`. Keep your own strong reference to the observer object, or it can be collected while the registration still exists.
- The registration itself is strong. `DeleteObjectReference<T>(reference)` removes it. Without that call the client leaks one entry per `CreateObjectReference`, and a long-lived client can run out of memory.
- Re-subscribe on a timer. The docs are explicit: clients are not fault tolerant, so `ObserverManager` expires subscriptions, and active clients must call `Subscribe` again before the expiry.

A tidy client wraps all of this in an `IAsyncDisposable` that creates the reference, subscribes, runs the renewal loop, and on dispose unsubscribes and deletes the reference.

## Grain-to-grain observers

A grain can observe another grain with the same interfaces. No `CreateObjectReference` is needed because a grain is already addressable:

```csharp
public sealed class DashboardGrain : Grain, IDashboardGrain, IChatObserver
{
    public async Task WatchAsync(string room)
    {
        var roomGrain = GrainFactory.GetGrain<IChatRoomGrain>(room);
        await roomGrain.Subscribe(this.AsReference<IChatObserver>());
    }

    public Task OnEvent(ChatEvent evt) => Task.CompletedTask;
}
```

The observed grain still expires subscriptions, so the observing grain must also renew, for example from a grain timer with `KeepAlive`. For durable grain-to-grain fan-out prefer streams: their subscriptions survive deactivation.

## Execution model

- Each object reference is a separate target. Requests to one reference run one at a time, to completion. Observers are non-reentrant, and `[Reentrant]` or `[AlwaysInterleave]` have no effect on them.
- Different observers can run in parallel.
- An observer method runs on the client's thread pool, outside any grain context. It can call grains but has no single-threaded guarantee beyond "one request at a time for this reference".
- A `Notify` from the grain fans out one message per observer. With the `Action<T>` overload the grain does not wait; a dead client costs a timeout on the runtime's side, not on the grain's turn. With the `Task` overload the grain awaits all of them; combine it with `[OneWay]` methods or a cancellation token to bound the wait.

## CancellationToken (Orleans 9 and later)

Observer methods accept a `CancellationToken` as the last parameter. The grain can bound how long it waits on observers:

```csharp
public interface IDataObserver : IGrainObserver
{
    Task OnDataReceivedAsync(DataPayload data, CancellationToken cancellationToken = default);
}

public async Task SendDataToObserversAsync(DataPayload data, CancellationToken cancellationToken = default)
{
    using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    cts.CancelAfter(TimeSpan.FromSeconds(30));
    await _observers.Notify(o => o.OnDataReceivedAsync(data, cts.Token));
}
```

Orleans 7 and 8 do not support this; the older `GrainCancellationToken` is the workaround there. Only one `CancellationToken` parameter per method is allowed (`ORLEANS0109` build error otherwise).

## Observers vs streams vs polling

| Need | Pick |
| --- | --- |
| Client process wants live events from a grain, losing some on client failure is acceptable | observer |
| Durable subscription that survives consumer deactivation or restart | stream |
| Fan-out to many grains, producer does not know consumers | stream, or broadcast channel if loss is fine |
| Many clients, or clients behind a load balancer, or browsers | observer per server process, then fan out locally (SignalR, WebSocket) |
| Rare checks, or state is cheap to read | polling with a normal grain call |
| Ordering, replay, at-least-once | stream on a persistent provider |

Observers cost nothing to set up: no provider, no storage. Streams need a provider and a `PubSubStore`. Polling is the simplest and scales poorly when many clients poll often. The docs note that streams work the same in grains and clients and make observers redundant for most client-side scenarios; observers remain the lightest option when a single process needs a direct callback.

## Browsers: SignalR bridge

A browser cannot be an Orleans client. The pattern is:

1. The ASP.NET Core process hosts the Orleans client (or co-hosts a silo) and a SignalR hub.
2. One observer object per hub or per grain of interest lives in the web process. It is created with `CreateObjectReference` once, subscribed, and renewed on a timer by a hosted service.
3. The observer's method forwards the event to `IHubContext<ChatHub>.Clients.Group(room).SendAsync(...)`.
4. When the last browser leaves a group, the hosted service unsubscribes and deletes the reference.

With several web instances each one subscribes its own observer; the grain notifies all of them and each forwards to its own connections. Do not create one observer per browser connection: the grain's observer set grows with users, and each disconnect must delete its reference. Streams with a client-side subscription are an alternative when the web tier needs durability.

## Pitfalls

- Subscription stops after about five minutes: no re-subscription timer. Renew before `ExpirationDuration`.
- Memory grows in the client: `DeleteObjectReference` was never called.
- Notifications stop after a client restart: the old reference is dead. Subscribe again with a new one; the grain will expire the old one.
- `async void` in an observer implementation: exceptions escape and can kill the process. Return `Task`.
- Observer reference stored in grain state: invalid after any client restart. Keep it in memory only.
- Exceptions thrown from an observer method propagate to the grain when it awaits the call. With `Notify(Func<T, Task>)` the manager removes that observer. With `[OneWay]` the grain never sees the failure.
- Expecting order across observers: each observer processes one request at a time, but there is no ordering between different observers or between an observer and other grain calls.
- Large fan-out from one grain: every `Notify` sends N messages on the grain's turn. For thousands of observers use a stream or shard the observers across grains.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/grains/observers?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/api/orleans.utilities.observermanager-1?view=orleans-10.0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/cancellation-tokens?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/streaming/streams-programming-apis?pivots=orleans-10-0

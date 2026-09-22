---
name: streams
description: "Orleans streams: StreamId, providers, IAsyncStream<T>, subscription handles, implicit subscriptions, backpressure, delivery guarantees, broadcast channels. Use when grains or clients publish events to unknown consumers, a subscription stops after reactivation, or you configure a streaming provider."
metadata:
  title: Orleans streams
  tags: [orleans, dotnet, csharp, streams, streaming, pubsub, eventhubs, azurequeue, sqs, memorystreams, implicitsubscription, streamid, broadcastchannel, backpressure]
  related: [orleans, orleans/grains, orleans/hosting, orleans/persistence, orleans/observers, orleans/serialization, orleans/best-practices]
  version: 1
---
# Orleans streams

## What a stream is

An Orleans stream is a virtual, logical sequence of events. It always exists. It is never created or deleted, and it cannot fail. Producers and consumers can be grains or Orleans clients, on any silo, at any time. The runtime tracks subscriptions in a pub-sub component and delivers events even across failures and re-activations.

Principles from the docs:

1. Streams are virtual and identified by a `StreamId` (namespace string plus key).
2. Producing and consuming are decoupled in time and space.
3. Streams are lightweight; the runtime is built for many streams that come and go, and for bindings that change fast.
4. The runtime manages the lifetime of a subscription. Once subscribed, a grain receives events even after deactivation and re-activation.
5. The same API works in grains and in clients.

Package: `Microsoft.Orleans.Streaming` (silo and client). Provider packages add transports.

## Setup

Every silo and every client that touches streams registers a stream provider by name. Streams that need pub-sub also need a grain storage provider named `PubSubStore`.

```csharp
var builder = Host.CreateApplicationBuilder(args);
builder.UseOrleans(silo =>
{
    silo.UseLocalhostClustering();
    silo.AddMemoryGrainStorage("PubSubStore");     // subscription bookkeeping
    silo.AddMemoryStreams("StreamProvider");       // in-memory, development only
});
```

On a client: `client.AddMemoryStreams("StreamProvider")`. Memory streams are not durable. Events are lost when the silo restarts. In production, `PubSubStore` must be a durable store, for example `AddAzureTableGrainStorage("PubSubStore", ...)` or `AddAdoNetGrainStorage("PubSubStore", ...)`.

## Get a stream

```csharp
public async Task SetupStream()
{
    IStreamProvider provider = this.GetStreamProvider("StreamProvider");
    StreamId streamId = StreamId.Create("MyNamespace", this.GetPrimaryKey());
    IAsyncStream<ChatMessage> stream = provider.GetStream<ChatMessage>(streamId);
}
```

- Inside a grain: `this.GetStreamProvider(name)`. On a client: `client.GetStreamProvider(name)` (`IClusterClient`). Both are local calls; nothing is sent.
- `StreamId.Create(namespace, key)`: the key can be a `Guid`, a `string`, or a `long`. Namespace plus key is the identity, the same way grain type plus key is a grain identity. Stream 123 in `PlayerEvents` and stream 123 in `ChatRoom` are different streams.
- Before Orleans 7 the call was `GetStream<T>(Guid, string ns)`. The `StreamId` form is current.

Event types cross the wire, so mark them `[GenerateSerializer]` with `[Id]` on members. Mark them `[Immutable]` if they are never mutated, to skip the defensive copy.

```csharp
[GenerateSerializer, Immutable]
public sealed record ChatMessage([property: Id(0)] string From, [property: Id(1)] string Text);
```

## Produce

`IAsyncStream<T>` implements `IAsyncObserver<T>`:

```csharp
public interface IAsyncObserver<in T>
{
    Task OnNextAsync(T item, StreamSequenceToken? token = null);
    Task OnCompletedAsync();
    Task OnErrorAsync(Exception ex);
}
```

```csharp
await stream.OnNextAsync(new ChatMessage("alice", "hi"));
```

A producer that deactivates does nothing special. Next time it wants to publish, it gets the stream handle again and calls `OnNextAsync`. There is no producer registration. Many producers may write to one stream; many consumers may read it.

`IAsyncStream<T>` also implements `IAsyncBatchProducer<T>`, whose `OnNextBatchAsync(IEnumerable<T>, StreamSequenceToken?)` sends several events in one call; batch support depends on the provider. Persistent providers enqueue each call to the underlying queue; the awaited task completes when the queue accepted it, not when consumers processed it.

## Consume: explicit subscriptions

```csharp
StreamSubscriptionHandle<ChatMessage> handle = await stream.SubscribeAsync(observer);
await handle.UnsubscribeAsync();
```

`SubscribeAsync` accepts an `IAsyncObserver<T>` or lambdas (`onNextAsync`, optional `onErrorAsync`, `onCompletedAsync`) through `AsyncObservableExtensions`. It returns a `StreamSubscriptionHandle<T>`.

The subscription belongs to the grain, not to the activation. It stays in the pub-sub store until the grain calls `UnsubscribeAsync`, possibly from a later activation. A grain that subscribes X times gets each event X times, one per handle. `stream.GetAllSubscriptionHandles()` returns all current handles for that grain.

After re-activation the subscription exists but no processing logic is attached. The grain must resume it in `OnActivateAsync`:

```csharp
public sealed class ChatUserGrain : Grain, IChatUserGrain, IAsyncObserver<ChatMessage>
{
    public override async Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var stream = this.GetStreamProvider("StreamProvider")
            .GetStream<ChatMessage>(StreamId.Create("ChatRoom", this.GetPrimaryKey()));

        foreach (var handle in await stream.GetAllSubscriptionHandles())
        {
            await handle.ResumeAsync(this);   // re-attach; does not create a new subscription
        }
    }

    public async Task JoinAsync(Guid roomId)
    {
        var stream = this.GetStreamProvider("StreamProvider")
            .GetStream<ChatMessage>(StreamId.Create("ChatRoom", roomId));
        await stream.SubscribeAsync(this);    // only once per room
    }

    public Task OnNextAsync(ChatMessage item, StreamSequenceToken? token = null) => Task.CompletedTask;
    public Task OnCompletedAsync() => Task.CompletedTask;
    public Task OnErrorAsync(Exception ex) => Task.CompletedTask;
}
```

Calling `SubscribeAsync` again on activation instead of `ResumeAsync` creates a second subscription and doubles delivery. The docs note that even a grain that implements `IAsyncObserver<T>` directly must call `ResumeAsync`; the runtime does not detect it.

`ResumeAsync` can take a `StreamSequenceToken` to continue from a known point on rewindable providers.

## Consume: implicit subscriptions

```csharp
[ImplicitStreamSubscription("ChatRoom")]
public sealed class ChatRoomProjectionGrain : Grain, IChatRoomProjectionGrain,
    IStreamSubscriptionObserver, IAsyncObserver<ChatMessage>
{
    public Task OnSubscribed(IStreamSubscriptionHandleFactory handleFactory)
    {
        var handle = handleFactory.Create<ChatMessage>();
        return handle.ResumeAsync(this);
    }

    public Task OnNextAsync(ChatMessage item, StreamSequenceToken? token = null)
    {
        // process
        return Task.CompletedTask;
    }

    public Task OnCompletedAsync() => Task.CompletedTask;
    public Task OnErrorAsync(Exception ex) => Task.CompletedTask;
}
```

- `[ImplicitStreamSubscription("ns")]` maps stream `<key, ns>` to grain `<key, ThisGrainType>`. An event on the stream activates the grain if needed. The producer never learns who consumes.
- There is exactly one implicit subscription per namespace per grain. No multiplicity, no unsubscribe, no need to resume across activations. The grain only attaches its logic.
- Attaching in `OnSubscribed` via `IStreamSubscriptionObserver` lets the grain activate without subscribing. The alternative from the quick start is `stream.SubscribeAsync(...)` in `OnActivateAsync`; with an implicit subscription that call attaches logic and does not create a second subscription.
- The attribute takes a namespace string or an `IStreamNamespacePredicate` for pattern matching (`[RegexImplicitStreamSubscription("room-.*")]`).
- A `[StatelessWorker]` grain must not subscribe to streams. The docs call the behaviour undefined.

## Order, tokens and rewind

- Order depends on the provider. Memory streams deliver in the order the producer awaited `OnNextAsync`. Azure Queue does not guarantee FIFO under failure: an event that failed to process reappears later, out of order. Event Hubs preserves partition order.
- Delivery guarantees also depend on the provider. Azure Queue streams are at-least-once. Memory streams are best effort. Consumers must tolerate duplicates.
- `StreamSequenceToken` is an opaque `IComparable` the producer can attach to `OnNextAsync`. The consumer receives it with the event and can order or de-duplicate on it.
- A rewindable provider accepts a token in `SubscribeAsync` or `ResumeAsync` and replays from that point. `null` means "from now". Event Hubs is rewindable (bounded by its retention). Memory streams and Azure Queue are not.
- Recovery pattern: checkpoint state plus the last token in grain storage; on activation resume from the checkpointed token.

## Subscription semantics

Subscriptions are sequentially consistent: once the `SubscribeAsync` task completes, the consumer sees every event produced after that point. The pub-sub component is a set of `PubSubRendezvousGrain` grains that persist to the `PubSubStore` provider.

## Providers

| Provider | Registration | Package | Durable | Rewindable |
| --- | --- | --- | --- | --- |
| Memory | `AddMemoryStreams(name)` | `Microsoft.Orleans.Streaming` | no | no |
| Azure Queue | `AddAzureQueueStreams(name, ...)` | `Microsoft.Orleans.Streaming.AzureStorage` | yes | no |
| Azure Event Hubs | `AddEventHubStreams(name, ...)` | `Microsoft.Orleans.Streaming.EventHubs` | yes | yes |
| AWS SQS | `AddSqsStreams(name, ...)` | `Microsoft.Orleans.Streaming.SQS` | yes | no |
| Custom queue | `AddPersistentStreams(name, adapterFactory, ...)` | `Microsoft.Orleans.Streaming` | depends | depends |
| Broadcast channel | `AddBroadcastChannel(name)` | `Microsoft.Orleans.Streaming` | no | no |

Azure Queue with a credential:

```csharp
silo.AddAzureQueueStreams("AzureQueueProvider", configurator =>
    configurator.ConfigureAzureQueue(ob => ob.Configure(options =>
        options.QueueServiceClient = new QueueServiceClient(queueEndpoint, new DefaultAzureCredential()))))
    .AddAzureTableGrainStorage("PubSubStore", options =>
        options.TableServiceClient = new TableServiceClient(tableEndpoint, new DefaultAzureCredential()));
```

Register the same provider name on the client with the client-side extension of the same name. With Aspire, the AppHost calls `AddOrleans("cluster").WithStreaming("AzureQueueProvider", queues)` or `.WithMemoryStreaming(name)` or `.WithBroadcastChannel(name)`, and the silo calls `builder.AddKeyedAzureQueueServiceClient("streaming")` then `builder.UseOrleans()`.

### How persistent providers work

All queue-backed providers share `PersistentStreamProvider`, parameterised by an `IQueueAdapterFactory`. Writing a new transport means implementing `IQueueAdapter` (enqueue) and `IQueueAdapterReceiver` (dequeue), not a whole provider.

- `OnNextAsync` on the producer enqueues into the queue partition chosen by `IStreamQueueMapper` (default `HashRingStreamQueueMapper`, `HashRingStreamQueueMapperOptions.TotalQueueCount` sets the partition count).
- Each silo runs pulling agents, one per queue partition it owns. They are system targets: as cheap as grains, single-threaded, not virtual. `IStreamQueueBalancer` spreads partitions across silos and rebalances when silos join or leave (`UseDynamicClusterConfigDeploymentBalancer()` and others).
- An agent polls with `IQueueAdapterReceiver.GetQueueMessagesAsync`, puts messages into a per-agent `IQueueCache`, looks up subscribers in pub-sub (cached locally), and delivers to each consumer through normal grain messages, one event or one small batch at a time, awaiting each.
- Backpressure: each consumer reads from the cache through its own `IQueueCacheCursor`, so a slow consumer does not block fast ones. When the cache nears its size limit the agent slows dequeuing instead of dropping events.
- Persistent providers delete a queue message only after every consumer processed it. A failing consumer makes the message reappear, which is the source of the at-least-once and out-of-order behaviour.

```csharp
silo.AddPersistentStreams("MyQueueProvider", MyQueueAdapterFactory.Create, configurator =>
{
    configurator.Configure<HashRingStreamQueueMapperOptions>(ob => ob.Configure(o => o.TotalQueueCount = 8));
    configurator.UseDynamicClusterConfigDeploymentBalancer();
});
```

## Broadcast channels

Since Orleans 7 the old Simple Message Stream (SMS) provider is replaced by broadcast channels: fan-out of one message to all grains of a type, no storage, no history, best effort.

```csharp
silo.AddBroadcastChannel("live-stock-ticker");
```

```csharp
[ImplicitChannelSubscription]
public sealed class LiveStockGrain : Grain, ILiveStockGrain, IOnBroadcastChannelSubscribed
{
    public Task OnSubscribed(IBroadcastChannelSubscription subscription) =>
        subscription.Attach<Stock>(OnStockUpdated, OnError);

    private Task OnStockUpdated(Stock stock) => Task.CompletedTask;
    private static Task OnError(Exception ex) => Task.CompletedTask;
}

// publisher, for example a BackgroundService with IClusterClient
var provider = clusterClient.GetBroadcastChannelProvider("live-stock-ticker");
var writer = provider.GetChannelWriter<Stock>(ChannelId.Create("live-stock-ticker", Guid.Empty));
await writer.Publish(stock);
```

Use a broadcast channel when every active grain of a type should see the same message and losing one is acceptable. Use a stream when delivery, persistence, replay, or backpressure matter.

## Streams, grain calls, observers: which to use

- Direct grain call: the caller knows the target and wants a reply or an error. Cheapest and simplest. Use it by default.
- Stream: the producer does not know the consumers, consumers come and go, events must survive consumer deactivation, or you need a durable queue between producer and consumer. Cost: pub-sub storage, provider setup, at-least-once semantics.
- Observer (`IGrainObserver`): a grain pushes notifications to a client process. Not durable, not fault tolerant, but zero infrastructure. See `orleans/observers`.
- Broadcast channel: transient fan-out to all grains of a type.
- Stateless scaled-out processing of one huge stream is not what Orleans streams target. They target many small streams, each handled by a stateful grain.

## Pitfalls

- Missing `PubSubStore` provider: subscriptions throw at runtime. Register it on every silo with the same backend.
- Provider registered on the silo but not on the client (or with a different name): `GetStreamProvider` throws on the client.
- `SubscribeAsync` in `OnActivateAsync` for an explicit subscription: duplicates every activation. Use `GetAllSubscriptionHandles` plus `ResumeAsync`.
- Forgetting `ResumeAsync` after activation: the subscription exists, events arrive at the grain, and nothing handles them.
- Awaiting `OnNextAsync` inside a non-reentrant consumer that also produces to itself: deadlock. Keep producer and consumer grains separate or use `[Reentrant]` carefully.
- Memory streams in production: events vanish on silo restart and there is no backpressure across silos.
- Very large or non-serializable event types: every event is serialized; keep events small and marked `[GenerateSerializer]`.
- Expecting exactly-once from Azure Queue or SQS: design consumers to be idempotent, or use a sequence token to de-duplicate.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/streaming/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/streaming/streams-quick-start?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/streaming/streams-programming-apis?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/streaming/stream-providers?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/streaming/streams-why?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/streaming/broadcast-channel?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/streams-implementation/?pivots=orleans-10-0

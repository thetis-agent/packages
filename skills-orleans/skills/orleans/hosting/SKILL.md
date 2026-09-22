---
name: hosting
description: "Hosting Orleans: silos and clients with UseOrleans and UseOrleansClient, packages, endpoints and ports, ClusterOptions, the silo lifecycle, ASP.NET Core. Use when you set up a silo or client, wire Orleans into a web host, pick ports and ids, or run something at startup."
metadata:
  title: Orleans hosting
  tags: [orleans, dotnet, csharp, hosting, silo, client, useorleans, useorleansclient, isilobuilder, iclientbuilder, localhost-clustering, nuget, endpoints, ports, clusteroptions, clusterid, serviceid, silo-lifecycle, startup-tasks, backgroundservice, aspnetcore, cohosting, iclusterclient, igrainfactory, shutdown, logging, aspire, options]
  related: [orleans, orleans/grains, orleans/clustering, orleans/placement, orleans/persistence, orleans/testing, orleans/deployment, orleans/migration, orleans/best-practices]
  version: 1
---
# Orleans hosting

## Silos and clients

An Orleans application is a cluster of *silos* plus zero or more *clients*.

- A silo is a server process that hosts grain activations. Silos talk to each other on the silo port (default 11111).
- A client is any non-grain code that calls grains. A client is either *co-hosted* in a silo process (recommended; it uses the silo's own knowledge of the cluster, no gateway hop) or *external*, connecting to silo gateways on the gateway port (default 30000).
- Both are configured on the .NET Generic Host. Orleans starts and stops with the host.

## NuGet packages

| Package | Reference it from |
|---|---|
| `Microsoft.Orleans.Sdk` | Grain interface and grain class libraries. Brings the code generator and analyzers. Included by Server and Client. |
| `Microsoft.Orleans.Server` | Silo host projects. Includes everything in Client, so a silo can also act as a client. |
| `Microsoft.Orleans.Client` | Standalone client projects that do not host a silo. |
| `Microsoft.Orleans.Clustering.*` | One clustering provider per cluster: `AzureStorage`, `AdoNet`, `Cosmos`, `DynamoDB`, `Redis`, `Cassandra`, `Consul`, `ZooKeeper`. Localhost clustering is built in. |
| `Microsoft.Orleans.Persistence.*` | Grain storage: `AzureStorage`, `AdoNet`, `Cosmos`, `DynamoDB`, `Redis`, `Memory`. |
| `Microsoft.Orleans.Reminders.*` | Reminder tables: `AzureStorage`, `AdoNet`, `Cosmos`, `DynamoDB`, `Redis`. |
| `Microsoft.Orleans.Streaming.*` | Stream providers: `AzureStorage` (queues), `EventHubs`, `SQS`. |
| `Microsoft.Orleans.GrainDirectory.*` | External grain directories: `AzureStorage`, `AdoNet`, `Redis`. |
| `Microsoft.Orleans.Hosting.Kubernetes` | `UseKubernetesHosting()` for pods. |
| `Microsoft.Orleans.TestingHost` | In-process test clusters. |
| `Microsoft.Orleans.Dashboard` | The cluster dashboard. |

Orleans 10 ADO.NET providers on SQL Server use the `Microsoft.Data.SqlClient` invariant. Orleans 7 to 9 used `System.Data.SqlClient`.

## Minimal silo

```csharp
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

builder.UseOrleans(silo =>
{
    silo.UseLocalhostClustering();
});

using var host = builder.Build();
await host.RunAsync();
```

`UseOrleans` registers the silo with the host and gives you an `ISiloBuilder`. Everything else (clustering, storage, reminders, streams, endpoints, options) is configured on that builder. `UseLocalhostClustering()` runs a single-silo cluster on the loopback address with ports 11111 and 30000 and `ClusterId`/`ServiceId` of `"dev"`. It is for development only.

Grain classes are discovered from the assemblies the host references. There is no `ConfigureApplicationParts` since Orleans 7.

Since Orleans 8 the parameterless `builder.UseOrleans()` works with Aspire, which injects cluster ids, endpoints, and provider settings through environment variables.

## Minimal external client

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

builder.UseOrleansClient(client =>
{
    client.UseLocalhostClustering();
});

using var host = builder.Build();
await host.StartAsync();

var clusterClient = host.Services.GetRequiredService<IClusterClient>();
var hello = clusterClient.GetGrain<IHelloGrain>("friend");
Console.WriteLine(await hello.SayHello("Good morning!"));
```

`UseOrleansClient` gives you an `IClientBuilder`. The client connects when the host starts. It must use the same clustering provider and `ClusterId` as the silos, so it can find the gateways.

## Co-hosting a silo in ASP.NET Core

Call `UseOrleans` on the web application builder. The silo starts with the web host, and `IClusterClient` and `IGrainFactory` are already in the DI container for controllers, minimal APIs, and hosted services. Do not add `UseOrleansClient` in the same process.

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.UseOrleans(silo =>
{
    silo.UseLocalhostClustering()
        .AddMemoryGrainStorage("Default");
});

var app = builder.Build();

app.MapGet("/hello/{name}", async (string name, IGrainFactory grains) =>
    await grains.GetGrain<IHelloGrain>(name).SayHello("hi"));

app.Run();
```

Trade-offs of co-hosting: fewer hops and no separate deployable, but client code shares the CPU with grains, so blocking I/O or lock contention in request handlers slows grains. Keep the web layer thin.

## Getting a client

- `IClusterClient`: the client interface. Extends `IGrainFactory`. Inject it into services and controllers.
- `IGrainFactory`: `GetGrain<T>(key)` and friends. Inside a grain use the `GrainFactory` property. Inside a silo process either interface is available from DI.
- Both are singletons. Do not build one per request.

Client-side failure modes:

- Initial connection fails: register an `IClientConnectionRetryFilter` to decide whether to retry; without one, or when it returns `false`, the client gives up and the host fails to start.
- A call fails because the silo went away: `SiloUnavailableException`. The grain reference stays valid; retry later.
- Clients are multi-threaded. Orleans gives no single-threaded guarantee on the client side.

## Endpoints

By default a silo listens on all interfaces: port 11111 for silo-to-silo and port 30000 for the client gateway. Change ports with:

```csharp
silo.ConfigureEndpoints(siloPort: 11_111, gatewayPort: 30_000);
```

For NAT, containers, or port forwarding set the advertised and listening addresses separately with `EndpointOptions`:

```csharp
silo.Configure<EndpointOptions>(options =>
{
    options.SiloPort = 11_111;                   // published to the membership table
    options.GatewayPort = 30_000;                // published to the membership table
    options.AdvertisedIPAddress = IPAddress.Parse("172.16.0.42");
    options.SiloListeningEndpoint = new IPEndPoint(IPAddress.Any, 50_000);    // actual bind
    options.GatewayListeningEndpoint = new IPEndPoint(IPAddress.Any, 40_000); // actual bind
});
```

The membership table then shows `172.16.0.42:11111` and `172.16.0.42:30000` while the process binds `0.0.0.0:50000` and `0.0.0.0:40000`. Every silo in a cluster must be able to reach every other silo's advertised silo endpoint, and clients must reach the gateway endpoints. On Kubernetes `UseKubernetesHosting()` sets the advertised address to the pod IP for you (see `orleans/clustering`).

## ClusterOptions: ClusterId and ServiceId

```csharp
silo.Configure<ClusterOptions>(options =>
{
    options.ClusterId = "my-first-cluster";
    options.ServiceId = "SampleApp";
});
```

- `ClusterId` decides which hosts form a cluster. Silos and clients with the same `ClusterId` and the same membership table find each other. Change it per deployment for blue/green; keep it fixed for rolling upgrades.
- `ServiceId` identifies the logical application. Storage, reminder, and directory providers key data by it. Keep it stable forever. Several clusters may share one `ServiceId` to share storage.
- Both default to `"default"`. Set them explicitly in anything but a throwaway.

Configure the same two values on the client.

## Silo lifecycle

Silos and clients start and stop through an observable lifecycle with fixed stages:

```csharp
public static class ServiceLifecycleStage
{
    public const int First = int.MinValue;
    public const int RuntimeInitialize = 2_000;      // threading
    public const int RuntimeServices = 4_000;        // networking, agents
    public const int RuntimeStorageServices = 6_000; // storage providers
    public const int RuntimeGrainServices = 8_000;   // type management, membership, directory
    public const int ApplicationServices = 10_000;   // application layer services
    public const int BecomeActive = Active - 1;      // silo joins the cluster
    public const int Active = 20_000;                // silo accepts work
    public const int Last = int.MaxValue;
}
```

Stages run in ascending order on start and descending order on stop. Orleans logs which components joined each stage, and how long each took, at Information level on the `Orleans.Runtime.SiloLifecycleSubject` logger. Read those lines when startup order is in doubt.

### Participating in the lifecycle

Register a service that implements `ILifecycleParticipant<ISiloLifecycle>` and subscribe at a stage:

```csharp
public sealed class WarmCache(ICache cache) : ILifecycleParticipant<ISiloLifecycle>
{
    public void Participate(ISiloLifecycle lifecycle)
    {
        lifecycle.Subscribe<WarmCache>(
            ServiceLifecycleStage.ApplicationServices,
            onStart: ct => cache.LoadAsync(ct),
            onStop: ct => cache.FlushAsync(ct));
    }
}

builder.Services.AddSingleton<ILifecycleParticipant<ISiloLifecycle>, WarmCache>();
```

Grain calls are only possible from `ServiceLifecycleStage.Active` onward.

### Startup tasks and background services

Prefer the standard .NET hosting mechanisms. Register them after `UseOrleans` so they start after the silo:

```csharp
builder.UseOrleans(silo => { /* ... */ });
builder.Services.AddHostedService<GrainPingService>(); // BackgroundService or IHostedService
```

A `BackgroundService` can inject `IGrainFactory` and call grains in `ExecuteAsync`. Handle `OperationCanceledException` on shutdown.

Orleans startup tasks still exist. They run at `ServiceLifecycleStage.Active` by default, and an exception in one stops the silo (fail fast).

```csharp
silo.AddStartupTask(async (IServiceProvider services, CancellationToken ct) =>
{
    var grains = services.GetRequiredService<IGrainFactory>();
    await grains.GetGrain<IWarmupGrain>("startup").Initialize();
});

silo.AddStartupTask<CallGrainStartupTask>(); // class implementing IStartupTask.Execute(CancellationToken)
silo.AddStartupTask(task, ServiceLifecycleStage.Active); // explicit stage
```

## Shutdown

Orleans shuts down when the host does. `host.RunAsync()` (or `RunConsoleAsync()` on `IHostBuilder`) listens for Ctrl+C and SIGTERM and stops the host gracefully: the silo leaves the cluster, deactivates its grains, and stops providers in reverse stage order. Give the process enough time to do this: in containers set `DOTNET_SHUTDOWNTIMEOUTSECONDS` and a matching `terminationGracePeriodSeconds`. `ProcessExitHandlingOptions` tunes what the silo does on process exit.

## Logging

Orleans logs through `Microsoft.Extensions.Logging`. Configure it on the host:

```csharp
builder.Logging.SetMinimumLevel(LogLevel.Information).AddConsole();
```

Useful categories: `Orleans.Runtime.SiloLifecycleSubject` (stage timing), `Orleans.Runtime.MembershipService` and related (cluster membership), and the grain class name for your own `ILogger<TGrain>`. Grain classes take `ILogger<T>` through the constructor.

## Options classes

All options live in `Orleans.Configuration`. Set them with `silo.Configure<TOptions>(o => ...)` or `client.Configure<TOptions>(...)`. They follow the .NET options pattern, so they also bind from configuration.

Common to silo and client: `ClusterOptions`, `NetworkingOptions`, `TypeManagementOptions`.

Client only: `ClientMessagingOptions` (`ResponseTimeout`, connections), `GatewayOptions` (gateway list refresh), `StaticGatewayListProviderOptions`.

Silo only: `EndpointOptions`, `SiloOptions` (`SiloName`), `ClusterMembershipOptions`, `SiloMessagingOptions` (`ResponseTimeout`, cancellation), `GrainCollectionOptions`, `GrainVersioningOptions`, `LoadSheddingOptions`, `SchedulingOptions`, `PerformanceTuningOptions`, `ProcessExitHandlingOptions`, `ConsistentRingOptions`.

## A production-shaped silo

```csharp
var builder = Host.CreateApplicationBuilder(args);

builder.UseOrleans(silo =>
{
    silo.Configure<ClusterOptions>(o =>
        {
            o.ClusterId = builder.Configuration["Orleans:ClusterId"] ?? "prod-1";
            o.ServiceId = "Orders";
        })
        .UseAdoNetClustering(o =>
        {
            o.Invariant = "Microsoft.Data.SqlClient"; // Orleans 10; "System.Data.SqlClient" on 7 to 9
            o.ConnectionString = builder.Configuration.GetConnectionString("Orleans")!;
        })
        .ConfigureEndpoints(siloPort: 11_111, gatewayPort: 30_000)
        .AddAdoNetGrainStorage("Default", o =>
        {
            o.Invariant = "Microsoft.Data.SqlClient";
            o.ConnectionString = builder.Configuration.GetConnectionString("Orleans")!;
        });
});

builder.Logging.SetMinimumLevel(LogLevel.Information).AddConsole();

using var host = builder.Build();
await host.RunAsync();
```

Swap `UseAdoNetClustering` for `UseAzureStorageClustering`, `UseRedisClustering`, `UseCosmosClustering`, and so on; the shape is the same. See `orleans/clustering` for the providers and `orleans/persistence` for storage.

## Aspire

Since Orleans 8 the `Aspire.Hosting.Orleans` package models the cluster in the AppHost: `builder.AddOrleans("cluster").WithClustering(redis).WithGrainStorage("Default", redis).WithReminders(redis)`, then `AddProject<Projects.Silo>("silo").WithReference(orleans)` and `.WithReference(orleans.AsClient())` for client-only projects. The silo project then calls `builder.AddKeyedRedisClient("redis")` (or the matching `AddKeyed*` for the resource) and the parameterless `builder.UseOrleans()`. Missing the `AddKeyed*` call is the usual cause of a dependency resolution error at startup.

## Checklist

- One `UseOrleans` per silo process; `UseOrleansClient` only in processes without a silo.
- Same `ClusterId`, `ServiceId`, and clustering provider on every silo and client of a cluster.
- Explicit `ConfigureEndpoints` and an advertised IP whenever the process is behind NAT or in a container.
- Register hosted services after `UseOrleans`.
- Never block on grain calls in startup code; await them.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/local-development-configuration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/server-configuration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/client-configuration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/typical-configurations?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/list-of-options-classes?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/startup-tasks?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/shutting-down-orleans?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/silo-lifecycle?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/client?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/aspire-integration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/resources/nuget-packages?pivots=orleans-10-0

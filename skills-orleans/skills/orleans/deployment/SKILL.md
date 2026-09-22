---
name: deployment
description: "Deploying an Orleans cluster in production: providers, rolling upgrades with interface versioning, Kubernetes, Docker, Azure, ports, shutdown, scaling. Use when you deploy, upgrade, scale or monitor an Orleans cluster."
metadata:
  title: Orleans deployment
  tags: [orleans, dotnet, csharp, deployment, kubernetes, docker, azure, clustering, versioning, rolling-upgrade, monitoring, opentelemetry, dashboard, scaling, networking, shutdown]
  related: [orleans, orleans/hosting, orleans/clustering, orleans/placement, orleans/migration, orleans/best-practices, orleans/testing]
  version: 1
---

# Orleans deployment

This skill covers running an Orleans 10 cluster in production. It is written for Orleans 10 on .NET 10. Where a behaviour changed in Orleans 7, 8, 9, or 10, the change is noted.

## Shape of a deployment

- A deployment is a cluster of silo processes plus client processes (usually web servers).
- Silos talk to each other on the silo port (default `11111`). Clients connect to the gateway port on silos (default `30000`). Every silo hosts a gateway by default. Clients connect to all gateways in parallel.
- A single silo is fine for tests. Production needs more than one silo for fault tolerance and scale.
- Silos and clients are both configured on the .NET generic host: `IHostBuilder.UseOrleans(...)` for a silo and `IHostBuilder.UseOrleansClient(...)` for a client. Package `Microsoft.Orleans.Server` for silos, `Microsoft.Orleans.Client` for clients. Orleans 7 removed `SiloHostBuilder` and `ClientBuilder`.
- Do not expose silo TCP endpoints to the public Internet. Put an HTTP or socket front end in front of the cluster.

## Choose a clustering provider

The cluster membership protocol needs a durable `IMembershipTable`. `UseLocalhostClustering()` and `UseDevelopmentClustering(primaryEndpoint)` are for development only. Official providers:

| Store | Package | Silo call |
| --- | --- | --- |
| Azure Table Storage | `Microsoft.Orleans.Clustering.AzureStorage` | `UseAzureStorageClustering` |
| ADO.NET (SQL Server, PostgreSQL, MySQL/MariaDB, Oracle) | `Microsoft.Orleans.Clustering.AdoNet` | `UseAdoNetClustering` |
| Redis | `Microsoft.Orleans.Clustering.Redis` | `UseRedisClustering` |
| Azure Cosmos DB | `Microsoft.Orleans.Clustering.Cosmos` | `UseCosmosClustering` |
| Apache Cassandra (8.2+) | `Microsoft.Orleans.Clustering.Cassandra` | `UseCassandraClustering` |
| AWS DynamoDB | `Microsoft.Orleans.Clustering.DynamoDB` | `UseDynamoDBClustering` |
| Apache ZooKeeper | `Microsoft.Orleans.Clustering.ZooKeeper` | `UseZooKeeperClustering` |
| HashiCorp Consul | `Microsoft.Orleans.Clustering.Consul` | `UseConsulClientClustering` |

Rules:

- The store must be durable. For Redis, turn persistence on. A volatile store can make the cluster unavailable.
- Clients need the matching gateway list provider (for example `UseAzureStorageClustering` on `IClientBuilder`, or `UseCosmosGatewayListProvider`).
- Prefer a `TokenCredential` (for example `DefaultAzureCredential`) over a connection string on Azure.
- ADO.NET in Orleans 10 requires `Microsoft.Data.SqlClient`. The invariant is `"Microsoft.Data.SqlClient"`. Orleans 7 to 9 used `"System.Data.SqlClient"`. Apply the SQL migration scripts from `src/AdoNet/*/Migrations` on upgrade.

```csharp
using Azure.Identity;

var builder = Host.CreateApplicationBuilder(args);
builder.UseOrleans(siloBuilder =>
{
    siloBuilder.UseAzureStorageClustering(options =>
    {
        options.ConfigureTableServiceClient(
            new Uri("https://<account>.table.core.windows.net"),
            new DefaultAzureCredential());
    });
});
```

Membership protocol defaults in Orleans 9 and 10: each silo is probed by 10 others, probes every 10 s, 3 missed probes raise a suspicion, 2 suspicions within 3 minutes declare a silo dead. Typical detection is about 15 s. Orleans 7 and 8 probed with 3 silos. Tune with `ClusterMembershipOptions` (`NumProbedSilos`, `NumVotesForDeathDeclaration`, `DeathVoteExpirationTimeout`, `ProbeTimeout`, `NumMissedProbesLimit`). A dead silo learns its status from the table and exits. The host platform must restart it.

If the membership store is unreachable, live silos keep working. The cluster only loses the ability to declare deaths and admit new silos.

## ClusterOptions: ClusterId and ServiceId

```csharp
siloBuilder.Configure<ClusterOptions>(options =>
{
    options.ClusterId = "my-cluster";   // which hosts form one cluster
    options.ServiceId = "MyService";    // stable identity for storage, reminders, streams
});
```

- `ServiceId` must be stable for the life of the application. Storage providers key data by it. All hosts in one cluster must share it.
- `ClusterId` decides which hosts join together. Several clusters may share one `ServiceId`.
- Rolling deployment: keep both ids fixed. Typical on Kubernetes and Service Fabric.
- Blue/green: start a new cluster with a new `ClusterId` and the same `ServiceId`, then switch traffic. Typical on Azure App Service slots.
- Both default to `"default"`.

## Ports and networking

Defaults: silo port `11111`, gateway port `30000`, listening on all interfaces.

```csharp
siloBuilder.ConfigureEndpoints(siloPort: 11_111, gatewayPort: 30_000);
```

For NAT or port forwarding, set the advertised address separately from the bound sockets:

```csharp
siloBuilder.Configure<EndpointOptions>(options =>
{
    options.SiloPort = 11_111;
    options.GatewayPort = 30_000;
    options.AdvertisedIPAddress = IPAddress.Parse("172.16.0.42");
    options.GatewayListeningEndpoint = new IPEndPoint(IPAddress.Any, 40_000);
    options.SiloListeningEndpoint = new IPEndPoint(IPAddress.Any, 50_000);
});
```

The silo binds `0.0.0.0:40000` and `0.0.0.0:50000` but publishes `172.16.0.42:11111` and `172.16.0.42:30000` to the membership table. `ConfigureEndpoints(address, siloPort, gatewayPort, listenOnAnyHostAddress: true)` covers the common case where the advertised IP is not bindable. Open TCP `11111` and `30000` in firewalls. Silos in the same major version family (8.x with 8.y) may run together in one cluster.

## Grain interface versioning and rolling upgrades

Grain interface versioning lets silos with different code versions live in one cluster. Grain state versioning is separate (see serialization rules).

```csharp
[Version(2)]
public interface IOrderGrain : IGrainWithStringKey
{
    Task Place(int qty);           // unchanged from V1
    Task Cancel(string reason);    // added in V2
}
```

- No `[Version]` means version 0.
- When a call for version Vn reaches an activation: a compatible activation serves it; an incompatible one is deactivated and a compatible one is created.
- Compatibility strategies (`Orleans.Versions.Compatibility`): `BackwardCompatible` (default: Vn serves callers of Vm when Vn keeps all Vm methods and their signatures; a V1 caller can use a V2 grain, not the reverse), `AllVersionsCompatible` (every version serves every caller), `StrictVersionCompatible` (only equal versions).
- Version selector strategies (`Orleans.Versions.Selector`): `AllCompatibleVersions` (default: random among compatible versions, weighted by silo count), `LatestVersion` (always the newest compatible), `MinimumVersion` (the requested version or the lowest compatible one).
- Limitations: stateless workers are not versioned; stream interfaces are not versioned.

```csharp
siloBuilder.Configure<GrainVersioningOptions>(options =>
{
    options.DefaultCompatibilityStrategy = nameof(BackwardCompatible);
    options.DefaultVersionSelectorStrategy = nameof(AllCompatibleVersions);
});
```

Rules for backward compatible interfaces:

- Never change the signature of an existing method, not even parameter names. The serializer maps arguments by position; swapping `Subtract(int a, int b)` to `Subtract(int b, int a)` returns wrong results for old callers.
- Do not change the body of an existing method unless it is a bug fix. Add a new method instead.
- Remove a method in two steps: mark it `[Obsolete]` in Vn+1, remove it in Vn+2 once no old caller remains.

Rolling upgrade (deploy new silos into the running cluster): use `BackwardCompatible` plus `AllCompatibleVersions`. Old clients reach both versions. New clients and silos only create activations on new silos.

Staging environment (both slots join the same cluster): use `BackwardCompatible` plus `MinimumVersion`. Steps: V1 runs in production; V2 silos and clients start in staging and join the same cluster with no V2 activations yet; send some traffic to V2 clients for smoke tests; on success swap, on failure stop staging (V2 activations are destroyed and V1 ones recreated); V1 activations drift to V2 silos over time; stop V1 silos. Stream pulling agents also start in staging.

Rolling upgrades across Orleans major versions are a different matter: 3.x to 7 changed the wire protocol, and 7.x to 10 is not recommended as a rolling upgrade. Deploy a new cluster, migrate state, switch traffic, retire the old cluster. See `orleans/migration`.

## Heterogeneous silos

Silos may host different sets of grain classes. All silos must reference all grain interfaces. Only silos that host a grain class reference it. A grain class must be identical on every silo that hosts it. No configuration is needed; `TypeManagementOptions.TypeMapRefreshInterval` tunes how often silos and clients refresh the type map, and `GrainClassOptions.ExcludedGrainTypes` excludes classes on a silo for tests. Limits: clients are not told when the supported set changes (calls fail with `OrleansException` or `ArgumentException`); stateless workers must exist on every silo; `[ImplicitStreamSubscription]` is not supported, use explicit stream subscriptions. Every silo in a heterogeneous cluster must configure the reminder service, even silos that host no reminders.

## Kubernetes

Package `Microsoft.Orleans.Hosting.Kubernetes` adds `siloBuilder.UseKubernetesHosting()`. It:

- sets `SiloOptions.SiloName` to the pod name and `EndpointOptions.AdvertisedIPAddress` to the pod IP;
- listens on any address using `SiloPort` and `GatewayPort` (defaults `11111` and `30000`);
- sets `ClusterOptions.ServiceId` and `ClusterId` from the pod labels `orleans/serviceId` and `orleans/clusterId`;
- at startup, and at runtime on 2 silos, queries the Kubernetes API for silos with no pod and marks them dead.

It does not replace the clustering provider. You still need Azure Table, Redis, ADO.NET, or another `IMembershipTable`.

Pod requirements: silo name equals pod name; labels `orleans/serviceId` and `orleans/clusterId`; environment variables `POD_NAME`, `POD_NAMESPACE`, `POD_IP`, `ORLEANS_SERVICE_ID`, `ORLEANS_CLUSTER_ID`. Minimal manifest fragment:

```yaml
env:
- name: ORLEANS_SERVICE_ID
  valueFrom: { fieldRef: { fieldPath: "metadata.labels['orleans/serviceId']" } }
- name: ORLEANS_CLUSTER_ID
  valueFrom: { fieldRef: { fieldPath: "metadata.labels['orleans/clusterId']" } }
- name: POD_NAMESPACE
  valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
- name: POD_NAME
  valueFrom: { fieldRef: { fieldPath: metadata.name } }
- name: POD_IP
  valueFrom: { fieldRef: { fieldPath: status.podIP } }
- name: DOTNET_SHUTDOWNTIMEOUTSECONDS
  value: "120"
```

The reference deployment also sets `containerPort: 11111` and `30000`, `terminationGracePeriodSeconds: 180`, `minReadySeconds: 60`, and a rolling update with `maxUnavailable: 0`, `maxSurge: 1`. Inject the clustering connection string from a Secret.

RBAC: the pod service account needs a `Role` with `resources: ["pods"]` and `verbs: ["get", "watch", "list", "delete", "patch"]`, bound with a `RoleBinding`. If pods crash with `KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT must be defined`, check those variables exist in the pod and that `automountServiceAccountToken` is `true`.

Probes: Orleans membership probes detect network and process failures between silos. Kubernetes liveness probes only detect a frozen process. Use a simple local liveness check. Align the startup probe window with `ClusterMembershipOptions.MaxJoinAttemptTime` so membership has time to start after a disaster. Avoid restrictive CPU limits for interactive load; understand how requests and limits are enforced before setting them.

Aspire: `Aspire.Hosting.Kubernetes` plus `builder.AddKubernetesEnvironment("k8s")` in the AppHost, then `aspire publish -o ./k8s-manifests` generates Deployments, Services, ConfigMaps, Secrets, and Helm charts; apply with `kubectl apply -f` or `helm install`.

## Docker and other containers

The Orleans docs have no standalone Docker page; container guidance sits in the Kubernetes, Container Apps, and troubleshooting pages. Rules that apply to any container host:

- Expose and map `11111` and `30000` (or your configured ports).
- Set `AdvertisedIPAddress` to an address other silos can reach; the container's own interface is usually wrong behind NAT.
- Set `DOTNET_SHUTDOWNTIMEOUTSECONDS` and the platform's grace period high enough for a graceful silo shutdown.
- Make every container reach the clustering store.
- Configure .NET garbage collection for the silo (server GC); the configuration guide marks this as important.

## Azure App Service

Silos need direct TCP between instances. On App Service: enable VNet integration; set `vnetPrivatePortsCount` to `2` (`az webapp config set ... --generic-configurations '{"vnetPrivatePortsCount": "2"}'` or `siteConfig.vnetPrivatePortsCount: 2` in Bicep); on Linux, listen on all addresses. App Service then provides `WEBSITE_PRIVATE_IP` and `WEBSITE_PRIVATE_PORTS`:

```csharp
var endpointAddress = IPAddress.Parse(builder.Configuration["WEBSITE_PRIVATE_IP"]!);
var strPorts = builder.Configuration["WEBSITE_PRIVATE_PORTS"]!.Split(',');
if (strPorts.Length < 2) throw new Exception("Insufficient private ports configured.");
var (siloPort, gatewayPort) = (int.Parse(strPorts[0]), int.Parse(strPorts[1]));

siloBuilder.ConfigureEndpoints(endpointAddress, siloPort, gatewayPort, listenOnAnyHostAddress: true);
```

The sample uses Azure Table clustering via `ORLEANS_AZURE_STORAGE_CONNECTION_STRING`, `alwaysOn: true`, and a staging slot with its own `ORLEANS_CLUSTER_ID` (`Default` versus `Staging`) kept as a slot setting. On Windows each App Service needs its own plan; Linux avoids that.

## Azure Container Apps

Recommended path: an Aspire AppHost and `aspire deploy` (preview; set `DOTNET_ASPIRE_ENABLE_DEPLOY_COMMAND=true`, `az login`, run from the AppHost directory). It provisions the Container Apps environment, ACR, Redis or Azure Storage as used by the cluster, Application Insights, and managed identities. Without Aspire: GitHub Actions builds the image, pushes to ACR, and applies Bicep with an external HTTP ingress on `targetPort: 80` and `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`. The sample runs with `minReplicas: 1`, `maxReplicas: 1`; raise these for a real cluster.

## Service Fabric

Host silos as unpartitioned stateless services with `Microsoft.ServiceFabric.Services` and `Microsoft.Orleans.Server`. Wrap the `IHost` in an `ICommunicationListener`: `OpenAsync` builds and starts the host, `CloseAsync` awaits `StopAsync`, `Abort` calls `StopAsync` with a cancelled token. Read the TCP endpoints named in `ServiceManifest.xml` and pass them to `ConfigureEndpoints(hostname, siloEndpoint.Port, gatewayEndpoint.Port)`. Use a real clustering provider, not localhost clustering.

## Graceful shutdown and silo lifecycle

Orleans runs inside the generic host and stops when the host stops. `RunConsoleAsync()` (or `UseConsoleLifetime()`) handles Ctrl+C and `SIGTERM`.

```csharp
await Host.CreateDefaultBuilder(args)
    .UseOrleans(siloBuilder => { /* configure */ })
    .RunConsoleAsync();
```

Silo lifecycle stages run in order: `First`, `RuntimeInitialize` (2000), `RuntimeServices` (4000), `RuntimeStorageServices` (6000), `RuntimeGrainServices` (8000), `ApplicationServices` (10000), `BecomeActive`, `Active` (20000), `Last`. Shutdown runs them in reverse. Hook in with `siloBuilder.AddStartupTask(async (sp, ct) => { ... }, ServiceLifecycleStage.Active)` or an `ILifecycleParticipant<ISiloLifecycle>`. The `Orleans.Runtime.SiloLifecycleSubject` logger reports which components ran at each stage and how long each took.

Related options: `SiloOptions.SiloName`, `ProcessExitHandlingOptions` (behaviour on process exit), `SiloMessagingOptions` and `ClientMessagingOptions` (`ResponseTimeout`, `CancelRequestOnTimeout`, which defaults to `false` since Orleans 10). Do not rely on `OnDeactivateAsync` to persist critical state; hosts can die without running it.

## Scaling out and in

- Add or remove silos while monitoring your SLA. New silos take new placements. Existing activations are not moved to a new silo unless a rebalancer is on.
- Default placement is `ResourceOptimizedPlacement` since Orleans 9.2 (CPU, memory, activation count weights in `ResourceOptimizedPlacementOptions`). Before 9.2 the default was `RandomPlacement`. Restore it with `siloBuilder.Services.AddSingleton<PlacementStrategy, RandomPlacement>()`.
- Activation repartitioning (8.2 experimental, 9+): `siloBuilder.AddActivationRepartitioner()` under `#pragma warning disable ORLEANSEXP001`; migrates grains next to the grains they call. Options in `ActivationRepartitionerOptions`.
- Activation rebalancing (10, experimental, `ORLEANSEXP002`): `siloBuilder.AddActivationRebalancer()` balances memory and activation count across silos. Options in `ActivationRebalancerOptions`. Needs at least 2 silos; `[Immovable]` grains are skipped. Both features can run together.
- Memory-based activation shedding (9+): `GrainCollectionOptions.EnableActivationSheddingOnMemoryPressure = true`, `MemoryUsageLimitPercentage` (80), `MemoryUsageTargetPercentage` (75), `MemoryUsagePollingPeriod` (5 s). Idle activations are also collected after `GrainCollectionOptions.CollectionAge` (default 15 minutes since 7.0; 2 hours in 3.x).
- Load shedding: gateways reject client messages when the silo is overloaded.

```csharp
siloBuilder.Configure<LoadSheddingOptions>(options =>
{
    options.LoadSheddingEnabled = true;
    options.CpuThreshold = 95;   // Orleans 10; was LoadSheddingLimit in 7.x to 9.x
});
```

- Grain directory: the default in-cluster directory is eventually consistent and partitioned by a distributed hash table; it can allow a duplicate activation while membership is unstable. Orleans 9 added a strongly consistent in-cluster directory (`siloBuilder.AddDistributedGrainDirectory()`, preview in 10). External directories keep registrations across restarts: `Microsoft.Orleans.GrainDirectory.Redis`, `.AzureStorage`, `.AdoNet` (9.2+), selected per grain class with `[GrainDirectory(GrainDirectoryName = "name")]`. Start with the default.
- The membership protocol has run with 200 silos in production; the version row can become a write bottleneck past about a thousand silos.

## Monitoring and telemetry

Logging uses `Microsoft.Extensions.Logging`; inject `ILogger<T>` into grains. Set `builder.Logging.SetMinimumLevel(LogLevel.Information)` when logs are missing.

Metrics use `System.Diagnostics.Metrics` with the meter `Microsoft.Orleans`. Orleans 7 removed the `Microsoft.Orleans.TelemetryConsumers.*` packages and `ITelemetryConsumer`. Ad hoc: `dotnet counters monitor -n <Process> --counters Microsoft.Orleans`. Export with OTLP:

```csharp
builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics => metrics
        .AddOtlpExporter(o => o.Endpoint = new Uri("http://localhost:4317"))
        .AddMeter("Microsoft.Orleans"));
```

Meter names are prefixed `orleans-` and grouped by area: `orleans-networking-sockets-*`, `orleans-messaging-*` (sent, received, rejected, expired, rerouted, dispatcher counts), `orleans-gateway-connected-clients`, `orleans-gateway-load-shedding`, `orleans-catalog-activations`, `orleans-catalog-activation-working-set`, `orleans-catalog-activation-created` and `-destroyed`, `orleans-directory-*`, `orleans-consistent-ring-*`, `orleans-watchdog-health-checks`, `orleans-app-requests-latency`, `orleans-app-requests-timedout`, `orleans-app-requests-canceled`, `orleans-reminders-tardiness`, `orleans-storage-read-latency`, `orleans-storage-write-errors`, `orleans-streams-*`, `orleans-transactions-*`, `orleans-runtime-total-physical-memory`, `orleans-runtime-available-memory`, `orleans-scheduler-long-running-turns`.

Distributed tracing: call `siloBuilder.AddActivityPropagation()` and `clientBuilder.AddActivityPropagation()` (or set `EnableDistributedTracing`), then subscribe to activity sources:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing.SetResourceBuilder(ResourceBuilder.CreateDefault().AddService("MyService", serviceVersion: "1.0"));
        tracing.AddSource(Orleans.Diagnostics.ActivitySources.ApplicationGrainActivitySourceName);
        tracing.AddSource(Orleans.Diagnostics.ActivitySources.LifecycleActivitySourceName);
        // StorageActivitySourceName, RuntimeActivitySourceName, or AllActivitySourceName for everything
        tracing.AddOtlpExporter(o => o.Endpoint = new Uri("http://localhost:4317"));
    });
```

Sources are named `Microsoft.Orleans.Application`, `Microsoft.Orleans.Lifecycle`, and so on.

Dashboard: Orleans 10 ships an official preview dashboard in `Microsoft.Orleans.Dashboard` and `Microsoft.Orleans.Dashboard.Abstractions`. Call `siloBuilder.AddDashboard()` on every silo and `app.MapOrleansDashboard(routePrefix: "/dashboard")` on an ASP.NET Core app (co-hosted with the silo, or on a client that also calls `clientBuilder.AddDashboard()`). Protect it with `.RequireAuthorization()`. `DashboardOptions`: `HideTrace`, `CounterUpdateIntervalMs` (min 1000), `HistoryLength`. `GrainProfilerOptions`: `TraceAlways`, `DeactivationTime`. `[NoProfiling]` excludes a grain. It shows silos, activations, method profiles, reminders, live logs, and grain state. For Orleans 7 to 9 use the community `OrleansContrib/OrleansDashboard` package.

## Failure handling and troubleshooting

- `SiloUnavailableException`: the target silo is gone, partitioned, or shutting down. The grain reference stays valid; retry and Orleans routes to the new activation. At client connect time it means no gateway was reachable: silos not yet started, mismatched clustering configuration, or blocked ports.
- Every grain call has a timeout. Delivery is at-most-once by default; retries are the caller's job (see `orleans/best-practices`).
- After a silo dies, its grains are reactivated on other silos lazily, on the next call.
- The membership table doubles as a diagnostic: it holds every silo, its status, suspicions, and an `IAmAlive` timestamp (written every 30 s).
- All silos and clients must share the same clustering provider and settings.

## Multi-cluster

Orleans 3.x had a multi-cluster (geo-distributed) feature. The 4.0 preview release notes, which became Orleans 7.0, list "Remove current multicluster implementation" (dotnet/orleans #6305). The Orleans 7 to 10 documentation has no multi-cluster page. Run one cluster per region and coordinate at the application level, or use blue/green clusters that share a `ServiceId`.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/index?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/kubernetes?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/deploy-to-azure-app-service?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/deploy-to-azure-container-apps?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/service-fabric?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/handling-failures?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/troubleshooting-deployments?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/grain-versioning?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/compatible-grains?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/version-selector-strategy?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/backward-compatibility-guidelines?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-versioning/deploying-new-versions-of-grains?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-placement?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/heterogeneous-silos?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/grain-directory?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/silo-lifecycle?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/monitoring/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/dashboard/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/server-configuration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/typical-configurations?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/list-of-options-classes?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/shutting-down-orleans?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/activation-collection?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/cluster-management?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/load-balancing?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/migration-guide?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/resources/best-practices?pivots=orleans-10-0
- https://github.com/dotnet/orleans/releases/tag/v4.0.0-preview1

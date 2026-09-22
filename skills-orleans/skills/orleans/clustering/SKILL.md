---
name: clustering
description: "Orleans clustering: membership and its providers, ClusterId and ServiceId, liveness tuning, gateways, the grain directory, Kubernetes. Use when you choose or configure membership, tune failure detection, debug silos or clients that cannot connect, pick a grain directory, or deploy to containers."
metadata:
  title: Orleans clustering
  tags: [orleans, dotnet, csharp, clustering, membership, imembershiptable, liveness, failure-detection, clustermembershipoptions, probes, clusterid, serviceid, gateway, adonet, sql-server, postgresql, azure-table, cosmos, dynamodb, consul, zookeeper, redis, cassandra, grain-directory, kubernetes, docker, containers, silo]
  related: [orleans, orleans/hosting, orleans/placement, orleans/deployment, orleans/persistence, orleans/testing, orleans/best-practices]
  version: 1
---
# Orleans clustering

## What clustering does

Cluster membership is the protocol by which all silos agree on the set of live silos, detect failed silos, and admit new ones. Clients use the same data to find gateways. Membership is the base layer for placement, the grain directory, and reminders, so a wrong clustering setup shows up as "grains not found", duplicate activations, or clients that cannot connect.

Two parts work together:

1. **`IMembershipTable`**: a flat, durable table in an external store. It is the rendezvous point (silos and clients read it to find silos) and the place where the membership view and votes are stored with optimistic concurrency. This is what a *clustering provider* implements.
2. **Peer-to-peer probing**: silos send heartbeats directly to each other over the same TCP connections used for grain traffic. Failure detection never goes through the table, so table latency or outages do not cause false death declarations.

## The membership protocol

1. On start, a silo writes its own row keyed by `ip:port:epoch` (epoch is the start time in ticks) under the cluster's `ClusterId`. Before joining, it validates two-way connectivity to every active silo; if one does not answer, the new silo is not allowed to join.
2. Each silo probes a fixed set of successor silos on a consistent-hash ring. In Orleans 9 and 10 each silo is monitored by 10 others (3 in Orleans 7 and 8).
3. After `NumMissedProbesLimit` missed probes (default 3, probes every 10 seconds) the monitor writes a suspicion into the target's row.
4. When `NumVotesForDeathDeclaration` suspicions (default 2) land within `DeathVoteExpirationTimeout` (default 3 minutes), the last voter marks the silo `Dead` and broadcasts a snapshot of the table. Typical detection time is about 15 seconds.
5. Every silo also reads the whole table periodically as a fallback and bumps a monotonic table version on every write, so all silos see a totally ordered sequence of views.
6. A silo declared dead stays dead, even if it was only partitioned. When it reads its own `Dead` status it terminates its process. Something outside Orleans (systemd, Kubernetes, a service manager) must restart it; it rejoins with a new epoch.
7. Each silo refreshes an `IAmAlive` timestamp in its row every 30 seconds. It is for diagnostics and for disaster recovery: at startup, silos whose timestamp is `NumMissedTableIAmAliveLimit` (default 3) periods stale are skipped during the connectivity check and cleaned up.
8. If the table is unreachable, live silos keep working. Nobody can be declared dead and nobody can join until it returns. Accuracy is preserved; completeness is delayed.

Orleans 9 and 10 add two Lifeguard-derived features: self-monitoring (an unhealthy silo, for example one with thread pool starvation, gets longer probe timeouts and is less likely to vote out healthy silos) and indirect probing (before the final vote, a monitor asks a third silo to probe the target; a negative acknowledgement from a healthy intermediary counts as both votes).

The protocol tolerates any number of failures, including a full restart, because agreement is delegated to the store's concurrency control rather than to a quorum. It has run with 200 silos in production; write serialization through the version row is the limit past about a thousand.

## Liveness tuning

```csharp
silo.Configure<ClusterMembershipOptions>(options =>
{
    options.NumProbedSilos = 10;                                     // silos monitoring each silo
    options.ProbeTimeout = TimeSpan.FromSeconds(10);                 // interval and timeout of a probe
    options.NumMissedProbesLimit = 3;                                // misses before a suspicion
    options.NumVotesForDeathDeclaration = 2;                         // suspicions needed
    options.DeathVoteExpirationTimeout = TimeSpan.FromSeconds(180);  // suspicion validity window
    options.NumMissedTableIAmAliveLimit = 3;                         // stale IAmAlive periods to ignore a silo
    options.DefunctSiloExpiration = TimeSpan.FromDays(7);            // cleanup of old dead rows
});
```

The defaults were tuned on Azure production workloads. Raise `ProbeTimeout` on high-latency cross-region links. Lower `DeathVoteExpirationTimeout` for faster detection at the cost of more false positives. Do not shrink probe counts on clusters that run near CPU saturation; a starved thread pool is the usual cause of spurious deaths, and the fix is capacity, not shorter timeouts.

## ClusterId and ServiceId

```csharp
silo.Configure<ClusterOptions>(o => { o.ClusterId = "orders-blue"; o.ServiceId = "orders"; });
```

- `ClusterId` partitions the membership table. Only silos and clients with the same `ClusterId` (and the same store) see each other. Give each blue/green deployment its own `ClusterId`; keep it fixed for rolling upgrades.
- `ServiceId` names the application. Storage, reminders, and directories key their data by it, so several clusters can share one `ServiceId` and one database. Never change it once data exists.
- Both default to `"default"`. Set them explicitly on every silo and client.

## Clustering providers

| Provider | Package | Silo call | Client call |
|---|---|---|---|
| Localhost (dev) | built in | `UseLocalhostClustering()` | `UseLocalhostClustering()` |
| Development (one primary silo) | built in | `UseDevelopmentClustering(primaryEndpoint)` | `UseStaticClustering(gatewayEndpoints)` |
| ADO.NET (SQL Server, PostgreSQL, MySQL/MariaDB, Oracle) | `Microsoft.Orleans.Clustering.AdoNet` | `UseAdoNetClustering(o => ...)` | `UseAdoNetClustering(o => ...)` |
| Azure Table Storage | `Microsoft.Orleans.Clustering.AzureStorage` | `UseAzureStorageClustering(o => ...)` | `UseAzureStorageClustering(o => ...)` |
| Azure Cosmos DB | `Microsoft.Orleans.Clustering.Cosmos` | `UseCosmosClustering(o => ...)` | `UseCosmosGatewayListProvider(o => ...)` |
| AWS DynamoDB | `Microsoft.Orleans.Clustering.DynamoDB` | `UseDynamoDBClustering(o => ...)` | `UseDynamoDBClustering(o => ...)` |
| HashiCorp Consul | `Microsoft.Orleans.Clustering.Consul` | `UseConsulSiloClustering(o => ...)` | `UseConsulClientClustering(o => ...)` |
| Apache ZooKeeper | `Microsoft.Orleans.Clustering.ZooKeeper` | `UseZooKeeperClustering(o => ...)` | `UseZooKeeperClustering(o => ...)` |
| Redis | `Microsoft.Orleans.Clustering.Redis` | `UseRedisClustering(...)` | `UseRedisClustering(...)` |
| Apache Cassandra | `Microsoft.Orleans.Clustering.Cassandra` | `UseCassandraClustering(...)` | `UseCassandraClustering(...)` |

The store must be durable. A Redis without persistence, or an in-memory table, can lose the membership view and take the cluster down. The in-memory development table is a system grain on a designated primary silo; it is not for production.

### Localhost and development clustering

```csharp
silo.UseLocalhostClustering();                              // one silo, loopback, 11111/30000
silo.UseLocalhostClustering(siloPort: 11_112, gatewayPort: 30_001,
    primarySiloEndpoint: new IPEndPoint(IPAddress.Loopback, 11_111)); // second local silo
```

For a test cluster on several machines without a database, designate one silo as primary with `UseDevelopmentClustering(new IPEndPoint(primaryIp, 11_111))` on every silo and `UseStaticClustering(gateways)` on clients. If the primary dies the cluster is gone.

### ADO.NET

Run the SQL scripts from the Orleans repository (`src/AdoNet/Shared`, for example `CreateOrleansTables_SqlServer.sql`, `CreateOrleansTables_PostgreSql.sql`, `CreateOrleansTables_MySql.sql`) before the first start. Then:

```csharp
silo.UseAdoNetClustering(options =>
{
    options.Invariant = "Microsoft.Data.SqlClient"; // Orleans 10; "System.Data.SqlClient" on Orleans 7 to 9
    options.ConnectionString = connectionString;    // "Npgsql" for PostgreSQL, "MySql.Data.MySqlClient" for MySQL
});
```

The client uses the same call. The row key is `deploymentId, ip, port, epoch`; ETags come from `ROWVERSION` on SQL Server.

### Azure Table Storage

```csharp
silo.UseAzureStorageClustering(options =>
{
    options.ConfigureTableServiceClient(
        new Uri("https://<account>.table.core.windows.net"),
        new DefaultAzureCredential());        // or ConfigureTableServiceClient(connectionString)
});
```

The partition key is the cluster id and the row key is `ip:port:epoch`; batch transactions give multi-row atomicity.

### Azure Cosmos DB

```csharp
silo.UseCosmosClustering(options =>
{
    options.ConfigureCosmosClient("https://<account>.documents.azure.com:443/", new DefaultAzureCredential());
    options.DatabaseName = "Orleans";            // default
    options.ContainerName = "OrleansCluster";    // default
    options.IsResourceCreationEnabled = true;    // create database and container if missing
});

client.UseCosmosGatewayListProvider(options =>
    options.ConfigureCosmosClient("https://<account>.documents.azure.com:443/", new DefaultAzureCredential()));
```

### Redis

```csharp
silo.UseRedisClustering("localhost:6379");
silo.UseRedisClustering(options =>
{
    options.ConfigurationOptions = new ConfigurationOptions { EndPoints = { "localhost:6379" }, AbortOnConnectFail = false };
});
```

`RedisClusteringOptions` also has `EntryExpiry` (only for ephemeral test environments), `CreateMultiplexer`, and `CreateRedisKey` (default key `{ServiceId}/members/{ClusterId}`). Enable Redis persistence.

### Consul, ZooKeeper, Cassandra

- Consul: `UseConsulSiloClustering` on silos and `UseConsulClientClustering` on clients, given the agent address. It uses the KV store with check-and-set under the `orleans/` prefix. Consul KV has no atomic multi-key update, so only the basic membership protocol is supported (no extended table-version protocol), and KV is not replicated across Consul datacenters.
- ZooKeeper: the deployment id is the root node, each silo a child node `ip:port@epoch`, with node versions for concurrency and `multi` for transactions. Good on-premises when you already run ZooKeeper.
- Cassandra: `UseCassandraClustering(connectionString: "Contact Points=host;Port=9042", keyspace: "orleans")` or an options overload with `UseCassandraTtl` (rows expire after `DefunctSiloExpiration` even when the cluster is down) and `InitializeRetryMaxDelay`. Lightweight transactions on a static version column give the ordering.

### Aspire

With Aspire the AppHost declares `builder.AddOrleans("cluster").WithClustering(redisOrTablesOrCosmos)`, the silo calls the matching `AddKeyedRedisClient` / `AddKeyedAzureTableServiceClient` / `AddKeyedAzureCosmosClient` and then `builder.UseOrleans()` with no arguments. Cosmos through Aspire covers clustering only; storage and reminders still need manual configuration.

## Gateways

Every silo runs a gateway on its gateway port (default 30000) unless configured otherwise. An external client reads the membership table through its clustering provider to get the gateway list, connects to all gateways in parallel, and spreads requests across them. `GatewayOptions.GatewayListRefreshPeriod` sets how often the list is refreshed. `UseStaticClustering(IPEndPoint[])` bypasses the table with a fixed gateway list. Co-hosted clients inside a silo do not use gateways at all.

Firewall rules: silo port open between silos; gateway port open from clients to silos. Clients never need the silo port.

## The grain directory

The grain directory maps a grain identity to the silo hosting its current activation. It is what enforces "at most one activation".

| Directory | Package | Notes |
|---|---|---|
| Distributed in-cluster (default) | built in | A DHT partitioned across silos with consistent hashing. Lookups are cached locally. Since Orleans 9 it is the strongly consistent, virtual-synchrony design with 30 virtual nodes per silo, versioned range locks during view changes, and automatic recovery after a crash. Registrations are lost when the whole cluster restarts. |
| Strongly consistent in-cluster (explicit) | built in | `AddDistributedGrainDirectory()` as default or `AddDistributedGrainDirectory("name")`. Prevents duplicate activations during membership changes. Documented as preview in Orleans 10. |
| Redis | `Microsoft.Orleans.GrainDirectory.Redis` | `AddRedisGrainDirectory("name", o => o.ConfigurationOptions = ...)`. Registrations survive a full cluster restart. |
| Azure Table | `Microsoft.Orleans.GrainDirectory.AzureStorage` | `AddAzureTableGrainDirectory("name", o => o.ConnectionString = ...)`. |
| ADO.NET | `Microsoft.Orleans.GrainDirectory.AdoNet` | `UseAdoNetGrainDirectoryAsDefault(o => ...)` or `AddAdoNetGrainDirectory("name", o => ...)` with `Invariant` and `ConnectionString`. Needs the SQL scripts. Orleans 9 and later. |

Assign a named directory per grain class:

```csharp
[GrainDirectory(GrainDirectoryName = "redis-directory")]
public sealed class SessionGrain : Grain, ISessionGrain { }

silo.AddRedisGrainDirectory("redis-directory", options => options.ConfigurationOptions = redisConfig);
```

Guidance from the docs: start with the default. Move a few long-lived, expensive-to-activate grain types to a storage-backed directory when you need a stronger single-activation guarantee, want fewer deactivations when a silo shuts down, or need registrations to survive a full restart. Stateless workers are not registered in any directory. You can implement `IGrainDirectory` yourself and register it for custom backends.

## Kubernetes

Add `Microsoft.Orleans.Hosting.Kubernetes` and call `silo.UseKubernetesHosting()`. It:

- sets `SiloOptions.SiloName` to the pod name and `EndpointOptions.AdvertisedIPAddress` to the pod IP;
- listens on any address using the configured `SiloPort` and `GatewayPort` (11111 and 30000 if unset);
- reads `ClusterOptions.ServiceId` and `ClusterId` from the pod labels `orleans/serviceId` and `orleans/clusterId`;
- at startup, and continuously from two silos, asks the Kubernetes API which silos have no pod and marks them dead, which speeds recovery after pod loss.

It does not replace a clustering provider. You still need Azure Table, ADO.NET, Redis, or another store.

Deployment requirements:

- Pod labels `orleans/serviceId` and `orleans/clusterId`.
- Environment variables `POD_NAME`, `POD_NAMESPACE`, `POD_IP` (from `fieldRef`), `ORLEANS_SERVICE_ID`, `ORLEANS_CLUSTER_ID` (from the labels).
- Container ports 11111 and 30000.
- A `Role` on `pods` with verbs `get, watch, list, delete, patch` bound to the pod's service account, and `automountServiceAccountToken: true`. The error `KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT must be defined` means the in-cluster config is missing.
- `DOTNET_SHUTDOWNTIMEOUTSECONDS` (for example `120`) and `terminationGracePeriodSeconds` (for example `180`) so a silo can leave the cluster and deactivate grains on rollout.
- Rolling update with `maxUnavailable: 0`, `maxSurge: 1`, and a `minReadySeconds` so membership settles between pods.

Kubernetes liveness probes and Orleans probes are complementary: keep the Kubernetes probe a cheap local check that catches a frozen process; let Orleans detect connectivity failures. Be careful with CPU limits; throttling makes a silo look dead to its peers.

Since Orleans 8, Aspire can generate the manifests: add `Aspire.Hosting.Kubernetes`, call `builder.AddKubernetesEnvironment("k8s")` in the AppHost, and run `aspire publish -o ./k8s-manifests`.

## Docker and other containers

There is no container-specific package. The same rules apply as for any NAT:

- Advertise the address other silos can reach (`EndpointOptions.AdvertisedIPAddress`) and bind on `IPAddress.Any` with `SiloListeningEndpoint` and `GatewayListeningEndpoint` if the container port differs from the published port.
- Publish or route both the silo port and the gateway port. Silos must reach each other's advertised silo endpoint; a silo that cannot be reached is voted dead.
- Use a shared durable membership store; localhost clustering cannot span containers.
- Pass `ClusterId` and `ServiceId` through environment variables or configuration so all replicas agree.
- Give the container a shutdown grace period and set `DOTNET_SHUTDOWNTIMEOUTSECONDS` so `SIGTERM` leads to a graceful leave.

## Troubleshooting

- Silos do not see each other: different `ClusterId`, different store, or the advertised silo endpoint is unreachable. Read the membership table directly; the rows show status, suspicions, and `IAmAlive`.
- A new silo refuses to start: it could not reach an active silo listed in the table. Stale rows from crashed silos are skipped after three missed `IAmAlive` periods; before that, delete them or wait.
- Clients cannot connect: wrong `ClusterId` or clustering provider, gateway port closed, or the table lists private IPs the client cannot route to.
- Silos keep getting voted dead under load: check thread pool starvation and CPU throttling before touching `ClusterMembershipOptions`.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/cluster-management?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/server-configuration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/client-configuration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/typical-configurations?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/local-development-configuration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/list-of-options-classes?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/grain-directory?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/grain-directory?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/kubernetes?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/consul-deployment?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/deployment/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/resources/nuget-packages?pivots=orleans-10-0

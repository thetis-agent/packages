---
name: persistence
description: "Orleans 10 grain persistence: IPersistentState<T> injected with [PersistentState(name, storeName)], ReadStateAsync, WriteStateAsync, ClearStateAsync, RecordExists, Etag and InconsistentStateException, the legacy Grain<TState> base with [StorageProvider], several named state objects per grain, storage providers and how to register them (AddMemoryGrainStorage, AddMemoryGrainStorageAsDefault, AddAdoNetGrainStorage, AddAzureBlobGrainStorage, AddAzureTableGrainStorage, AddCosmosGrainStorage, AddDynamoDBGrainStorage, AddRedisGrainStorage), IGrainStorageSerializer and the Newtonsoft.Json default, writing a custom IGrainStorage provider, state versioning, and the failure modes of read and write. Use when a grain must keep state across activations, when choosing or configuring a storage provider, when a write throws InconsistentStateException, or when state types must evolve without losing stored data."
metadata:
  title: Orleans grain persistence
  tags: [orleans, dotnet, csharp, persistence, state, ipersistentstate, storage, grainstorage, etag, adonet, azure, cosmos, dynamodb, redis, serialization]
  related: [orleans, orleans/grains, orleans/hosting, orleans/serialization, orleans/transactions, orleans/testing, orleans/best-practices]
  version: 1
---
# Orleans grain persistence

## Model

A grain can own zero or more named state objects. Orleans loads each one from storage when the grain activates. The grain decides when to write. Persistence is a plugin model: a storage provider decides how state is stored. Orleans does not ship an ORM. A grain can also talk to a database directly and skip this model.

Goals stated by the docs:

- Several named state objects per grain, each in its own store.
- Several configured providers, each with its own settings and backend.
- Providers have full control of the on-disk shape.

Packages that Microsoft maintains:

| Package | Backend |
| --- | --- |
| `Microsoft.Orleans.Persistence.Memory` | in-memory, development only |
| `Microsoft.Orleans.Persistence.AdoNet` | SQL Server, MySQL/MariaDB, PostgreSQL, Oracle |
| `Microsoft.Orleans.Persistence.AzureStorage` | Azure Blob Storage and Azure Table Storage |
| `Microsoft.Orleans.Persistence.Cosmos` | Azure Cosmos DB for NoSQL |
| `Microsoft.Orleans.Persistence.DynamoDB` | Amazon DynamoDB |
| `Microsoft.Orleans.Persistence.Redis` | Redis |

## The API

`IPersistentState<TState>` is the grain-facing interface (Orleans 7 and later):

```csharp
public interface IPersistentState<TState> : IStorage<TState> { }

public interface IStorage<TState> : IStorage
{
    TState State { get; set; }
}

public interface IStorage
{
    string Etag { get; }
    bool RecordExists { get; }
    Task ClearStateAsync();
    Task WriteStateAsync();
    Task ReadStateAsync();
}
```

- `State`: the in-memory copy. Change it freely. Nothing is written until you call `WriteStateAsync()`.
- `ReadStateAsync()`: reload from storage. The in-memory copy is replaced when the task completes. Not needed in normal operation. Use it to pick up changes made outside the grain.
- `WriteStateAsync()`: persist the current `State`. Orleans conceptually takes a deep copy for the write.
- `ClearStateAsync()`: clear the state in storage. Whether the record is deleted depends on the provider (see `DeleteStateOnClear` below).
- `RecordExists`: `true` when a record was found in storage at the last read or write. Use it to tell "never written" from "written with default values".
- `Etag`: opaque provider-specific version string. `null` when the provider does not use etags.

## Declare state and inject it

Mark the state type with `[GenerateSerializer]` and give each member an `[Id]`. The default storage serializer is JSON, but grain-call serialization and some providers use the Orleans serializer, so the attributes are needed anyway.

```csharp
[GenerateSerializer]
public sealed class ProfileState
{
    [Id(0)] public string Name { get; set; } = "";
    [Id(1)] public DateOnly DateOfBirth { get; set; }
}

[GenerateSerializer]
public sealed class CartState
{
    [Id(0)] public List<string> Items { get; set; } = [];
}
```

Inject one `IPersistentState<T>` per state object. The attribute names the state and the provider:

```csharp
public sealed class UserGrain(
    [PersistentState("profile", "profileStore")] IPersistentState<ProfileState> profile,
    [PersistentState("cart", "cartStore")] IPersistentState<CartState> cart)
    : Grain, IUserGrain
{
    public Task<string> GetNameAsync() => Task.FromResult(profile.State.Name);

    public async Task SetNameAsync(string name)
    {
        profile.State.Name = name;
        await profile.WriteStateAsync();
    }

    public async Task AddItemAsync(string item)
    {
        cart.State.Items.Add(item);
        await cart.WriteStateAsync();
    }
}
```

Rules:

- `[PersistentState(stateName, storageName)]`. The second argument selects a named provider. Omit it to use the provider registered as default.
- Do not touch `State` in the constructor. It is not loaded yet. It is loaded before `OnActivateAsync` runs.
- Two grain types can use two different provider instances of the same kind (for example two Azure Table providers on two accounts).
- Each state object has its own etag and its own read and write. There is no transaction across them. Use `orleans/transactions` when you need atomic multi-state updates.

## Register providers on the silo

```csharp
var builder = Host.CreateApplicationBuilder(args);

builder.UseOrleans(silo =>
{
    silo.UseLocalhostClustering();

    // Development: in memory, lost on restart.
    silo.AddMemoryGrainStorage("profileStore");
    silo.AddMemoryGrainStorageAsDefault();      // used when no store name is given

    // Production examples follow.
});

using var host = builder.Build();
await host.RunAsync();
```

Every provider has an `Add<X>GrainStorage(name, configureOptions)` and an `Add<X>GrainStorageAsDefault(configureOptions)` form. The default provider is registered under the name `"Default"`.

### ADO.NET (relational)

```csharp
silo.AddAdoNetGrainStorage("OrleansStorage", options =>
{
    options.Invariant = "Microsoft.Data.SqlClient";   // or Npgsql, MySql.Data.MySqlClient, Oracle.ManagedDataAccess.Client
    options.ConnectionString = builder.Configuration.GetConnectionString("Orleans");
});
```

Before it works: load the ADO.NET provider library into the process, set `Invariant`, and run the vendor script that creates the `OrleansStorage` table and the `OrleansQuery` table. The scripts ship with the package. Options class: `AdoNetGrainStorageOptions` (`ConnectionString`, `Invariant`, `InitStage`, `GrainStorageSerializer`, `HashPicker`). The ADO.NET provider is designed to let you change the queries in `OrleansQuery` at run time, keep vendor-specific tuning, and stay shardable (no `IDENTITY` columns). Its version column is a signed 32-bit integer that Orleans exposes as the etag.

### Azure Blob and Azure Table

Use `TokenCredential` with a service URI. Connection strings are still accepted but carry secrets.

```csharp
silo.AddAzureTableGrainStorage("profileStore", options =>
{
    options.ConfigureTableServiceClient(
        new Uri("https://<account>.table.core.windows.net"),
        new DefaultAzureCredential());
});

silo.AddAzureBlobGrainStorage("cartStore", options =>
{
    options.ConfigureBlobServiceClient(
        new Uri("https://<account>.blob.core.windows.net"),
        new DefaultAzureCredential());
});
```

Table storage stores state in one row and splits it over several columns when it is too large for one. A row holds at most 1 MB. Use Blob storage for larger state. Options classes: `AzureTableStorageOptions`, `AzureBlobStorageOptions`. You can also set `options.TableServiceClient` or `options.BlobServiceClient` to a client you built yourself.

### Azure Cosmos DB

```csharp
silo.AddCosmosGrainStorage("cosmos", options =>
{
    options.ConfigureCosmosClient(
        "https://myaccount.documents.azure.com:443/",
        new DefaultAzureCredential());
    options.DatabaseName = "Orleans";            // default
    options.ContainerName = "OrleansStorage";    // default
    options.IsResourceCreationEnabled = true;    // create database and container if missing
});
```

`CosmosGrainStorageOptions` also has `DeleteStateOnClear` (default `false`), `StateFieldsToIndex`, `PartitionKeyPath` (default `/PartitionKey`), `DatabaseThroughput`, `ContainerThroughputProperties`, `ClientOptions`, `InitStage`. The grain id is the partition key by default. Implement `IPartitionKeyProvider` and register with `AddCosmosGrainStorage<MyPartitionKeyProvider>(...)` to change that.

### Amazon DynamoDB

```csharp
silo.AddDynamoDBGrainStorage("profileStore", options =>
{
    options.Service = "us-west-2";
    // Leave AccessKey and SecretKey unset to use the AWS SDK credential chain.
    // options.ProfileName, options.Token are available for explicit SDK setup.
});
```

Options class: `DynamoDBStorageOptions` (has `GrainStorageSerializer`).

### Redis

```csharp
silo.AddRedisGrainStorage("redis", options =>
{
    options.ConfigurationOptions = new ConfigurationOptions
    {
        EndPoints = { "localhost:6379" },
        AbortOnConnectFail = false
    };
});
```

`RedisStorageOptions`: `ConfigurationOptions` (required, StackExchange.Redis), `DeleteStateOnClear` (default `false`), `EntryExpiry` (leave `null` outside tests; expiry can cause duplicate activations), `GrainStorageSerializer` (defaults to the Orleans serializer for this provider), `CreateMultiplexer`, `GetStorageKey` (default key `{ServiceId}/state/{grainId}/{grainType}`).

### Aspire

With Aspire, the AppHost declares the resource and the silo calls `builder.AddKeyed<X>Client("name")` then `builder.UseOrleans()` with no provider code. Orleans resolves the provider by keyed service name. Skipping the `AddKeyed*` call gives a dependency resolution error at start.

```csharp
// AppHost
var blobs = builder.AddAzureStorage("storage").AddBlobs("grainstate");
var orleans = builder.AddOrleans("cluster")
    .WithClustering(builder.AddRedis("redis"))
    .WithGrainStorage("Default", blobs);

// Silo
builder.AddKeyedAzureBlobServiceClient("grainstate");
builder.UseOrleans();
```

## Serializer for stored state

Since Orleans 7.0 every supported provider exposes `IStorageProviderSerializerOptions.GrainStorageSerializer` on its options class. The default is `Newtonsoft.Json` (`JsonGrainStorageSerializer`). The Redis provider defaults to the Orleans binary serializer instead. Pick a version-tolerant format for stored data: the docs recommend JSON or Protobuf. The generated Orleans serializer is fast for grain calls but is not built to be explicitly version tolerant.

Replace the serializer through the options builder overload:

```csharp
silo.Services.AddSingleton<IGrainStorageSerializer, MyCustomSerializer>();

silo.AddAzureBlobGrainStorage("MyGrainStorage",
    (OptionsBuilder<AzureBlobStorageOptions> ob) =>
        ob.Configure<IGrainStorageSerializer>(
            (options, serializer) => options.GrainStorageSerializer = serializer));
```

`IGrainStorageSerializer` (namespace `Orleans.Storage`) has two members: `BinaryData Serialize<T>(T? input)` and `T? Deserialize<T>(BinaryData input)`. `IGrainStorageStreamingSerializer` adds stream-based `SerializeAsync` and `DeserializeAsync` for providers that stream large blobs. Orleans 10 also ships a `System.Text.Json` implementation: call `silo.UseSystemTextJsonGrainStorageSerializer()` to make it the default for every provider, and configure it with `SystemTextJsonGrainStorageSerializerOptions`. Before Orleans 7 each provider had its own `UseJson` or `UseJsonFormat` flag. Those flags are gone.

## Legacy: Grain<TState>

Still supported, but the docs call it legacy. Prefer `IPersistentState<T>`.

```csharp
[StorageProvider(ProviderName = "store1")]
public class MyGrain : Grain<MyGrainState>, IMyGrain
{
    public async Task DoSomethingAsync()
    {
        State.Counter++;
        await WriteStateAsync();   // protected ReadStateAsync / WriteStateAsync / ClearStateAsync
    }
}
```

`Grain<T>` gives one state object only. Its `[StorageProvider]` attribute names the provider; without it the default provider is used.

## Etags and InconsistentStateException

A provider may store an etag with the record. On write it compares the etag in memory with the one in storage. On mismatch the write task faults with `InconsistentStateException` (an `OrleansException`) that wraps the storage exception and exposes `StoredEtag` and `CurrentEtag`. The docs call this a transient error.

When it happens the in-memory state is stale. Typical handling:

```csharp
public async Task IncrementAsync()
{
    try
    {
        _state.State.Counter++;
        await _state.WriteStateAsync();
    }
    catch (InconsistentStateException)
    {
        // Someone else wrote this record. Reload and let the caller retry.
        await _state.ReadStateAsync();
        throw;
    }
}
```

Two activations of one grain writing the same record is the usual cause (for example during a silo failure and re-activation). The etag check is what keeps the last write from silently overwriting. Do not swallow the exception and write again without a reload.

## Failure modes

Read at activation:

- If the initial read fails, activation fails. `OnActivateAsync` is not called. The request that triggered the activation faults back to the caller.
- A missing or bad provider configuration at silo start means the grain cannot load. Calls to it get the permanent error `BadProviderConfigException`.
- An explicit `ReadStateAsync()` that fails throws from that task. The grain may handle it.

Write:

- A failed `WriteStateAsync()` throws from the task. If the grain method awaits it, the exception reaches the caller.
- A grain that handles a write error must catch it and not rethrow. That signals the error was handled.
- After a failed write the in-memory state may differ from storage. Decide whether to reload or retry.

Clear:

- `ClearStateAsync()` behaviour depends on `DeleteStateOnClear`. With `false` (default on Cosmos and Redis) the record stays with empty content and `RecordExists` may remain `true`.

## Custom storage provider

Implement `IGrainStorage` (namespace `Orleans.Storage`):

```csharp
public interface IGrainStorage
{
    Task ReadStateAsync<T>(string stateName, GrainId grainId, IGrainState<T> grainState);
    Task WriteStateAsync<T>(string stateName, GrainId grainId, IGrainState<T> grainState);
    Task ClearStateAsync<T>(string stateName, GrainId grainId, IGrainState<T> grainState);
}
```

`IGrainState<T>` carries `State`, `ETag` and `RecordExists`. Set `ETag` on read; check it on write; throw `InconsistentStateException` on mismatch. Any other failure must fault the task with an exception that describes the storage issue. Convert provider-specific exception types into types the caller can deserialize; a client may not have the persistence assembly loaded.

Register it with the `AddGrainStorage` helper from `Orleans.Hosting` (`StorageProviderHostExtensions`). It adds a keyed `IGrainStorage` singleton under the name, wires the default alias when the name is `"Default"`, and registers the provider as a silo lifecycle participant if it implements `ILifecycleParticipant<ISiloLifecycle>`:

```csharp
public static class MyStorageSiloBuilderExtensions
{
    public static ISiloBuilder AddMyGrainStorage(this ISiloBuilder silo, string name,
        Action<OptionsBuilder<MyStorageOptions>>? configureOptions = null)
    {
        return silo.ConfigureServices(services =>
        {
            configureOptions?.Invoke(services.AddOptions<MyStorageOptions>(name));
            services.ConfigureNamedOptionForLogging<MyStorageOptions>(name);
            services.AddGrainStorage(name, (sp, key) =>
                ActivatorUtilities.CreateInstance<MyGrainStorage>(sp, key,
                    sp.GetRequiredService<IOptionsMonitor<MyStorageOptions>>().Get(key)));
        });
    }

    public static ISiloBuilder AddMyGrainStorageAsDefault(this ISiloBuilder silo,
        Action<OptionsBuilder<MyStorageOptions>>? configureOptions = null)
        => silo.AddMyGrainStorage("Default", configureOptions);
}
```

Orleans resolves `IGrainStorage` from the service provider by the name given in `[PersistentState]`. The built-in providers follow the same shape; the docs point at `AzureBlobGrainStorage` and `AzureTableSiloBuilderExtensions` in the Orleans repo as reference implementations. Make your options class implement `IStorageProviderSerializerOptions` and add `DefaultStorageProviderSerializerOptionsConfigurator<MyStorageOptions>` as an `IPostConfigureOptions` so the shared `IGrainStorageSerializer` is picked up. Older docs mention `AddSingletonNamedService`; keyed services replaced it in Orleans 8.

## State versioning

- Prefer additive changes: add properties with new `[Id]` values and sensible defaults. Do not renumber or reuse ids.
- With JSON storage, removed properties are ignored on read and new properties get defaults. Renaming a property loses its stored value unless you map it.
- Never change the inheritance chain of a stored type; the Orleans serializer versioning rules forbid adding, changing or removing a base class.
- Numeric widening (`int` to `long`) is allowed by the Orleans serializer; sign changes are not.
- For breaking changes, read the old shape into a new state name, convert, write the new one, then clear the old one. Two `IPersistentState<T>` injections in the same grain make this easy.
- Keep a `Version` integer in the state so a grain can upgrade lazily on first activation.
- The ADO.NET provider can change format on round trip and shape the type on read, but that path is not exposed to application code.

## Checklist

1. Register at least one provider, or mark one as default, before any grain with `[PersistentState]` activates.
2. Put `[GenerateSerializer]` and `[Id(n)]` on every state type and nested type.
3. Write only after a successful change; keep writes small and infrequent.
4. Handle `InconsistentStateException` by reloading.
5. Use in-memory storage only in tests. It is lost on restart.
6. Configure the same providers on every silo in a heterogeneous cluster.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-persistence/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-persistence/relational-storage?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-persistence/azure-storage?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-persistence/azure-cosmos-db?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-persistence/dynamodb-storage?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/serialization?pivots=orleans-10-0

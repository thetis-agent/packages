---
name: testing
description: "Testing Orleans grains on Orleans 7 through 10: the Microsoft.Orleans.TestingHost package, InProcessTestCluster and InProcessTestClusterBuilder (recommended since Orleans 9) with ConfigureSilo, ConfigureClient and ConfigureHost delegates, the older TestCluster and TestClusterBuilder with ISiloConfigurator, IClientBuilderConfigurator and IHostConfigurator, TestClusterOptions (InitialSilosCount, GatewayPerSilo), sharing one cluster across xUnit tests with IClassFixture or ICollectionFixture, Cluster.Client.GetGrain, in-memory providers for tests (AddMemoryGrainStorage, AddMemoryStreams, UseInMemoryReminderService, AddFaultInjectionMemoryStorage), stopping and killing silos to test failover, grain call filters in tests, unit testing grains without a cluster using IGrainBase and IGrainContext or Moq, the OrleansTestKit package, and debugging tips such as ResponseTimeoutWithDebugger. Use when writing grain tests, building a test fixture, simulating silo failures, or isolating a grain from the runtime."
metadata:
  title: Orleans testing
  tags: [orleans, dotnet, csharp, testing, unit-test, xunit, testcluster, inprocesstestcluster, testinghost, fixture, moq, testkit, memory-storage, failover, debugging]
  related: [orleans, orleans/grains, orleans/hosting, orleans/persistence, orleans/streams, orleans/timers-reminders, orleans/transactions, orleans/clustering]
  version: 1
---

# Orleans testing

There are two ways to test a grain:

1. Run it in a real in-process cluster from `Microsoft.Orleans.TestingHost`. This exercises scheduling, serialization, placement and persistence for real. Use it for most tests.
2. Construct the grain class directly and mock what it touches. Fast, but the single-threaded execution model, reentrancy rules and deep copying are absent. Use it for pure logic.

Package for the first approach: `Microsoft.Orleans.TestingHost`. It contains `InProcessTestCluster` (Orleans 9 and 10, recommended) and `TestCluster` (all versions since 7).

## InProcessTestCluster (Orleans 9 and 10)

`InProcessTestClusterBuilder` configures silos and clients with delegates. No configurator classes. Test code and the silo share the same service instances, so a mock registered in `ConfigureHost` is the same object the grain receives.

```csharp
using Orleans.TestingHost;
using Xunit;

public class HelloGrainTests : IAsyncLifetime
{
    private InProcessTestCluster _cluster = null!;

    public async Task InitializeAsync()
    {
        var builder = new InProcessTestClusterBuilder();
        _cluster = builder.Build();
        await _cluster.DeployAsync();
    }

    public async Task DisposeAsync() => await _cluster.DisposeAsync();

    [Fact]
    public async Task SaysHello()
    {
        var grain = _cluster.Client.GetGrain<IHelloGrain>(0);
        var result = await grain.SayHello("World");
        Assert.Equal("Hello, World!", result);
    }
}
```

Builder members:

- `new InProcessTestClusterBuilder()` or `new InProcessTestClusterBuilder(initialSilosCount: 2)`.
- `ConfigureSilo(Action<InProcessTestSiloSpecificOptions, ISiloBuilder>)`: per-silo `ISiloBuilder` configuration (storage, streams, reminders, filters).
- `ConfigureSiloHost(Action<InProcessTestSiloSpecificOptions, IHostApplicationBuilder>)`: the silo's host builder (services, configuration, logging).
- `ConfigureClient(Action<IClientBuilder>)` and `ConfigureClientHost(Action<IHostApplicationBuilder>)`: the client side.
- `ConfigureHost(Action<IHostApplicationBuilder>)`: applied to both silo hosts and the client host. Register shared test doubles here.
- `Options`: an `InProcessTestClusterOptions`.
- `Build()` returns the cluster; `await cluster.DeployAsync()` starts it.

```csharp
var builder = new InProcessTestClusterBuilder(initialSilosCount: 2);

builder.ConfigureSilo((options, siloBuilder) =>
{
    siloBuilder.AddMemoryGrainStorage("Default");
    siloBuilder.AddMemoryGrainStorage("PubSubStore");
});

builder.ConfigureClient(clientBuilder => { /* client-only settings */ });

builder.ConfigureHost(hostBuilder =>
{
    hostBuilder.Services.AddSingleton<IMyService, MyService>();
});

var cluster = builder.Build();
await cluster.DeployAsync();
```

`InProcessTestClusterOptions`:

- `ClusterId`, `ServiceId`: auto-generated when unset.
- `InitialSilosCount` (short, default 1).
- `InitializeClientOnDeploy` (default true).
- `ConfigureFileLogging` (default true): writes per-silo log files; useful when a test hangs.
- `UseRealEnvironmentStatistics` (default false): real CPU and memory numbers instead of simulated ones. Turn it on for placement or load shedding tests.
- `GatewayPerSilo` (default true).
- `UseDistributedGrainDirectory`, `AssumeHomogenousSilosForTesting`.

Cluster members: `Client` (an `IClusterClient`, so `GetGrain<T>` works), `Silos`, `GetActiveSilos()`, `GetSiloServiceProvider(SiloAddress?)`, `StartAdditionalSiloAsync()`, `StartSilosAsync(int)`, `StopSiloAsync(handle)`, `KillSiloAsync(handle)`, `RestartSiloAsync(handle)`, `StopAllSilosAsync()`, `WaitForLivenessToStabilizeAsync(didKill)`, `TryGetGrainContext(GrainId, out IGrainContext)`, `DeactivateAsync(grain)`, `WaitForDeactivationAsync(grain)`, `MigrateAsync(grain, targetSilo)`, `GetLog()`, `DisposeAsync()`.

## TestCluster (Orleans 7 and later)

`TestCluster` uses configurator classes because the same options must be serializable to start silos in separate processes (`ConnectionTransport`, `UseTestClusterMembership`). By default it runs in-process, with the same cost as `InProcessTestCluster`. Pick it when you need multi-process silos, when existing tests use it, or when you must stay compatible with Orleans 7 or 8.

```csharp
using Orleans.TestingHost;

public class HelloGrainTests
{
    [Fact]
    public async Task SaysHelloCorrectly()
    {
        var builder = new TestClusterBuilder();
        var cluster = builder.Build();
        cluster.Deploy();

        var hello = cluster.GrainFactory.GetGrain<IHelloGrain>(Guid.NewGuid());
        var greeting = await hello.SayHello("World");

        cluster.StopAllSilos();

        Assert.Equal("Hello, World!", greeting);
    }
}
```

Builder members: `new TestClusterBuilder()` or `new TestClusterBuilder(initialSilosCount)`, `Options` (a `TestClusterOptions`), `Properties` (string values passed to every silo and client as configuration), `AddSiloBuilderConfigurator<T>()` where `T : ISiloConfigurator` or `IHostConfigurator`, `AddClientBuilderConfigurator<T>()` where `T : IClientBuilderConfigurator` or `IHostConfigurator`, `ConfigureHostConfiguration(Action<IConfigurationBuilder>)`, `Build()`.

The configurator interfaces:

```csharp
public interface ISiloConfigurator
{
    void Configure(ISiloBuilder siloBuilder);
}

public interface IClientBuilderConfigurator
{
    void Configure(IConfiguration configuration, IClientBuilder clientBuilder);
}

public interface IHostConfigurator
{
    void Configure(IHostBuilder hostBuilder);
}
```

Configurators must have a public parameterless constructor; the cluster instantiates them by type name. Pass values through `builder.Properties` and read them from the `IConfiguration` in the client configurator or from `hostBuilder.Configuration` in the host configurator.

```csharp
public sealed class ClusterFixtureWithConfig : IDisposable
{
    public TestCluster Cluster { get; } = new TestClusterBuilder()
        .AddSiloBuilderConfigurator<TestSiloConfigurations>()
        .Build();

    public ClusterFixtureWithConfig() => Cluster.Deploy();

    void IDisposable.Dispose() => Cluster.StopAllSilos();
}

file sealed class TestSiloConfigurations : ISiloConfigurator
{
    public void Configure(ISiloBuilder siloBuilder)
    {
        siloBuilder.AddMemoryGrainStorageAsDefault();
        siloBuilder.Services.AddSingleton<IClock, FakeClock>();
    }
}
```

`TestClusterOptions` properties: `ClusterId`, `ServiceId`, `BaseSiloPort`, `BaseGatewayPort`, `UseTestClusterMembership`, `UseRealEnvironmentStatistics`, `InitializeClientOnDeploy`, `InitialSilosCount` (short; the docs say the default cluster has two silos), `ApplicationBaseDirectory`, `ConfigureFileLogging` (default true), `AssumeHomogenousSilosForTesting`, `GatewayPerSilo` (default true), `SiloBuilderConfiguratorTypes`, `ClientBuilderConfiguratorTypes`, `ConnectionTransport` (default `ConnectionTransportType.InMemory`).

Cluster members: `Client`, `GrainFactory`, `ServiceProvider` (client side), `Silos`, `Primary`, `SecondarySilos`, `Options`, `Deploy()`, `DeployAsync()`, `StartAdditionalSiloAsync()`, `StartAdditionalSilosAsync(int)`, `StopAllSilos()`, `StopAllSilosAsync()`, `StopSiloAsync(handle)`, `KillSiloAsync(handle)`, `RestartSiloAsync(handle)`, `WaitForLivenessToStabilizeAsync(didKill)`, `WaitForClusterManifestToStabilizeAsync(didKill)`, `GetActiveSilos()`, `GetSiloForAddress(address)`, `TryGetGrainContext`, `DeactivateAsync(GrainId)`, `WaitForDeactivationAsync(GrainId)`, `MigrateAsync(GrainId, SiloAddress?)`, `DisposeAsync()`.

## Share one cluster across tests (xUnit)

Starting a cluster costs seconds. Start it once per test class (`IClassFixture<T>`) or once per collection (`ICollectionFixture<T>`).

```csharp
public class ClusterFixture : IAsyncLifetime
{
    public InProcessTestCluster Cluster { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        var builder = new InProcessTestClusterBuilder();
        builder.ConfigureSilo((options, siloBuilder) =>
        {
            siloBuilder.AddMemoryGrainStorageAsDefault();
        });

        Cluster = builder.Build();
        await Cluster.DeployAsync();
    }

    public async Task DisposeAsync() => await Cluster.DisposeAsync();
}

[CollectionDefinition(nameof(ClusterCollection))]
public class ClusterCollection : ICollectionFixture<ClusterFixture> { }

[Collection(nameof(ClusterCollection))]
public class HelloGrainTests(ClusterFixture fixture)
{
    [Fact]
    public async Task SaysHello()
    {
        var grain = fixture.Cluster.Client.GetGrain<IHelloGrain>(0);
        Assert.Equal("Hello, World!", await grain.SayHello("World"));
    }
}
```

For `IClassFixture<ClusterFixture>` drop the collection classes and put the fixture type on the test class. Use distinct grain keys per test (`Guid.NewGuid()`, a per-test string) so tests that share a cluster do not share activations.

## In-memory providers for tests

Register the memory providers in `ConfigureSilo` (or an `ISiloConfigurator`). They keep everything in the silo process, so nothing leaks between test runs.

```csharp
siloBuilder.AddMemoryGrainStorageAsDefault();          // "Default" store
siloBuilder.AddMemoryGrainStorage("PubSubStore");       // required by streams
siloBuilder.AddMemoryStreams("StreamProvider");         // in-memory stream provider
siloBuilder.UseInMemoryReminderService();               // reminders without a database
siloBuilder.Services.AddFaultInjectionMemoryStorage(    // storage that fails on demand
    "Faulty",
    configureOptions: null,
    configureFaultInjectionOptions: null);
```

`AddMemoryStreams` needs `Microsoft.Orleans.Streaming`; the reminder service needs `Microsoft.Orleans.Reminders`. `AddFaultInjectionMemoryStorage` lives in `Orleans.TestingHost` and wraps memory storage in `FaultInjectionGrainStorage`; get the `IStorageFaultGrain` to schedule read or write faults for a grain id and assert your recovery path.

Memory storage still serializes state, so a state type that lacks `[GenerateSerializer]` fails in tests the same way it would in production. That is a feature.

## Stop and kill silos

Failover tests start with more than one silo.

```csharp
var builder = new InProcessTestClusterBuilder(initialSilosCount: 2);
var cluster = builder.Build();
await cluster.DeployAsync();

var grain = cluster.Client.GetGrain<ICounterGrain>("a");
await grain.Increment();

// Find the silo that hosts the activation and remove it.
Assert.True(cluster.TryGetGrainContext(grain.GetGrainId(), out var context));
var host = cluster.GetSiloForAddress(context!.Address.SiloAddress)!;

await cluster.KillSiloAsync(host);                       // abrupt, no shutdown
await cluster.WaitForLivenessToStabilizeAsync(didKill: true);

// The next call re-activates the grain on the surviving silo.
Assert.Equal(1, await grain.Get());

var replacement = await cluster.StartAdditionalSiloAsync();
await cluster.StopSiloAsync(replacement);                // graceful
await cluster.RestartAsync();
```

`StopSiloAsync` performs a graceful shutdown: activations deactivate, state is written, the membership table is updated. `KillSiloAsync` drops the silo without cleanup; the cluster has to detect the death through membership probes. `WaitForLivenessToStabilizeAsync(true)` waits long enough for that (it reads `ClusterMembershipOptions`). The `TestCluster` API has the same methods. Since Orleans 9 the default failure detection time fell from about 10 minutes to about 90 seconds, and the test cluster shortens the membership timings further.

`DeactivateAsync(grain)` plus `WaitForDeactivationAsync(grain)` test `OnDeactivateAsync` and re-activation without touching a silo. `MigrateAsync(grain, targetSilo)` tests activation migration.

## Grain call filters in tests

Filters record or alter calls without changing the grain. Register them in the silo delegate. `AddGrainCallFilter` on `IServiceCollection` was removed in Orleans 10; use `AddIncomingGrainCallFilter` on `ISiloBuilder` (or `IClientBuilder`) and `AddOutgoingGrainCallFilter` for calls that leave the host.

```csharp
public sealed class CallRecorder : IIncomingGrainCallFilter
{
    public ConcurrentBag<string> Calls { get; } = new();

    public async Task Invoke(IIncomingGrainCallContext context)
    {
        Calls.Add($"{context.InterfaceName}.{context.MethodName}");
        await context.Invoke();
    }
}

var recorder = new CallRecorder();
builder.ConfigureSilo((_, silo) => silo.AddIncomingGrainCallFilter(recorder));
```

Because `InProcessTestCluster` shares instances, the test can read `recorder.Calls` after the call. With `TestCluster`, resolve the filter from the silo's service provider or use a static.

## Unit test a grain without a cluster

A grain that inherits `Grain` needs the runtime behind `GrainContext`, `GrainFactory`, timers and so on. Options:

1. Implement `IGrainBase` and take `IGrainContext` through the constructor. Then `new MyGrain(fakeContext, fakeFactory, ...)` works. Extension methods such as `this.GetPrimaryKey()` read `GrainContext.GrainId`, so a fake context with a real `GrainId` is enough.

```csharp
public sealed class PingGrain : IGrainBase, IPingGrain
{
    private readonly IGrainFactory _factory;

    public PingGrain(IGrainContext context, IGrainFactory factory)
    {
        GrainContext = context;
        _factory = factory;
    }

    public IGrainContext GrainContext { get; }

    public Task Ping() => _factory.GetGrain<IPongGrain>("pong").Pong();
}
```

2. Inject everything the grain needs through the constructor: `IPersistentState<T>` (fake it with a small class that implements `IPersistentState<T>`), `IGrainFactory`, `ILogger<T>`, your own services. Keep `Grain` base members out of the code path under test.

3. Mock a `Grain` subclass with Moq. `GrainFactory` on `Grain` is protected, so expose it as `public new virtual` and set it up. The docs show this pattern:

```csharp
public class WorkerGrain : Grain, IWorkerGrain
{
    public new virtual IGrainFactory GrainFactory => base.GrainFactory;

    public Task DoWork(string data) =>
        GrainFactory.GetGrain<IJournalGrain>(Guid.NewGuid()).Record(data);
}

[Fact]
public async Task RecordsMessageInJournal()
{
    var journal = new Mock<IJournalGrain>();
    var worker = new Mock<WorkerGrain>();
    worker.Setup(x => x.GrainFactory.GetGrain<IJournalGrain>(It.IsAny<Guid>()))
          .Returns(journal.Object);

    await worker.Object.DoWork("Hello, World");

    journal.Verify(x => x.Record("Hello, World"), Times.Once());
}
```

Limits of the mock approach, per the docs: no scheduling or reentrancy semantics, no serialization or copying, and production code gains test-only members.

### OrleansTestKit

`OrleansTestKit` (NuGet id `OrleansTestKit`, community project OrleansContrib/OrleansTestKit, MIT) fakes the activation context so a grain runs without a cluster. Versions track Orleans: TestKit 10 for Orleans 10, 9.x for Orleans 9, 8.x for Orleans 8, 4.x for Orleans 7. Tests inherit `TestKitBase` and use `Silo`:

```csharp
public class PingGrainTests : TestKitBase
{
    [Fact]
    public async Task PingCallsPong()
    {
        IPing grain = await Silo.CreateGrainAsync<PingGrain>(1);
        var pong = Silo.AddProbe<IPong>(22);          // a Moq mock for another grain
        await grain.Ping();
        pong.Verify(p => p.Pong(), Times.Once);
    }
}
```

`Silo.AddProbe<T>(key)` or `AddProbe<T>(Func<IdSpan, Mock<T>>)` supplies grain references; `Silo.DeactivateAsync(grain)` runs deactivation; the kit also fakes persistent state, reminders, timers and streams. The project warns that it does not reproduce the single-threaded execution model, so keep `TestCluster` tests for concurrency-sensitive grains.

## Debugging tips

- Breakpoints stall grain calls. `MessagingOptions.ResponseTimeout` (default 30 s) is replaced by `ResponseTimeoutWithDebugger` (default 30 min) while `Debugger.IsAttached` is true, on both `SiloMessagingOptions` and `ClientMessagingOptions`. Raise either value when a debugger is not detected (for example under some test runners).
- Orleans 10 changed `MessagingOptions.CancelRequestOnTimeout` from true to false. A test that expects cancellation to reach the grain on timeout must set it to true.
- Leave `ConfigureFileLogging` on. Each silo writes a log file under the test output directory; `InProcessTestCluster.GetLog()` returns the collected text.
- `InProcessTestCluster.GetSiloServiceProvider()` gives access to silo services such as `IGrainFactory`, `IManagementGrain` (`GetGrain<IManagementGrain>(0)`) and `ILocalSiloDetails` for assertions about activations and placement.
- Configure `ClusterMembershipOptions` in `ConfigureSilo` when a test needs faster or slower failure detection than the test defaults.
- A hang at `DeployAsync` usually means a required provider name is missing (`"PubSubStore"` for streams, a named store for `[PersistentState]`) or a serializer is missing for a state type. Read the silo log first.
- Keep `Microsoft.Orleans.Sdk` referenced from the test project when it declares grains or serializable types of its own, otherwise the source generator does not run for them.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/implementation/testing?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/migration-guide?pivots=orleans-10-0
- https://raw.githubusercontent.com/dotnet/docs/main/docs/orleans/implementation/testing.md
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/TestCluster.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/TestClusterBuilder.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/TestClusterOptions.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/InProcTestCluster.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/InProcTestClusterBuilder.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/InProcTestClusterOptions.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/ISiloConfigurator.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/IClientBuilderConfigurator.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/IHostConfigurator.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.TestingHost/TestStorageProviders/FaultInjectionStorageServiceCollectionExtensions.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Core/Configuration/Options/MessagingOptions.cs
- https://github.com/OrleansContrib/OrleansTestKit
- https://raw.githubusercontent.com/OrleansContrib/OrleansTestKit/main/test/OrleansTestKit.Tests/Tests/BasicGrainTests.cs
- https://raw.githubusercontent.com/OrleansContrib/OrleansTestKit/main/test/OrleansTestKit.Tests/Tests/GrainProbeTests.cs

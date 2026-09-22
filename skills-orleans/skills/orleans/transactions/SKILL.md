---
name: transactions
description: "Orleans distributed ACID transactions: TransactionOption on interface methods, ITransactionalState<T>, ITransactionClient, transactional storage, aborts. Use when a call must update several grains atomically, you wire transactional storage, or you handle transaction aborts."
metadata:
  title: Orleans transactions
  tags: [orleans, dotnet, csharp, transactions, acid, transactionoption, transactionalstate, performupdate, performread, transactionclient, azure-table, abort, retry, reentrant]
  related: [orleans, orleans/grains, orleans/persistence, orleans/hosting, orleans/testing, orleans/best-practices]
  version: 1
---

# Orleans transactions

Orleans supports distributed ACID transactions over persistent grain state. A transaction can span several grains on several silos. Either every participating state change commits, or none does.

Transactions are opt-in and live in their own package since Orleans 7.0: `Microsoft.Orleans.Transactions`. Before 7.0 the core ran coordination code on every grain call; now only methods marked `[Transaction]` carry that cost. Orleans 7.0 also added `ITransactionClient`, so a client can coordinate a transaction without an intermediary grain. The code below is valid on Orleans 7, 8, 9 and 10 on .NET 10.

## Setup

Enable transactions on every silo and every client. A transactional call on a host without it throws `OrleansTransactionsDisabledException`.

```csharp
// Silo
var builder = Host.CreateApplicationBuilder(args);
builder.UseOrleans(siloBuilder =>
{
    siloBuilder.UseLocalhostClustering();
    siloBuilder.UseTransactions();
});

// Client
builder.UseOrleansClient(clientBuilder =>
{
    clientBuilder.UseLocalhostClustering();
    clientBuilder.UseTransactions();
});
```

`SiloBuilderExtensions.UseTransactions(this ISiloBuilder)` adds the transaction services and the transaction protocol grain extensions. `ClientBuilderExtensions.UseTransactions(this IClientBuilder)` adds the client services, including `ITransactionClient`.

### Transactional state storage

Transactional state does not use `IGrainStorage`. It uses `ITransactionalStateStorage<TState>`, a log-shaped abstraction built for two-phase commit. Register an implementation under a name, then reference that name from `[TransactionalState]`.

Azure Table Storage is the shipped implementation. Package: `Microsoft.Orleans.Transactions.AzureStorage`. Options class: `AzureTableTransactionalStateOptions` (`TableServiceClient`, `TableName`, ...).

```csharp
using Azure.Data.Tables;

siloBuilder.AddAzureTableTransactionalStateStorage(
    "TransactionStore",
    options => options.TableServiceClient = new TableServiceClient(connectionString));
```

Development fallback: when no transactional store matches the name, Orleans bridges to a regular `IGrainStorage` provider of that name (or the default one). The docs mark the bridge as less efficient and possibly unsupported in the future. Use it for local runs and tests only:

```csharp
siloBuilder.AddMemoryGrainStorageAsDefault();   // bridge target for tests
siloBuilder.UseTransactions();
```

A common pattern is to pick the store from the environment:

```csharp
await Host.CreateDefaultBuilder(args)
    .UseOrleans((_, silo) =>
    {
        silo.UseLocalhostClustering();

        if (Environment.GetEnvironmentVariable("ORLEANS_STORAGE_CONNECTION_STRING") is { } cs)
        {
            silo.AddAzureTableTransactionalStateStorage(
                "TransactionStore",
                options => options.TableServiceClient = new TableServiceClient(cs));
        }
        else
        {
            silo.AddMemoryGrainStorageAsDefault();
        }

        silo.UseTransactions();
    })
    .RunConsoleAsync();
```

## Grain interfaces: `[Transaction]`

Mark each transactional method on the grain interface with `[Transaction(TransactionOption.X)]`. The attribute is `Orleans.TransactionAttribute`, valid on methods only. The option says how the call relates to an ambient transaction:

- `Create`: always starts a new transaction, even inside an existing one.
- `Join`: joins the caller's transaction. Requires one to exist.
- `CreateOrJoin`: joins if one exists, otherwise starts one.
- `Suppress`: not transactional. Can be called from a transaction; the context is not passed on.
- `Supported`: not transactional itself, but passes an ambient transaction through to the calls it makes.
- `NotAllowed`: not transactional. Throws `NotSupportedException` when called inside a transaction.

Methods without the attribute behave like `Suppress`. The older `ReadOnly` property on the attribute is obsolete; put `[ReadOnly]` on the method instead when it only reads.

```csharp
namespace TransactionalExample.Abstractions;

public interface IAtmGrain : IGrainWithIntegerKey
{
    [Transaction(TransactionOption.Create)]
    Task Transfer(string fromId, string toId, decimal amountToTransfer);
}

public interface IAccountGrain : IGrainWithStringKey
{
    [Transaction(TransactionOption.Join)]
    Task Withdraw(decimal amount);

    [Transaction(TransactionOption.Join)]
    Task Deposit(decimal amount);

    [Transaction(TransactionOption.CreateOrJoin)]
    Task<decimal> GetBalance();
}
```

`Transfer` always opens a transaction. `Withdraw` and `Deposit` can only run inside one. `GetBalance` works both ways.

Do not mark `OnActivateAsync` or other lifecycle methods. They have no transaction context, and reading transactional state from them throws.

## Grain implementations: `ITransactionalState<T>`

State access goes through an `ITransactionalState<TState>` facet, injected by the constructor. `TState` must be a class with a parameterless constructor and must be serializable (`[GenerateSerializer]` plus `[Id]`).

```csharp
public interface ITransactionalState<TState> where TState : class, new()
{
    // readFunction must not modify the state.
    Task<TResult> PerformRead<TResult>(Func<TState, TResult> readFunction);

    // updateFunction may read or update the state.
    Task<TResult> PerformUpdate<TResult>(Func<TState, TResult> updateFunction);
}
```

Extension overloads let you pass an `Action<TState>` to `PerformUpdate` when there is nothing to return. The delegates are synchronous on purpose: the runtime takes locks, runs the delegate against a transaction-private copy, and later commits or discards it.

`[TransactionalState(stateName, storageName = null)]` (namespace `Orleans.Transactions.Abstractions`) goes on the constructor parameter. `storageName` selects the transactional store registered above; when omitted, the default store is used.

```csharp
namespace TransactionalExample.Abstractions;

[GenerateSerializer]
public record class Balance
{
    [Id(0)]
    public decimal Value { get; set; } = 1_000;
}
```

```csharp
namespace TransactionalExample.Grains;

[Reentrant]
public class AccountGrain : Grain, IAccountGrain
{
    private readonly ITransactionalState<Balance> _balance;

    public AccountGrain(
        [TransactionalState(nameof(balance), "TransactionStore")]
        ITransactionalState<Balance> balance) =>
        _balance = balance ?? throw new ArgumentNullException(nameof(balance));

    public Task Deposit(decimal amount) =>
        _balance.PerformUpdate(balance => balance.Value += amount);

    public Task Withdraw(decimal amount) =>
        _balance.PerformUpdate(balance =>
        {
            if (balance.Value < amount)
            {
                throw new InvalidOperationException(
                    $"Withdrawing {amount} credits from account " +
                    $"\"{this.GetPrimaryKeyString()}\" would overdraw it." +
                    $" This account has {balance.Value} credits.");
            }

            balance.Value -= amount;
        });

    public Task<decimal> GetBalance() =>
        _balance.PerformRead(balance => balance.Value);
}
```

Rules:

- A transactional grain must be `[Reentrant]`. The commit protocol calls back into the grain while the original request is still pending; without reentrancy the transaction context cannot be passed through and the transaction stalls.
- Throwing from the update delegate aborts the transaction. The exception becomes the `InnerException` of the `OrleansTransactionException` the caller sees.
- Do all reads and writes through `PerformRead` and `PerformUpdate`. Do not cache the state object outside the delegate.
- A grain can hold several transactional states, each with its own name and store.

## Coordinating a transaction

### From a client with `ITransactionClient`

`ITransactionClient` is registered by `UseTransactions()` on both client and silo hosts. Resolve it from DI and wrap the calls.

```csharp
using IHost host = Host.CreateDefaultBuilder(args)
    .UseOrleansClient((_, client) => client.UseLocalhostClustering().UseTransactions())
    .Build();
await host.StartAsync();

var client = host.Services.GetRequiredService<IClusterClient>();
var transactionClient = host.Services.GetRequiredService<ITransactionClient>();

var fromAccount = client.GetGrain<IAccountGrain>("Xaawo");
var toAccount = client.GetGrain<IAccountGrain>("Pasqualino");

try
{
    await transactionClient.RunTransaction(
        TransactionOption.Create,
        async () =>
        {
            await fromAccount.Withdraw(100);
            await toAccount.Deposit(100);
        });
}
catch (OrleansTransactionAbortedException)
{
    // Safe to retry.
}
catch (OrleansTransactionException ex)
{
    // Unknown outcome; see the retry section.
    Console.WriteLine(ex.InnerException?.Message ?? ex.Message);
}
```

`RunTransaction` overloads:

- `RunTransaction(TransactionOption, Func<Task>)`: commits when the delegate completes.
- `RunTransaction(TransactionOption, Func<Task<bool>>)`: the returned bool decides commit (true) or abort (false).
- Both also exist with a trailing `bool useExclusiveLock`. With `true`, every state touched takes an exclusive lock even for reads, which avoids lock upgrade conflicts under contention.

The transaction commits unless the delegate throws, returns `false`, or the option contradicts the ambient context (for example `Join` with no transaction).

### From another grain

A grain method marked `Create` or `CreateOrJoin` is itself a coordinator. Calls it makes to `Join` methods enlist in its transaction. This is the ATM pattern:

```csharp
namespace TransactionalExample.Grains;

[StatelessWorker]
public class AtmGrain : Grain, IAtmGrain
{
    public Task Transfer(string fromId, string toId, decimal amount) =>
        Task.WhenAll(
            GrainFactory.GetGrain<IAccountGrain>(fromId).Withdraw(amount),
            GrainFactory.GetGrain<IAccountGrain>(toId).Deposit(amount));
}
```

```csharp
IAtmGrain atm = client.GetGrain<IAtmGrain>(0);
await atm.Transfer("Xaawo", "Pasqualino", 100);

decimal fromBalance = await client.GetGrain<IAccountGrain>("Xaawo").GetBalance();
decimal toBalance = await client.GetGrain<IAccountGrain>("Pasqualino").GetBalance();
```

Await every call you make inside a transaction before the method returns. A pending call left behind aborts the transaction with `OrleansOrphanCallException`.

## How it works

Each transaction gets a transaction manager (TM) and a set of participants (the transactional states it touched). The first state a transaction writes usually acts as TM. Silos run a transaction agent that assigns ids and timestamps, tracks the ambient transaction in the request context, and drives two-phase commit: prepare on every participant, then commit or abort, then confirmation. Reads take shared locks and writes take exclusive locks on each state; lock groups batch transactions that touch the same state. The state's log in the transactional store makes prepared writes durable before commit, so a silo crash mid-commit can be resolved from the log.

Timeouts and sizes come from `TransactionalStateOptions`:

- `LockTimeout` (default 8 s): how long a transaction group keeps the state lock. Effective duration is at least the transaction timeout.
- `LockAcquireTimeout` (default 10 s): how long a transaction waits for the lock.
- `PrepareTimeout` (default 20 s): how long the TM waits for all prepared messages.
- `RemoteTransactionPingFrequency` (default 60 s): liveness pings for remote transactions.
- `ConfirmationRetryDelay` (default 30 s): delay between attempts to confirm a committed transaction.
- `MaxLockGroupSize` (default 20): transactions that can share a lock group.

```csharp
siloBuilder.Configure<TransactionalStateOptions>(o =>
{
    o.LockAcquireTimeout = TimeSpan.FromSeconds(5);
    o.PrepareTimeout = TimeSpan.FromSeconds(30);
});
```

## Exceptions and retries

A failed transactional call does not surface application exceptions directly. It throws `OrleansTransactionException` (base type, derives from `OrleansException`) or `TimeoutException`. If your own exception aborted the transaction, it is the `InnerException`.

Subtypes and what to do:

- `OrleansTransactionAbortedException`: the transaction did not commit. Retry is safe. Subtypes: `OrleansTransactionTransientFailureException` (lock or protocol timeouts, speculation failure), `OrleansCascadingAbortException` (a dependent transaction aborted), `OrleansBrokenTransactionLockException`, `OrleansTransactionLockUpgradeException`, `OrleansTransactionPrepareTimeoutException`, `OrleansOrphanCallException` (unawaited call), `OrleansReadOnlyViolatedException` (a read-only transaction wrote).
- `OrleansTransactionInDoubtException`: the runtime cannot tell whether the commit happened. Do not blindly retry.
- `OrleansStartTransactionFailedException`, `OrleansTransactionOverloadException`, `OrleansTransactionServiceNotAvailableException`, `OrleansTransactionsDisabledException`: infrastructure problems.

Any exception that is not an `OrleansTransactionAbortedException` means the outcome is unknown: it may have committed, failed, or still be running. Before you check state or retry, wait at least the call timeout (`SiloMessagingOptions.SystemResponseTimeout`) so you do not trigger cascading aborts.

Retry pattern:

```csharp
for (var attempt = 1; ; attempt++)
{
    try
    {
        await transactionClient.RunTransaction(TransactionOption.Create, Work);
        return;
    }
    catch (OrleansTransactionAbortedException) when (attempt < 5)
    {
        await Task.Delay(TimeSpan.FromMilliseconds(50 * attempt));
    }
}
```

## Limits

- Transactions cover transactional state only. Ordinary `IPersistentState<T>` writes, timers, reminders, stream publishes and external side effects inside a transaction are not rolled back. Keep them out of transactional methods or make them idempotent.
- Grain timers and reminders start without a transaction context. A timer callback that needs one must call a `Create` or `CreateOrJoin` method, or use `ITransactionClient`.
- `OnActivateAsync` and `OnDeactivateAsync` cannot use transactional state.
- Transactions are not free: every participant pays a durable log write on prepare and again on commit, plus lock waits. Keep transactions short, touch few grains, and do not hold a transaction across slow external calls.
- Reads under `CreateOrJoin` take shared locks; heavy read traffic on a hot state competes with writers. Use `[ReadOnly]` for pure reads or `useExclusiveLock` when upgrades keep failing.
- The `IGrainStorage` bridge is for development. Production needs a real `ITransactionalStateStorage` implementation.
- Both silo and client must call `UseTransactions()`. A client without it cannot call transactional methods at all.

## Testing

A `TestCluster` or `InProcessTestCluster` works with `AddMemoryGrainStorageAsDefault()` as the bridge target plus `UseTransactions()` on the silo delegate and the client delegate. `Microsoft.Orleans.Transactions.TestKit.xUnit` (package name as published) contains the conformance tests the Orleans team runs against storage implementations; use it when you write your own `ITransactionalStateStorage`.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/grains/transactions?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/migration-guide?pivots=orleans-10-0
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Transactions/TransactionAttribute.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Transactions/ITransactionClient.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Transactions/Abstractions/ITransactionalState.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Transactions/OrleansTransactionException.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Transactions/State/TransactionalStateOptions.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Transactions/Hosting/SiloBuilderExtensions.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Transactions/Hosting/ClientBuilderExtensions.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Azure/Orleans.Transactions.AzureStorage/README.md

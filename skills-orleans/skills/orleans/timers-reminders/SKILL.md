---
name: timers-reminders
description: "Orleans 10 timers and reminders: in-memory grain timers via RegisterGrainTimer with GrainTimerCreationOptions (DueTime, Period, Interleave, KeepAlive) and IGrainTimer, the obsolete RegisterTimer and how to migrate, persistent reminders via IRemindable, RegisterOrUpdateReminder, UnregisterReminder, GetReminder, ReceiveReminder and TickStatus, the one-minute minimum period in ReminderOptions, reminder table providers (UseInMemoryReminderService, UseAdoNetReminderService, UseAzureTableReminderService, UseRedisReminderService, UseCosmosReminderService, UseDynamoDBReminderService), timer ticks and the single-threaded turn model, and pitfalls such as deactivation, missed ticks and duplicate delivery. Use when a grain needs periodic or delayed work, when deciding between a timer and a reminder, when a timer stops after deactivation, or when configuring reminder storage."
metadata:
  title: Orleans timers and reminders
  tags: [orleans, dotnet, csharp, timers, reminders, scheduling, periodic, iremindable, registergraintimer, graintimer, reminderoptions, tickstatus]
  related: [orleans, orleans/grains, orleans/hosting, orleans/persistence, orleans/streams, orleans/best-practices]
  version: 1
---
# Orleans timers and reminders

Orleans has two mechanisms for periodic grain work.

| | Timer | Reminder |
| --- | --- | --- |
| Lives in | one activation, in memory | the reminder table (storage) |
| Survives deactivation | no | yes, it re-activates the grain |
| Survives silo crash or cluster restart | no | yes |
| Resolution | seconds or minutes | minutes, hours, days (minimum period 1 minute by default) |
| Registered from | `OnActivateAsync` or any grain method | any grain method |
| Cancelled by | `Dispose()` on the `IGrainTimer` | `UnregisterReminder` |
| Delivery | callback on a separate turn of the activation | `IRemindable.ReceiveReminder` message |
| Package | `Microsoft.Orleans.Runtime` | `Microsoft.Orleans.Reminders` plus a table provider |

## Timers

A grain timer is like `System.Threading.Timer` but each callback runs on the activation's scheduler, one turn at a time, never in parallel with other turns on that activation. An activation can hold any number of timers. A timer stops when the activation deactivates or the silo fails.

### RegisterGrainTimer (Orleans 8.2 and later)

```csharp
protected IGrainTimer RegisterGrainTimer<TState>(
    Func<TState, CancellationToken, Task> callback,
    TState state,
    GrainTimerCreationOptions options)
```

It is an extension method on `IGrainBase`, so call it as `this.RegisterGrainTimer(...)`. It also works on POCO grains that implement `IGrainBase`. The `CancellationToken` passed to the callback is cancelled when the timer is disposed or the grain starts to deactivate.

`GrainTimerCreationOptions` (a struct in `Orleans.Runtime`):

| Property | Default | Meaning |
| --- | --- | --- |
| `DueTime` | required | delay before the first tick. `TimeSpan.Zero` fires at once. `Timeout.InfiniteTimeSpan` creates the timer stopped. |
| `Period` | required | interval between ticks. `Timeout.InfiniteTimeSpan` makes a one-shot timer. |
| `Interleave` | `false` | `true` lets callbacks interleave with other grain calls and timers. `false` treats the callback like a normal grain call (no interleaving unless the grain is `[Reentrant]`). |
| `KeepAlive` | `false` | `true` makes each tick count as activity, so the idle collector does not deactivate the grain. |

```csharp
public sealed class MetricsGrain : Grain, IMetricsGrain
{
    private IGrainTimer? _timer;

    public override Task OnActivateAsync(CancellationToken cancellationToken)
    {
        _timer = this.RegisterGrainTimer(
            static (self, ct) => self.FlushAsync(ct),
            this,
            new GrainTimerCreationOptions
            {
                DueTime = TimeSpan.FromSeconds(5),
                Period = TimeSpan.FromSeconds(10),
                KeepAlive = true
            });
        return Task.CompletedTask;
    }

    private async Task FlushAsync(CancellationToken ct)
    {
        // Runs as a turn of this activation. Grain state is safe to touch.
        await Task.Delay(50, ct);
    }

    public override Task OnDeactivateAsync(DeactivationReason reason, CancellationToken cancellationToken)
    {
        _timer?.Dispose();
        return Task.CompletedTask;
    }
}
```

Facts from the docs that matter in practice:

- The period is measured from the moment the callback's `Task` completes to the next invocation. Callbacks never overlap, and a slow callback lowers the frequency. This differs from `System.Threading.Timer`.
- Each tick is delivered as a separate turn on the activation.
- By default a tick does not change the activation from idle to in-use. Without `KeepAlive = true` a grain with a timer is still collected when idle.
- `IGrainTimer.Change(dueTime, period)` updates a running timer.
- A callback may dispose the timer that fired it.
- Callbacks go through grain call filters and appear in distributed tracing.
- Passing `this` as `TState` with a `static` lambda avoids a closure allocation per tick.

### Legacy RegisterTimer and migration

`Grain.RegisterTimer(Func<object, Task>, object, TimeSpan, TimeSpan)` returns `IDisposable`. It is obsolete since Orleans 8.2. Differences when moving to `RegisterGrainTimer`:

| Aspect | `RegisterTimer` | `RegisterGrainTimer` |
| --- | --- | --- |
| Interleaving | always interleaved | not interleaved by default |
| Return type | `IDisposable` | `IGrainTimer` |
| Callback | `Func<object, Task>` | `Func<TState, CancellationToken, Task>` |
| State | untyped `object` | typed `TState` |
| Updatable | no | `Change` |
| KeepAlive | no | yes |
| Call filters and tracing | no | yes |

The interleaving change is the trap. Old code that relied on a timer callback running while a long grain call was in flight must set `Interleave = true`. Otherwise the tick waits for the current call to finish, and a callback that awaits a call back into the same grain deadlocks the way any non-reentrant self-call does.

```csharp
// Before (Orleans 7)
_timer = RegisterTimer(DoWorkAsync, null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10));

// After (Orleans 8.2 and later)
_timer = this.RegisterGrainTimer(
    static (self, ct) => self.DoWorkAsync(ct),
    this,
    new GrainTimerCreationOptions
    {
        DueTime = TimeSpan.FromSeconds(5),
        Period = TimeSpan.FromSeconds(10),
        Interleave = true   // only if the old behaviour is required
    });
```

### POCO grains

A grain that implements `IGrainBase` instead of inheriting `Grain` injects `ITimerRegistry` (namespace `Orleans.Timers`) and calls `timerRegistry.RegisterGrainTimer(grainContext, callback, state, options)`. The same rules apply.

## Reminders

A reminder is a durable definition: grain id, name, due time, period. It is stored in a reminder table shared by the cluster. One silo owns each reminder and sends ticks as ordinary grain messages.

- Reminders belong to the grain identity, not to an activation. If the grain has no activation when a tick is due, Orleans activates it.
- Only the definition is stored. Individual ticks are not. If the cluster is down when a tick is due, that tick is missed and the next one fires on schedule. The runtime anchors ticks to `start + N * period`; it skips missed occurrences rather than drifting.
- Delivery is a grain message, so it follows the grain's interleaving rules like any other call.
- Ownership can move during membership changes. The same interval can be delivered more than once. Make the callback idempotent.
- Do not use reminders for high-frequency work. `ReminderOptions.MinimumReminderPeriod` defaults to one minute. A shorter period throws `ArgumentException` at registration. Lowering the option is possible but logs a warning; the docs say high-frequency reminders are unsuitable for production.

### Implement IRemindable

```csharp
public interface IReportGrain : IGrainWithStringKey
{
    Task StartDailyReportAsync();
    Task StopDailyReportAsync();
}

public sealed class ReportGrain : Grain, IReportGrain, IRemindable
{
    private const string ReminderName = "daily-report";

    public async Task StartDailyReportAsync()
    {
        // Registering the same name again replaces due time and period.
        await this.RegisterOrUpdateReminder(ReminderName,
            dueTime: TimeSpan.FromMinutes(1),
            period: TimeSpan.FromHours(24));
    }

    public async Task StopDailyReportAsync()
    {
        var reminder = await this.GetReminder(ReminderName);
        if (reminder is not null)
        {
            await this.UnregisterReminder(reminder);
        }
    }

    public Task ReceiveReminder(string reminderName, TickStatus status)
    {
        // status.FirstTickTime, status.Period, status.CurrentTickTime
        return reminderName == ReminderName ? RunReportAsync() : Task.CompletedTask;
    }

    private Task RunReportAsync() => Task.CompletedTask;
}
```

The API (extension methods in `Orleans.GrainReminderExtensions`, also protected methods on `Grain`):

```csharp
Task<IGrainReminder> RegisterOrUpdateReminder(string reminderName, TimeSpan dueTime, TimeSpan period);
Task UnregisterReminder(IGrainReminder reminder);
Task<IGrainReminder> GetReminder(string reminderName);
Task<List<IGrainReminder>> GetReminders();
```

Constraints on the arguments:

- `reminderName` is unique per grain and must not be empty.
- `dueTime` is zero or positive. Zero fires the first tick at once.
- `period` is positive and at least `MinimumReminderPeriod`. `Timeout.InfiniteTimeSpan` is rejected. For a one-shot, register a valid period and unregister inside the first callback after the durable work succeeds.
- `IGrainReminder` handles are not guaranteed valid beyond the activation. Persist the name, and call `GetReminder(name)` when you need a handle again.

`TickStatus` (`Orleans.Runtime`) has `FirstTickTime`, `Period`, `CurrentTickTime`. The docs give this recipe to detect missed ticks: `curCount = (Now - FirstTickTime) / Period`; missed = `curCount - count - 1`; then `count = curCount`.

### POCO grains

Inject `IReminderRegistry` (namespace `Orleans.Timers`) and call `RegisterOrUpdateReminder(callingGrainId, reminderName, dueTime, period)` and `UnregisterReminder(grainId, reminder)`. The grain must still implement `IRemindable`.

## Configure the reminder table

Reminders need storage. Configure exactly one reminder provider on every silo, including silos that host no `IRemindable` grains in a heterogeneous cluster. Without it, registration fails with an error that says the reminder service is not configured.

```csharp
var builder = Host.CreateApplicationBuilder(args);
builder.UseOrleans(silo =>
{
    // Development only. Definitions live for the lifetime of the cluster.
    silo.UseInMemoryReminderService();
});
```

Production providers:

```csharp
// ADO.NET, package Microsoft.Orleans.Reminders.AdoNet
silo.UseAdoNetReminderService(options =>
{
    options.Invariant = "Npgsql";
    options.ConnectionString = connectionString;
});

// Azure Table, package Microsoft.Orleans.Reminders.AzureStorage
silo.UseAzureTableReminderService(options =>
{
    options.ConfigureTableServiceClient(
        new Uri("https://<account>.table.core.windows.net"),
        new DefaultAzureCredential());
});

// Redis, package Microsoft.Orleans.Reminders.Redis
silo.UseRedisReminderService(options =>
{
    options.ConfigurationOptions = new ConfigurationOptions
    {
        EndPoints = { "localhost:6379" },
        AbortOnConnectFail = false
    };
});

// Azure Cosmos DB, package Microsoft.Orleans.Reminders.Cosmos
silo.UseCosmosReminderService(options =>
{
    options.ConfigureCosmosClient("https://myaccount.documents.azure.com:443/", new DefaultAzureCredential());
    options.DatabaseName = "Orleans";
    options.ContainerName = "OrleansReminders";
    options.IsResourceCreationEnabled = true;
});

// Amazon DynamoDB, package Microsoft.Orleans.Reminders.DynamoDB
silo.UseDynamoDBReminderService(options =>
{
    options.Service = "us-west-2";
    options.CreateIfNotExists = true;
});
```

Option classes: `AdoNetReminderTableOptions`, `AzureTableReminderStorageOptions`, `RedisReminderTableOptions` (`ConfigurationOptions`, `EntryExpiry` for tests only, `CreateMultiplexer`), `CosmosReminderTableOptions` (`DatabaseName`, `ContainerName`, `IsResourceCreationEnabled`, throughput and client options), `DynamoDBReminderStorageOptions` (`UseProvisionedThroughput`, `ReadCapacityUnits`, `WriteCapacityUnits`, `CreateIfNotExists`, `UpdateIfExists`). The ADO.NET provider needs the reminder table script for your vendor. `ClusterOptions.ServiceId` keys the reminder records; keep it stable across deployments that share a table.

`ReminderOptions` (namespace `Orleans.Hosting`), tune with `silo.Configure<ReminderOptions>(...)`:

| Property | Default | Meaning |
| --- | --- | --- |
| `MinimumReminderPeriod` | 1 minute | shortest accepted period |
| `RefreshReminderListPeriod` | 5 minutes | how often a silo re-reads its part of the table |
| `ReminderLoadingWindow` | 10 minutes | reminders due within this window are held in memory; must be at least the refresh period |
| `InitializationTimeout` | 5 minutes | how long silo start waits for the reminder service |

With Aspire, use `AddOrleans("cluster").WithReminders(resource)` or `.WithMemoryReminders()` in the AppHost, and call the matching `AddKeyed*Client("name")` in the silo before `UseOrleans()`.

## Decide which to use

Use a timer when:

- It is fine (or wanted) that the work stops when the activation goes away.
- The resolution is seconds or a few minutes.
- You can start it from `OnActivateAsync` or from a grain call.

Use a reminder when:

- The schedule must survive deactivation, silo failure and restarts.
- The work is infrequent: minutes, hours, days.

Combine them for fine-grained durable work: a reminder every few minutes wakes the grain, and `OnActivateAsync` or the reminder callback re-creates a short-period timer that was lost with the previous activation. A reminder that only needs to keep a grain alive is often replaced by a timer with `KeepAlive = true`, if losing the schedule on a crash is acceptable.

## Pitfalls

- A timer registered in `OnActivateAsync` is gone after deactivation. Nothing re-registers it unless the grain activates again. If the work must continue, use a reminder.
- Timer callbacks hold the activation's single-threaded guarantee. Do not spawn work with `Task.Run` from a callback and touch grain state from it.
- With `Interleave = false` (the default), a callback that awaits a call to the same grain deadlocks unless the grain is `[Reentrant]`.
- Do not register timers or reminders in the constructor. Use `OnActivateAsync` or a grain method.
- Reminder callbacks that run longer than the request timeout: return quickly and drive the work from a grain timer or a stateful worker, then let the next tick or a durable marker resume it.
- `IGrainReminder` returned by `RegisterOrUpdateReminder` should not be cached across activations.
- In-memory reminders and in-memory timers both vanish on restart; only the reminder providers backed by storage survive.
- The reminder table is read at silo start. If storage is unreachable longer than `InitializationTimeout`, the silo fails to start.
- Two ticks can arrive for the same interval after ownership moves. Store a completion marker per interval in grain state before doing side effects twice.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/grains/timers-and-reminders?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/api/orleans.runtime.tickstatus?view=orleans-10.0
- https://github.com/dotnet/orleans/blob/main/src/Orleans.Reminders/Options/ReminderOptions.cs
- https://github.com/dotnet/orleans/blob/main/src/Orleans.Reminders/ReminderService/ReminderRegistry.cs
- https://github.com/dotnet/orleans/blob/main/docs/site/src/content/docs/grains/reminders.md
- https://github.com/dotnet/orleans/blob/main/docs/site/src/content/docs/grains/reminders/dynamodb.md

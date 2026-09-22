---
name: serialization
description: "Orleans serialization: [GenerateSerializer], [Id] and [Alias], version tolerance, immutability, surrogates, delegating to JSON or MessagePack, the analyzers. Use when you define message or state types, fix a codec error, evolve deployed types, or choose a storage serializer."
metadata:
  title: Orleans serialization
  tags: [orleans, dotnet, csharp, serialization, generateserializer, id, alias, immutable, surrogate, converter, codec, json, newtonsoft, messagepack, versioning, analyzer, source-generator, storage-serializer]
  related: [orleans, orleans/grains, orleans/persistence, orleans/streams, orleans/migration, orleans/best-practices]
  version: 1
---

# Orleans serialization

Orleans has two kinds of serialization:

- Grain call serialization: arguments and return values of grain calls. Done by the built-in framework, `Orleans.Serialization`.
- Grain storage serialization: state written to and read from storage. Done by an `IGrainStorageSerializer`. See the last sections.

The built-in serializer shipped with Orleans 7.0 and replaced the Orleans 3.x serializer. It is binary, high fidelity (generics, polymorphism, inheritance, object identity, cyclic graphs) and version tolerant. Pointers are not supported. The same code applies to Orleans 7, 8, 9 and 10 unless a section says otherwise.

## Packages

- `Microsoft.Orleans.Sdk`: reference from every project that declares grain interfaces, grains or serializable types. It pulls in `Microsoft.Orleans.CodeGenerator`, the C# source generator that emits serializers, copiers and grain proxies at build time. `Microsoft.Orleans.Server` and `Microsoft.Orleans.Client` already reference the Sdk.
- `Microsoft.Orleans.Serialization.SystemTextJson`: `AddJsonSerializer`.
- `Microsoft.Orleans.Serialization.NewtonsoftJson`: `AddNewtonsoftJsonSerializer`.
- `Microsoft.Orleans.Serialization.MessagePack`: `AddMessagePackSerializer` (Orleans 8.2 and later).

With `<ImplicitUsings>enable</ImplicitUsings>` the `Orleans` and `Orleans.Hosting` namespaces are imported for you.

## Mark a type

Put `[GenerateSerializer]` on the type. Put `[Id(n)]` on every member that must be serialized. Members without `[Id]` are not serialized.

```csharp
[GenerateSerializer]
public class Employee
{
    [Id(0)]
    public string Name { get; set; }
}
```

Rules:

- Ids are `uint` values. Start at 0 for each type. Ids only have to be unique within one level of the inheritance hierarchy. A base class and a subclass can both use `[Id(0)]`.
- `internal`, `private` and `readonly` members serialize fine. A `readonly` field with `[Id]` is set by the generated code.
- Members marked `[NonSerialized]` are skipped by copiers and serializers.
- Abstract properties cannot carry `[Id]` (ORLEANS0006).
- The analyzer flags a `[GenerateSerializer]` type whose members lack ids (ORLEANS0004) and offers a code fix that adds `[Id]` to each member.

```csharp
[GenerateSerializer]
public class Publication
{
    [Id(0)]
    public string Title { get; set; }
}

[GenerateSerializer]
public class Book : Publication
{
    [Id(0)]
    public string ISBN { get; set; }
}
```

Each layer of a hierarchy is serialized on its own, so the ids of `Book` do not clash with the ids of `Publication`.

Structs work the same way:

```csharp
[GenerateSerializer]
public struct MyCustomStruct
{
    public MyCustomStruct(int intProperty, int intField)
    {
        IntProperty = intProperty;
        _intField = intField;
    }

    [Id(0)]
    public int IntProperty { get; }

    [Id(1)] private readonly int _intField;
    public int GetIntField() => _intField;
}
```

## Why ids matter

The wire format writes ids, not member names. Because of that:

- You can add a member. Old readers skip the unknown id. New readers see the default value when an old writer omitted it.
- You can remove a member. Its id must never be reused for a different member.
- You can rename a member. The name is not on the wire.
- You must not change the id of an existing member.
- You must not change a member's type, except for the numeric widening described below.

Without stable ids, a rolling upgrade, a message in a stream, or a state blob in storage written by an older build would fail to load.

## Aliases on types and methods

By default a type is identified on the wire by its full name. `[Alias("...")]` replaces that with a stable string, so you can rename the class or move it between namespaces and assemblies. Aliases are global: two types cannot share one alias (ORLEANS0011).

```csharp
[GenerateSerializer]
[Alias("employee")]
public class Employee { /* ... */ }

// A generic type includes the arity after a backtick.
[GenerateSerializer]
[Alias("page`1")]
public class Page<T> { /* ... */ }
```

`[Alias]` also goes on grain interfaces and on grain interface methods. The alias becomes the stable identity of the interface and of the method invocation, so you can rename interfaces and methods without breaking clients or silos that still run the old build. The analyzer suggests missing aliases (ORLEANS0010, info level). When you rename a grain interface with `[GrainInterfaceType("...")]`, also give it an `[Alias]` because the interface identity can itself be serialized.

```csharp
[Alias("IOrderGrain")]
public interface IOrderGrain : IGrainWithStringKey
{
    [Alias("Place")]
    Task Place(Order order);
}
```

## Versioning rules

Compound types (class and struct):

- You can add or remove fields at any level of the hierarchy.
- You cannot change field ids.
- You cannot add, change or remove the base class of a deployed type. You can add a new subclass.
- You cannot change a field's type, except numerics.
- Do not change a `record` to a `class` or the reverse. Their wire layouts differ.

Numerics:

- You can widen: `sbyte` to `short` to `int` to `long`, `float` to `double`.
- You can narrow, but a value that does not fit throws at read time (`int.MaxValue` into a `short`, a `double` outside the `float` range, and so on).
- You cannot change signedness. `int` to `uint` is invalid.

Best practice list from the docs: give types aliases; replace `[Serializable]` with `[GenerateSerializer]` plus `[Id]`; start ids at 0 per type; widen numerics as needed; never change signedness; never insert a base class.

## Supported types

The framework has built-in codecs for primitives, `string`, `decimal`, `BigInteger`, `Guid`, `DateTime`, `DateTimeOffset`, `DateOnly`, `TimeOnly`, `TimeSpan`, `Uri`, `Version`, `CultureInfo`, `IPAddress`, `IPEndPoint`, enums, nullable value types, arrays (including multi-dimensional), `KeyValuePair`, `Tuple` and `ValueTuple`, and the collections `List`, `Dictionary`, `HashSet`, `SortedDictionary`, `SortedList`, `SortedSet`, `Queue`, `Stack`, `ConcurrentDictionary`, `ConcurrentQueue`, `ReadOnlyCollection`, `ReadOnlyDictionary`, the `Immutable*` and `Frozen*` collections, `ArrayList` and `NameValueCollection`, plus the collection interfaces (`IList<T>`, `IReadOnlyList<T>`, `IDictionary<K,V>`, `IEnumerable<T>` and friends).

Generics are supported. A generic `[GenerateSerializer]` type gets a generic serializer; a closed generic argument that is itself a user type must also be marked. Polymorphism is preserved: a parameter declared as `IDictionary` that receives a `SortedDictionary` arrives as a `SortedDictionary`. Object identity is preserved within one message: the same instance referenced ten times is written once and comes back as one instance. Dictionary and hash set order is not preserved, because string hash codes differ per process.

Prefer the standard collections in messages. `Dictionary<string, string>` is faster than `List<Tuple<string, string>>` because the collection codecs use abbreviated wire forms.

## Records and constructors

Members of a record's primary constructor get implicit ids in declaration order. Members declared in the body use explicit `[Id]` values in a separate id space.

```csharp
[GenerateSerializer]
public record MyRecord(string A, string B)
{
    // ID 0 does not clash with A: body members and primary constructor
    // parameters do not share identities.
    [Id(0)]
    public string C { get; init; }
}
```

Consequences:

- Do not reorder or insert primary constructor parameters of a deployed record. Append only.
- `[GenerateSerializer(IncludePrimaryConstructorParameters = false)]` turns the implicit ids off. Then mark members explicitly.

Deserialization does not need a public parameterless constructor. If the type takes services through its constructor, mark that constructor with `[GeneratedActivatorConstructor]` (or `[ActivatorUtilitiesConstructor]`). Use it only for dependency injection, never to describe how data members are set. `[OrleansConstructor]` is obsolete in Orleans 10 and ignored.

```csharp
[GenerateSerializer]
public class MyClass
{
    [Id(0)]
    public string Value { get; set; }

    [GeneratedActivatorConstructor]
    public MyClass(IMyDependency dependency) => Dependency = dependency;

    [field: NonSerialized]
    public IMyDependency Dependency { get; }
}
```

## Copy semantics and immutability

Every grain call deep copies its arguments before the request is formed, and deep copies the return value. On a local call (same silo) the copies go straight to the callee. On a remote call the copies are serialized. Copies preserve object identity like serialization does. `[GenerateSerializer]` generates the copier along with the serializer.

Copies protect the caller from the callee mutating shared objects. When both sides promise not to mutate a value, tell Orleans to skip the copy:

1. `[Immutable]` on a type. Instances are never copied.
2. `[Immutable]` on a grain interface method parameter.
3. `[Immutable]` on a member of a serializable type. That member is not copied when the container is copied.
4. `Immutable<T>` as the parameter or return type. Construct with `new Immutable<T>(value)` and read `.Value`.

```csharp
[Immutable]
public class MyImmutableType
{
    public int MyValue { get; }
    public MyImmutableType(int value) => MyValue = value;
}

public interface ISummerGrain : IGrainWithIntegerKey
{
    // `values` is not copied.
    ValueTask<int> Sum([Immutable] List<int> values);

    Task<Immutable<byte[]>> ProcessRequest(Immutable<byte[]> request);
}

[GenerateSerializer]
public sealed class MyType
{
    [Id(0), Immutable]
    public List<int> ReferenceData { get; set; }

    [Id(1)]
    public List<int> RunningTotals { get; set; }
}
```

Immutability here is a two-sided promise: neither the sender nor the receiver modifies the object later. The docs recommend bitwise immutability (no mutation at all) rather than logical immutability, because grain code that mutates shared data from more than one activation is a concurrency bug.

## Surrogates for foreign types

When a type you do not own must travel in a grain call, define a surrogate that carries its data and a converter between the two. Surrogates should use fields rather than properties for speed.

```csharp
// Foreign type, not under your control.
public struct MyForeignLibraryValueType
{
    public MyForeignLibraryValueType(int num, string str, DateTimeOffset dto)
    {
        Num = num; String = str; DateTimeOffset = dto;
    }
    public int Num { get; }
    public string String { get; }
    public DateTimeOffset DateTimeOffset { get; }
}

[GenerateSerializer]
public struct MyForeignLibraryValueTypeSurrogate
{
    [Id(0)] public int Num;
    [Id(1)] public string String;
    [Id(2)] public DateTimeOffset DateTimeOffset;
}

[RegisterConverter]
public sealed class MyForeignLibraryValueTypeSurrogateConverter :
    IConverter<MyForeignLibraryValueType, MyForeignLibraryValueTypeSurrogate>
{
    public MyForeignLibraryValueType ConvertFromSurrogate(
        in MyForeignLibraryValueTypeSurrogate surrogate) =>
        new(surrogate.Num, surrogate.String, surrogate.DateTimeOffset);

    public MyForeignLibraryValueTypeSurrogate ConvertToSurrogate(
        in MyForeignLibraryValueType value) =>
        new() { Num = value.Num, String = value.String, DateTimeOffset = value.DateTimeOffset };
}
```

If the foreign type is not sealed and your own types derive from it, also implement `IPopulator<TValue, TSurrogate>` on the converter. `Populate(in surrogate, value)` copies the surrogate's data into an already constructed instance so the derived layer can be deserialized on top of it. The derived type is a normal `[GenerateSerializer]` class with its own ids.

The generator sees `[RegisterConverter]` and registers the converter automatically. Related registration attributes exist for hand-written parts: `[RegisterSerializer]` for an `IFieldCodec<T>`, `[RegisterCopier]` for an `IDeepCopier<T>`, `[RegisterActivator]` for an `IActivator<T>`. Hand-written codecs are rarely faster than generated ones. Write one only when the type has semantic structure that field copying misses, such as a sparse array.

## Delegating to JSON or MessagePack

The framework can hand chosen types to another serializer. The predicate decides which types. Configure the same predicate on every silo and client. Types marked `[GenerateSerializer]` always use the generated serializer, even when the predicate matches.

```csharp
// Microsoft.Orleans.Serialization.SystemTextJson
siloBuilder.Services.AddSerializer(serializerBuilder =>
{
    serializerBuilder.AddJsonSerializer(
        isSupported: type => type.Namespace.StartsWith("Example.Namespace"));
});

// Microsoft.Orleans.Serialization.NewtonsoftJson
siloBuilder.Services.AddSerializer(serializerBuilder =>
{
    serializerBuilder.AddNewtonsoftJsonSerializer(
        isSupported: type => type.Namespace.StartsWith("Example.Namespace"));
});

// Microsoft.Orleans.Serialization.MessagePack (Orleans 8.2 and later)
siloBuilder.Services.AddSerializer(serializerBuilder => serializerBuilder.AddMessagePackSerializer(
    isSerializable: type => type.Namespace?.StartsWith("MyApp.Messages") == true,
    isCopyable: type => false,
    configureOptions: options => options.Configure(opts =>
    {
        opts.SerializerOptions = MessagePackSerializerOptions.Standard
            .WithCompression(MessagePackCompression.Lz4BlockArray);
        opts.AllowDataContractAttributes = true;
    })));
```

`MessagePackCodecOptions` has `SerializerOptions`, `AllowDataContractAttributes`, `IsSerializableType` and `IsCopyableType`. The JSON serializers take an `isCopyable` predicate too; a JSON-delegated type is copied by round-tripping through JSON unless you say it is immutable.

Trade-offs from the docs: the native serializer has the best .NET fidelity and object identity; MessagePack has the smallest payloads and works with non-.NET clients; System.Text.Json is text and interoperable but has limited type fidelity and no object identity. All three are version tolerant.

For a fully custom provider, implement `IGeneralizedCodec`, `IGeneralizedCopier` and `ITypeFilter`, register the implementation as singletons for all three interfaces on `ISerializerBuilder.Services`, and expose it as an `AddXxxSerializer` extension on `ISerializerBuilder`.

## Exceptions

Exceptions cross grain calls. The exception codec (`Orleans.Serialization.ExceptionCodec`) carries `Message`, `StackTrace`, `InnerException`, `Data` and `HResult` through the `ISerializable` contract (`GetObjectData` and the serialization constructor). `AggregateException` is handled by a dedicated surrogate that keeps `InnerExceptions`.

The codec accepts exception types whose namespace starts with one of `ExceptionSerializationOptions.SupportedNamespacePrefixes` (defaults: `Microsoft`, `System`, `Azure`) or that pass `SupportedExceptionTypeFilter`. For your own exception types, either:

- mark them `[GenerateSerializer]` with `[Id]` members, the same as any other type; or
- widen the options: `services.Configure<ExceptionSerializationOptions>(o => o.SupportedNamespacePrefixes.Add("MyApp"))`.

When the receiver cannot resolve or construct the exception type, it gets an `UnavailableExceptionFallbackException` whose `ExceptionType` holds the original type name and whose `Properties` dictionary holds the serialized entries. Catch that type on clients that do not reference the silo's exception assemblies.

## The source generator and analyzers

`Microsoft.Orleans.CodeGenerator` runs as a Roslyn source generator. It generates serializers, copiers, activators, grain references and invokers for the declaring assembly. There is no separate MSBuild code generation step and no `ConfigureApplicationParts` (both were Orleans 3.x). To generate code for types from another assembly that you cannot annotate, add `[assembly: GenerateCodeForDeclaringAssembly(typeof(SomeTypeInThatAssembly))]`.

Analyzer diagnostics (ids from the shipped rules, all category Usage):

- ORLEANS0001 (error): `[AlwaysInterleave]` belongs on the grain interface method, not the grain class method.
- ORLEANS0002 (error): `ref`, `out` and `in` parameters are not allowed on grain interface methods.
- ORLEANS0004 (error): add `[Id]` or `[NonSerialized]` to the members of a `[GenerateSerializer]` type. Code fix available.
- ORLEANS0005 (info): a `[Serializable]` type should get `[GenerateSerializer]`. Code fix available.
- ORLEANS0006 (error): abstract properties cannot be serialized.
- ORLEANS0008 (error): grain interfaces cannot declare properties.
- ORLEANS0009 (error): grain interface methods must return `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>`, `void` (one-way) or `IAsyncEnumerable<T>`.
- ORLEANS0010 (info): add a missing `[Alias]`. Code fix available.
- ORLEANS0011 (error): an `[Alias]` value must be unique.
- ORLEANS0012 (error): each `[Id]` must be unique within the declaring type.
- ORLEANS0013 (error): this attribute belongs on the grain interface, not the grain implementation.

ORLEANS0003 (inherit from `Grain`) shipped in 3.3 and was removed in 7.0, because POCO grains that implement `IGrainBase` are supported.

## Grain storage serializers

Since Orleans 7.0 every supported storage provider exposes `IStorageProviderSerializerOptions.GrainStorageSerializer` on its options class: `AzureBlobStorageOptions`, `AzureTableStorageOptions`, `DynamoDBStorageOptions`, `AdoNetGrainStorageOptions`, `RedisStorageOptions`, `CosmosGrainStorageOptions` and so on. The serializer implements `Orleans.Storage.IGrainStorageSerializer` (`Serialize<T>` to a `BinaryData`, `Deserialize<T>` from one).

Built-in implementations: `JsonGrainStorageSerializer` (Newtonsoft.Json, the documented default for the Azure and ADO.NET providers), `OrleansGrainStorageSerializer` (the binary Orleans serializer, the default the Redis docs name), and `SystemTextJsonGrainStorageSerializer` from the SystemTextJson package. Set the one you want at configuration time:

```csharp
siloBuilder.AddAzureBlobGrainStorage(
    "MyGrainStorage",
    (OptionsBuilder<AzureBlobStorageOptions> optionsBuilder) =>
    {
        optionsBuilder.Configure<IMySerializer>(
            (options, serializer) => options.GrainStorageSerializer = serializer);
    });
```

Guidance: state outlives code, so choose a serializer you can evolve. JSON is readable and tolerant of added members. The binary Orleans serializer is compact and also version tolerant when you follow the id rules above. Whatever you pick, keep loading data written by the previous version before you deploy a change.

## Migration notes from Orleans 3.x

- The 3.x serializer generated code for `[Serializable]` types, used `BinaryFormatter` or `ILBasedSerializer` as fallbacks, and had no version tolerance. It is gone. `BinaryFormatter` is unsafe and removed from .NET.
- Replace `[Serializable]` with `[GenerateSerializer]` and add `[Id]` to members. The ORLEANS0005 code fix helps.
- Remove `Microsoft.Orleans.CodeGenerator.MSBuild` and `Microsoft.Orleans.OrleansCodeGenerator.Build`. Reference `Microsoft.Orleans.Sdk`. Replace `[KnownAssembly]` with `[GenerateCodeForDeclaringAssembly]`.
- `[CopierMethod]`, `[SerializerMethod]`, `[DeserializerMethod]`, `[Serializer(typeof(T))]`, `IExternalSerializer` and `SerializationProviderOptions` are 3.x APIs. Use `[RegisterConverter]` surrogates, `[RegisterSerializer]` codecs, or the JSON delegation above.
- Custom exception types no longer need the `ISerializable` constructor pattern for Orleans; the codec handles it, subject to the namespace rule above.
- The wire protocol is incompatible with 3.x. A rolling upgrade is not possible. Deploy a new cluster.

## Common errors

- `CodecNotFoundException: Could not find a codec for type X` (or `Could not find a copier for type X`). The type is not `[GenerateSerializer]`, is not covered by a delegation predicate, and has no surrogate. Mark it, or register a converter, or route its namespace to JSON. If it is generic, check the type arguments too. If the type lives in an assembly without the Sdk reference, add `Microsoft.Orleans.Sdk` there or use `[GenerateCodeForDeclaringAssembly]`.
- Members silently null after a call: the member has no `[Id]`, or it is marked `[NonSerialized]`.
- Values differ across the cluster after a deploy: an id was reused or changed, or a base class was inserted. Compare the type against the last released build.
- `UnavailableExceptionFallbackException` on the client: the client does not reference the assembly that declares the exception, or the exception's namespace is outside the supported prefixes.
- A JSON-delegated type never reaches the JSON serializer: it also carries `[GenerateSerializer]`, which wins.
- Slow local calls with large arrays: they are being deep copied. Use `[Immutable]` or `Immutable<T>`.

## Sources

- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/serialization?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/serialization-configuration?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/serialization-immutability?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/serialization-customization?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-persistence/?pivots=orleans-10-0
- https://learn.microsoft.com/en-us/dotnet/orleans/migration-guide?pivots=orleans-10-0
- https://raw.githubusercontent.com/dotnet/docs/main/docs/orleans/host/configuration-guide/serialization.md
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Analyzers/AnalyzerReleases.Shipped.md
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Serialization/ISerializableSerializer/ExceptionCodec.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Serialization/ISerializableSerializer/ExceptionSerializationOptions.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Serialization/ISerializableSerializer/UnavailableExceptionFallbackException.cs
- https://raw.githubusercontent.com/dotnet/orleans/main/src/Orleans.Serialization/Serializers/CodecProvider.cs

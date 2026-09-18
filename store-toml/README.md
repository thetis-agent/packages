# @thetis/store-toml

The default storage driver: one TOML file per document. The host opens it once with the store's root directory, and every namespaced store the service plane keeps its records in (people, tokens, the registry, configuration, package data) reads and writes through it. A document is a JSON object; the file is its canonical TOML spelling, so a person can read or fix a record with an editor and an unchanged document is an unchanged file.

## What it provides

A package of type `storage`. Not installable: it runs on the host, chosen by `storage.driver` in `thetis.config.json`, never placed into a fence. It depends on `@thetis/contracts` for the `Store` interfaces and on `@thetis/lib` for the shared id and document checks.

One export, `createStore({ root, log })`, returns a `StoreDriver`. `parse` and `stringify` are exported too, for anyone who wants the codec on its own.

## Layout

```
<root>/<namespace>/<key>.toml
```

A namespace and a key are one or more segments joined by `/`; each segment becomes a directory, the last key segment a file. The key `@thetis/exa` in the namespace `registry/packages` is `<root>/registry/packages/@thetis/exa.toml`. Ids are checked by `assertStoreId` before they touch the disk, so a segment is never `.`, `..` or empty and never leaves the root. Namespaces nest: `clear()` on `a` removes the directory and so every document of `a/b` as well, which is what the contract asks for.

`set` writes `<file>.<pid>.<n>.tmp` next to the file and renames it over the old one, so a reader sees the old document or the new one and never a half. `list` walks the namespace directory and reports `.toml` files only; a temporary file left by a crash is ignored, as is anything else. `get` of a missing key is `undefined`; a file that does not parse fails with its path and the line.

## Private namespaces

A namespace opened with `{ private: true }` is closed to other users of the machine: every directory on its path under the root is created or set to mode `0700` and every file is written `0600`. The mode is set when the namespace is opened and again for each directory a write creates, so a namespace that once held shared files becomes private the first time something opens it that way.

## The codec

`src/toml.ts` reads TOML 1.0: tables, arrays of tables, dotted and quoted keys, the four string forms with every escape, integers in every base, floats with `inf` and `nan`, booleans, arrays and inline tables, comments. Date-times are kept as the string they were written as, because a document has no such type. Duplicate keys, redefined tables and extending an inline table are errors that name the line.

The writer is canonical. Keys are sorted; in each table the scalars come first, then every nested object as `[a.b]` and every array of objects as `[[a.b]]` sections; a string with a newline is a multi-line basic string; a key that is not `^[A-Za-z0-9_-]+$` is quoted. An array holding a mix of objects and other values is written inline. Integers beyond 2^53 and `-0` are not preserved exactly because values are JavaScript numbers.

## Writing another driver

Implement `StoreDriver` from `@thetis/contracts`, run every id through `assertStoreId` and every document through `assertStoreDoc` from `@thetis/lib/store`, and declare `"thetis": { "type": "storage", "export": "createStore" }` in `package.json`. Then register the conformance suite in a test:

```ts
import { storeConformance } from "@thetis/lib/store-conformance";
storeConformance("mine", async () => createStore({ root, log }));
```

It checks round-trips of every value shape, listing and prefixes, clear across nested namespaces, id and document rejection, concurrent writes, and the private modes of a file-backed driver (one that exposes `root` on the driver). Passing it is what makes a driver interchangeable with this one.

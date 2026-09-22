# @thetis/tools-files

Bounded, path-contained file tools for the model: read, edit, write, search, find and list, each returning token-bounded output with a footer that says whether more remains. It is a `tool` package in the default `systemPackages["*"]`, so it runs in each person's fence. It is plain ECMAScript with no build step and no dependencies.

## What it provides

Six tools, declared in `thetis.tools`:

| Tool | Arguments | Returns |
|---|---|---|
| `read_path` | `path` (required), `offset` (1-based line, default 1), `limit` (default 400, max 2000) | Numbered lines, then `[lines 1-400 of 2310; read on with offset 401]`. Binary files and files over 4 MiB are refused. |
| `edit_path` | `path`, `old_text`, `new_text` (required), `replace_all` (default false) | `edited <path> — replaced N occurrence(s) starting at line L` and a numbered snippet around the change. `old_text` must match exactly once unless `replace_all`. The write is atomic. |
| `write_path` | `path`, `contents` (required), `overwrite` (default false) | `wrote <path> (N lines, M bytes)`. Parent directories are created; an existing file is refused unless `overwrite`. |
| `search_files` | `pattern` (required, a JavaScript regular expression), `path` (default home), `glob`, `mode` (`content`, `files` or `count`), `ignore_case`, `max_results` (default 100, max 1000) | `path:line:text` lines, or paths with match counts, or a total; always a tally line, and a note that says how to narrow when the answer is partial. |
| `find_files` | `glob` (required), `path` (default home), `max_results` (default 200) | Paths, newest modification first, then `N files matching <glob>`. |
| `get_directory` | `path` (default home), `depth` (default 1, max 3) | Entries, directories first with a trailing `/`, sizes for files, and an entry count; at most 500 entries. |

Bench suites: `assembly-cost@1` and `tool-recall@1`, peer group `tools`. `BENCH.md` in this directory is the generated comparison.

![tool-recall@1 comparison](bench/tool-recall-v1/chart.svg)

No steps, no service, no UI.

Rules every tool follows:

- **Paths.** Relative to the person's home, or absolute. The roots are the home (read and write), the shared directory (read only), and each mount the fence announces in `THETIS_MOUNTS`. A path outside every root is refused: `<path> is outside the spaces you can reach (home rw, shared ro, ...)`. Empty paths, NUL bytes and dangling symlinks are refused. A component named `.git` is protected from writes. Paths inside the home come back relative to it, so a returned path can be passed straight back in.
- **Bounded output.** Every result and every refusal passes through a spill bound of 32768 characters. Over it, the whole text goes to `tool-output/<tool>-<time>.txt` in the home and the model gets the head, a line `[... N of M characters not shown here ...]`, the tail, and a footer naming the file and how to read on.
- **Failures are marked.** A refusal comes back as `error: <sentence>`, so the transcript shows a failed call.
- **Skip list.** `search_files`, `find_files` and `get_directory` (below the top level) skip `.git`, `node_modules`, `dist`, `target`, `.cache`, `tool-output` and binary files, and scan at most 20000 files.

## Configuration

`config.packages["@thetis/tools-files"]` has no keys. The package reads one environment variable, set by the fence and not by a person: `THETIS_MOUNTS`, the mounts the person was granted, read once when the package loads.

## Use

Tool calls as the model makes them:

```
read_path { path: "packages/hello/index.js", offset: 1, limit: 200 }
search_files { pattern: "export async function", path: "packages", glob: "*.js", mode: "files" }
edit_path { path: "notes.md", old_text: "## Notes\n", new_text: "## Notes\n- Prefer short answers.\n" }
write_path { path: "packages/hello/index.js", contents: "export async function greet(args) { return `hi ${args.name}`; }\n" }
```

A refused edit says what to do next:

```
error: old_text appears 3 times in packages/hello/index.js. Include enough surrounding lines to make it unique, or pass replace_all to change every occurrence.
```

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: six tools and the bench declaration. |
| `index.js` | Wraps each tool with the spill bound and marks refusals. |
| `lib/paths.js` | Root resolution: home, shared, mounts, symlinks, `.git`. |
| `lib/read-path.js`, `lib/edit-path.js`, `lib/write-path.js` | The three file tools. |
| `lib/search-files.js`, `lib/find-files.js`, `lib/get-directory.js`, `lib/walk.js` | The tree tools and the bounded walk. |
| `lib/spill.js`, `lib/format.js` | The output bound and the footers. |
| `BENCH.md`, `bench/` | The generated benchmark view and reports. |

## Tests

`npm test` from the runtime root. The files are `test/tools.test.js`, `test/paths.test.js`, `test/mounts.test.js` and `test/spill.test.js`, plain `node --test` files over a temporary directory.

// The default storage driver: one TOML file per document, `<root>/<namespace>/<key>.toml`. Namespaces and
// key segments are directories, so a namespace is a subtree and `clear` is one recursive remove. A write
// goes to a temporary file in the same directory and is renamed over the old one, so a reader sees the
// old document or the new one, never a half. Chosen by `storage.driver` in the configuration, never installed.

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { Store, StoreDriver, StoreFactory, StoreOpenOptions } from "@thetis/contracts";
import { CodedError, errorCode } from "@thetis/lib/error";
import { assertStoreDoc, assertStoreId } from "@thetis/lib/store";
import { parse, stringify } from "./toml.js";

export { parse, stringify, TomlError } from "./toml.js";

const EXT = ".toml";
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const SHARED_FILE = 0o644;

export const createStore: StoreFactory = ({ root }) => new TomlDriver(root);

class TomlDriver implements StoreDriver {
  /** Directories already made or set to 0700 for a private namespace, so `set` does not chmod on every write. */
  private readonly privateDirs = new Set<string>();
  private tmpCount = 0;

  /** Public so a test can walk the files; the conformance suite reads it to check private modes. */
  constructor(readonly root: string) {}

  open(namespace: string, opts: StoreOpenOptions = {}): Store {
    assertStoreId(namespace);
    const dir = join(this.root, ...namespace.split("/"));
    const isPrivate = opts.private === true;
    // A namespace opened private once is private from then on, whatever it was before: every directory on
    // its path is closed to other users now, including those an earlier non-private open created.
    if (isPrivate) this.ensureDir(dir, true);
    return new TomlStore(this, dir, isPrivate);
  }

  async close(): Promise<void> {}

  /** Makes `dir` and its parents below the root. Private directories are 0700 whether new or already there. */
  ensureDir(dir: string, isPrivate: boolean): void {
    if (!isPrivate) {
      mkdirSync(dir, { recursive: true });
      return;
    }
    // clear() may have removed this namespace or an ancestor since its last write.
    if (this.privateDirs.has(dir) && existsSync(dir)) return;
    const parent = dirname(dir);
    if (parent !== dir && parent.length > this.root.length && parent.startsWith(this.root + sep)) this.ensureDir(parent, true);
    else mkdirSync(parent, { recursive: true });
    if (!existsSync(dir)) mkdirSync(dir, { mode: PRIVATE_DIR });
    chmodSync(dir, PRIVATE_DIR);
    this.privateDirs.add(dir);
  }

  /** A name no other write in this process uses, next to the file so the rename stays on one filesystem. */
  tmpName(file: string): string {
    this.tmpCount++;
    return `${file}.${process.pid}.${this.tmpCount}.tmp`;
  }
}

class TomlStore implements Store {
  constructor(
    private readonly driver: TomlDriver,
    private readonly dir: string,
    private readonly isPrivate: boolean,
  ) {}

  private file(key: string): string {
    assertStoreId(key);
    return join(this.dir, ...key.split("/")) + EXT;
  }

  async get<T extends object = Record<string, unknown>>(key: string): Promise<T | undefined> {
    const file = this.file(key);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if (errorCode(err) === "ENOENT") return undefined;
      throw err;
    }
    try {
      return parse(text) as T;
    } catch (err) {
      throw new CodedError(`${file}: ${err instanceof Error ? err.message : String(err)}`, "storage");
    }
  }

  async set(key: string, doc: object): Promise<void> {
    const file = this.file(key);
    // No size cap here: the kernel caps what a fence sends; the service plane's own records are trusted.
    assertStoreDoc(doc, Infinity);
    const text = stringify(doc as Record<string, unknown>);
    this.driver.ensureDir(dirname(file), this.isPrivate);
    const tmp = this.driver.tmpName(file);
    try {
      await writeFile(tmp, text, { mode: this.isPrivate ? PRIVATE_FILE : SHARED_FILE });
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async list(prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    await this.walk(this.dir, "", keys);
    return prefix === "" ? keys : keys.filter((k) => k.startsWith(prefix));
  }

  private async walk(dir: string, rel: string, keys: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (errorCode(err) === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const name = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await this.walk(join(dir, entry.name), name, keys);
      // Anything but `.toml` is a temporary file mid-write or a stranger; neither is a document.
      else if (entry.isFile() && entry.name.endsWith(EXT)) keys.push(name.slice(0, -EXT.length));
    }
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

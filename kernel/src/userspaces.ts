import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Userspace } from "./types.js";

/** Owns the on-disk layout of each user's fenced environment. */
export class UserspaceManager {
  constructor(private readonly home: string) {}

  pathFor(userId: string): Userspace {
    const root = resolve(this.home, "userspaces", userId);
    return {
      id: userId,
      root,
      home: resolve(root, "home"),
      store: resolve(root, "store"),
      sessions: resolve(root, "sessions"),
      run: resolve(root, "run"),
    };
  }

  exists(userId: string): boolean {
    return existsSync(this.pathFor(userId).root);
  }

  /** Creates the userspace directories if missing. Idempotent. */
  ensure(userId: string): Userspace {
    const us = this.pathFor(userId);
    for (const dir of [us.home, resolve(us.store, "node_modules"), resolve(us.store, "src"), us.sessions, us.run]) {
      mkdirSync(dir, { recursive: true });
    }
    return us;
  }

  remove(userId: string): void {
    rmSync(this.pathFor(userId).root, { recursive: true, force: true });
  }
}

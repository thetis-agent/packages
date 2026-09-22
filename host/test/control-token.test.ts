// The command line finds the daemon's token where the unit put it: a system unit's RuntimeDirectory first,
// then a user session's XDG_RUNTIME_DIR, which a login session sets whether or not the daemon runs there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readControlToken } from "../src/control.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test("the token is read from the unit's run directory before the login session's", () => {
  const unit = mkdtempSync(join(tmpdir(), "thetis-run-"));
  const session = mkdtempSync(join(tmpdir(), "thetis-xdg-"));
  try {
    writeFileSync(join(session, "control.token"), "from-the-session\n");
    // A login session alone: the session's directory is the only candidate that holds a token.
    assert.equal(withEnv({ RUNTIME_DIRECTORY: undefined, XDG_RUNTIME_DIR: session }, readControlToken), "from-the-session");
    // The daemon's own directory wins when it holds one, whatever the session says.
    writeFileSync(join(unit, "control.token"), "from-the-unit\n");
    assert.equal(withEnv({ RUNTIME_DIRECTORY: unit, XDG_RUNTIME_DIR: session }, readControlToken), "from-the-unit");
    // Nothing anywhere: this daemon requires no token.
    assert.equal(withEnv({ RUNTIME_DIRECTORY: undefined, XDG_RUNTIME_DIR: join(session, "nope") }, readControlToken), undefined);
  } finally {
    rmSync(unit, { recursive: true, force: true });
    rmSync(session, { recursive: true, force: true });
  }
});

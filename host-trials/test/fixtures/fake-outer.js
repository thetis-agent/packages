// The outer runner as its own process (its name ends in outer.js, which is how the liveness check knows a
// runner), with the fake inner and short timings: `node fake-outer.js <trial dir> <script json>`.
import { runTrial } from "../../lib/outer.js";
import { FAST, fakeCommand } from "../helpers.js";

await runTrial(process.argv[2], { ...FAST, command: fakeCommand(JSON.parse(process.argv[3] ?? "{}")) });
process.exit(0);

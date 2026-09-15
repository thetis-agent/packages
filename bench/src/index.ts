// The bench: it boots its own kernel, runs a suite of tasks against each arm, and scores what the harness
// assembled. Nothing here runs inside a fence, and nothing here is installable.
export * from "./metrics/index.js";
export * from "./arena.js";
export * from "./capture.js";
export * from "./manifest.js";
export * from "./peers.js";
export * from "./report.js";
export * from "./runner.js";
export * from "./score.js";
export * from "./suite.js";
export { run, verify, main, FLOOR } from "./cli.js";

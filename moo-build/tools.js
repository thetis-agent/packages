// The moo_build_* tools: author a Torchship area on a grid.
//
// A build is an $area in the configured character's .builds list -- the list
// the Shaper Feature's @dig checks -- and every tool that changes anything
// names the build it acts on, the way a terminal tool names its session. A
// room can be set, created or deleted only when it belongs to that build.
//
// The model works in cells and compass directions. Turning that into MOO
// objects -- rooms from the @dig room type, exit pairs with twins, long
// direction names and aliases, area membership, peek links across areas, the
// route cache -- happens here, so it is never reasoned about twice.

import { connect, listBuilds, snapshot, createBuild, execute, describe } from "./lib/run.js";
import { planSetRooms, planDeleteRooms, planLink, planUnlink, normalizeId } from "./lib/plan.js";
import { renderLevels, legend } from "./lib/grid.js";
import { levelSvg, toPng, populatedLevels, levelName } from "./lib/image.js";

const MAX_OUTPUT = 32_000;

function bounded(text) {
  if (text.length <= MAX_OUTPUT) return text;
  const end = text.lastIndexOf("\n", MAX_OUTPUT - 300);
  return (
    text.slice(0, end > 0 ? end : MAX_OUTPUT - 300) +
    `\n\n[cut: ${text.length} characters in all. Ask for one level with z, or leave descriptions off.]`
  );
}

const need = (args, k) => {
  const v = args?.[k];
  if (v === undefined || v === null || v === "") throw new Error(`missing ${k}`);
  return v;
};

function buildId(args) {
  const id = normalizeId(need(args, "build"));
  if (!id) throw new Error(`build must be an area id such as #123, from moo_build_list; got ${JSON.stringify(args.build)}`);
  return id;
}

const COORDS = "x grows east, y grows south, z grows down (0 is ground level, up is negative)";

function header(b) {
  const levels = [...new Set(b.rooms.map((r) => r.z))].sort((a, c) => a - c);
  const span = (k) => {
    const v = b.rooms.map((r) => r[k]);
    return v.length ? `${Math.min(...v)}..${Math.max(...v)}` : "-";
  };
  return [
    `Build ${b.id} "${b.name}": ${b.rooms.length} room${b.rooms.length === 1 ? "" : "s"}` +
      (b.rooms.length ? ` on ${levels.length} level${levels.length === 1 ? "" : "s"}, x ${span("x")}, y ${span("y")}` : "") + ".",
    b.authored
      ? `It is one of ${b.character}'s builds, so these tools can change it.`
      : `It is NOT one of ${b.character}'s builds: it can be read here but not changed.`,
    `Coordinates: ${COORDS}.`,
  ].join("\n");
}

/** The whole picture of a build: header, map, legend, and optionally more. */
function picture(b, { z, descriptions = false } = {}) {
  const parts = [header(b), "", renderLevels(b, { z }), "", "Rooms (label id \"name\" (x,y,z)  exits):", legend(b) || "(none)"];
  const edges = b.rooms.flatMap((r) => r.edges.map((g) => ({ ...g, from: r.id })));
  if (edges.length) {
    parts.push("", "Edges (jump/descend ledges; read-only here):");
    for (const g of edges) parts.push(`${g.from} ${g.dir} edge ${g.id}: success → ${g.success}, fail → ${g.fail}`);
  }
  if (descriptions) {
    parts.push("", "Descriptions:");
    for (const r of b.rooms) parts.push(`${r.id} "${r.name}":`, r.description ? r.description : "(none)", "");
  }
  return parts.join("\n");
}

/** What a write reports: what ran, what failed and why, and the build after. */
async function report(conn, build, plan, result, { z }) {
  const lines = [];
  if (result.done.length) {
    lines.push(`Done (${result.done.length}):`, ...result.done.map((o) => "  " + describe(o)));
  }
  if (result.failed) {
    lines.push("", `FAILED, and nothing after it was run:`, "  " + describe(result.failed), `  ${result.failed.error}`);
  }
  if (result.notRun.length) lines.push("", `Not run (${result.notRun.length}):`, ...result.notRun.map((o) => "  " + describe(o)));
  if (result.finish) lines.push("", result.finish);
  if (!plan.length) lines.push("Nothing to change: the build already matches.");
  try {
    const after = await snapshot(conn, build, { authority: false });
    lines.push("", picture(after, { z }));
  } catch (e) {
    lines.push("", `The build could not be read back (${e.message}); call moo_build_get.`);
  }
  return bounded(lines.join("\n"));
}

function refused(errors) {
  return (
    `Nothing was changed: the request has ${errors.length} problem${errors.length === 1 ? "" : "s"}.\n` +
    errors.map((e) => `- ${e}`).join("\n")
  );
}

function dryRun(ops) {
  return ops.length
    ? `Dry run: nothing was changed. This would run ${ops.length} operation${ops.length === 1 ? "" : "s"}:\n` + ops.map((o) => "  " + describe(o)).join("\n")
    : "Dry run: nothing to change; the build already matches.";
}

// ===========================================================================

export async function list(args, env) {
  const conn = await connect(env);
  const all = Boolean(args?.all);
  const v = await listBuilds(conn, { all });
  const areas = Array.isArray(v?.areas) ? v.areas : [];
  const who = `${v?.character_name ?? "?"} (${v?.character ?? "?"})`;
  const lines = [];
  if (!Number(v?.has_builds)) {
    lines.push(
      `${who} has no .builds list, so it can own no builds. A builder inherits one from Generic Builder #4 or ` +
        `Generic Shaper #268; give the character one of those parents, or configure moo with a character that has it.`,
    );
  }
  const mine = areas.filter((a) => Number(a.authored));
  lines.push(all ? `Areas with rooms (${areas.length}); ✎ marks ${who}'s builds:` : `${who}'s builds (${mine.length}):`);
  for (const a of all ? areas : mine) {
    lines.push(`${all && Number(a.authored) ? "✎ " : "  "}${a.id} "${a.name}": ${a.rooms} room${a.rooms === 1 ? "" : "s"}`);
  }
  if (!all && !mine.length) lines.push("  (none yet: moo_build_create makes one)");
  if (!all) lines.push("", "Pass all: true to see every area in the world. Only a build can be changed by these tools.");
  return bounded(lines.join("\n"));
}

export async function create(args, env) {
  const name = String(need(args, "name")).trim();
  if (!name) throw new Error("name must not be empty");
  const first = args.first_room;
  if (first !== undefined) {
    if (typeof first?.name !== "string" || !first.name.trim()) throw new Error("first_room needs a name");
    for (const k of ["x", "y", "z"]) {
      if (first[k] !== undefined && !Number.isInteger(first[k])) throw new Error(`first_room.${k} must be an integer`);
    }
    if (first.description !== undefined && typeof first.description !== "string") throw new Error("first_room.description must be a string");
  }
  const conn = await connect(env);
  const room = first ? { name: first.name.trim(), x: first.x ?? 0, y: first.y ?? 0, z: first.z ?? 0, description: first.description } : undefined;
  let made;
  try {
    made = await createBuild(conn, { name, room }, env.config);
  } catch (e) {
    throw new Error(
      `${e.message}\n\nIf this failed after the area was made, it may exist with no rooms: moo_build_list shows it, and it can be ` +
        `used as it is. Do not call moo_build_create again with the same name without looking first.`,
    );
  }
  const id = Array.isArray(made) ? made[0] : made;
  const b = await snapshot(conn, id, { authority: false });
  return bounded(`Created build ${id} "${name}". Pass build: "${id}" to the other moo_build_* tools.\n\n${picture(b)}`);
}

export async function get(args, env) {
  const build = buildId(args);
  if (args.z !== undefined && !Number.isInteger(args.z)) throw new Error("z must be an integer");
  const conn = await connect(env);
  const b = await snapshot(conn, build, { authority: false });
  if (args.json) return bounded(JSON.stringify(b, null, 2));
  return bounded(picture(b, { z: args.z, descriptions: Boolean(args.descriptions) }));
}

export async function setRooms(args, env) {
  const build = buildId(args);
  const conn = await connect(env);
  // The planner works on the build as it is now, read with authority checked.
  const b = await snapshot(conn, build);
  const plan = planSetRooms(b, args.rooms);
  if (plan.errors) return refused(plan.errors);
  if (args.dry_run) return dryRun(plan.ops);
  const result = await execute(conn, build, plan.ops, env.config);
  return report(conn, build, plan.ops, result, { z: args.z });
}

export async function deleteRooms(args, env) {
  const build = buildId(args);
  const conn = await connect(env);
  // The planner works on the build as it is now, read with authority checked.
  const b = await snapshot(conn, build);
  const plan = planDeleteRooms(b, args.rooms);
  if (plan.errors) return refused(plan.errors);
  if (args.dry_run) return dryRun(plan.ops);
  const result = await execute(conn, build, plan.ops, env.config);
  return report(conn, build, plan.ops, result, {});
}

export async function link(args, env) {
  const build = buildId(args);
  const conn = await connect(env);
  // The planner works on the build as it is now, read with authority checked.
  const b = await snapshot(conn, build);
  const plan = planLink(b, args);
  if (plan.errors) return refused(plan.errors);
  const result = await execute(conn, build, plan.ops, env.config);
  return report(conn, build, plan.ops, result, {});
}

export async function unlink(args, env) {
  const build = buildId(args);
  const conn = await connect(env);
  // The planner works on the build as it is now, read with authority checked.
  const b = await snapshot(conn, build);
  const plan = planUnlink(b, args);
  if (plan.errors) return refused(plan.errors);
  const result = await execute(conn, build, plan.ops, env.config);
  return report(conn, build, plan.ops, result, {});
}

// At most this many levels in one call without `z`: each image costs the model
// tokens, and a tall building is better read a level or two at a time.
const MAX_IMAGES = 6;

/**
 * A build as pictures, one per populated level, drawn in the website map
 * editor's style. The answer is a tool result whose content is the text and
 * one image asset per level: the provider hands the images to the model, and
 * the web UI shows them under the tool call in the conversation.
 */
export async function render(args, env) {
  const build = buildId(args);
  if (args.z !== undefined && !Number.isInteger(args.z)) throw new Error("z must be an integer");
  const put = env?.kernel?.assets?.put;
  if (typeof put !== "function") throw new Error("this space has no asset store to put images in; moo_build_get draws the build as text");
  const conn = await connect(env);
  const b = await snapshot(conn, build, { authority: false });
  const all = populatedLevels(b);
  if (!all.length) return `${header(b)}\n\nIt has no rooms yet, so there is nothing to draw.`;
  if (args.z !== undefined && !all.includes(args.z)) {
    return `${header(b)}\n\nNo rooms on level z=${args.z}. Populated levels: ${all.join(", ")}.`;
  }
  const levels = args.z !== undefined ? [args.z] : all.slice(0, MAX_IMAGES);
  const slug = (b.name || "build").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "build";
  const assets = [];
  const lines = [];
  for (const z of levels) {
    const png = await toPng(levelSvg(b, z, { ghost: args.ghost !== false }));
    const asset = await put({ mediaType: "image/png", name: `${slug}-z${z}.png`, data: Buffer.from(png.buf).toString("base64") });
    assets.push({ type: "asset", data: { id: asset.id, mediaType: asset.mediaType ?? "image/png", name: asset.name ?? `${slug}-z${z}.png` } });
    const count = b.rooms.filter((r) => r.z === z).length;
    lines.push(`image ${assets.length}: level z=${z} (${levelName(z)}), ${count} room${count === 1 ? "" : "s"}, ${png.width}×${png.height}`);
  }
  const rest = args.z === undefined ? all.slice(MAX_IMAGES) : [];
  const text = [
    header(b),
    "",
    ...lines,
    ...(rest.length ? [`Not drawn: levels ${rest.join(", ")}. Pass z to draw one of them.`] : []),
    "",
    "Drawn as the website's map editor draws it: lines are exits, coloured by type (grey open, orange door with a crossbar, " +
      "green climb, blue swim), dashed when hidden; a triangle in a room's corner is an up or down exit, ringed when it leaves " +
      "the build; a dashed tag names the area an exit leads into; a pink arc is a jump edge, its ↓ the failure landing; dashed " +
      "outlines are the rooms of the level below. The small number in each room is its label in the list below.",
    "",
    "Rooms (label id \"name\" (x,y,z)  exits):",
    legend(b),
  ].join("\n");
  return { type: "tool-result", content: [{ type: "text", data: { text: bounded(text) } }, ...assets] };
}

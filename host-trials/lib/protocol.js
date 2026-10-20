// The lines between the outer runner and the inner one. The inner writes `@@trial <json>` lines on stdout
// (anything else there is log); the outer writes plain JSON lines on the inner's stdin.
//
// inner -> outer:
//   {type: "isolated", overlays, masked, sentinels, docker}   then waits for {go: true}
//   {type: "session", id}
//   {type: "progress", costUsd, tokens}
//   {type: "file", path, content}                             relative to the run's directory
//   {type: "end", state, error?, costUsd, tokens}
//   {type: "fail", error, isolation}                          nothing more comes
// outer -> inner:
//   {go: true}
//   {cancel: "cancelled" | "budget" | "timeout"}
export const MARK = "@@trial ";

export function parseLine(line) {
  if (!line.startsWith(MARK)) return null;
  try {
    const msg = JSON.parse(line.slice(MARK.length));
    return msg && typeof msg === "object" && typeof msg.type === "string" ? msg : null;
  } catch {
    return null;
  }
}

export const line = (msg) => MARK + JSON.stringify(msg) + "\n";

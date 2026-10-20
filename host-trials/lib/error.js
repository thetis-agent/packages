/** An error with a short machine-readable code, the shape the operator channel carries across a socket or a fence. */
export function fail(message, code = "invalid") {
  throw Object.assign(new Error(message), { code });
}

export function assert(cond, message, code = "invalid") {
  if (!cond) fail(message, code);
}

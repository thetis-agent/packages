/* The JSON API and the event stream. Every call carries the login cookie; a 401 sends the page to sign in. */

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * The same call with a `File` or `Blob` as the body, sent as it is. There is no multipart here and no
 * form: the one thing being uploaded is the file, so it travels as the whole body and the server reads the
 * bytes straight off the request. The browser sets `content-type` from the blob; the server decides what
 * the file really is from its first bytes, so nothing rests on that header.
 */
export async function apiBytes(path, blob, { method = "PUT" } = {}) {
  return request(path, { method, body: blob });
}

async function request(path, init) {
  let res;
  try {
    res = await fetch(path.replace(/^\//, ""), { credentials: "same-origin", ...init, headers: { accept: "application/json", ...(init.headers ?? {}) } });
  } catch {
    throw new ApiError(0, "Not connected.");
  }
  if (res.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(401, "Signed out.");
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText || "Request failed.");
  return data;
}

/**
 * Opens the event stream. The browser reconnects by itself; every connection starts with a snapshot.
 * `sessions` says the list changed on the server (another tab created, named or archived a conversation).
 */
export function connect({ onSnapshot, onTurn, onSessions, onStatus }) {
  const source = new EventSource("api/events");
  source.addEventListener("open", () => onStatus("online"));
  source.addEventListener("error", () => onStatus(source.readyState === EventSource.CLOSED ? "offline" : "connecting"));
  source.addEventListener("snapshot", (event) => onSnapshot(JSON.parse(event.data)));
  source.addEventListener("turn", (event) => onTurn(JSON.parse(event.data)));
  source.addEventListener("sessions", () => onSessions?.());
  return source;
}

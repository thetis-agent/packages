/* The JSON API and the event stream. Every call carries the login cookie; a 401 sends the page to sign in. */

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

/** Opens the event stream. The browser reconnects by itself; every connection starts with a snapshot. */
export function connect({ onSnapshot, onTurn, onStatus }) {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => onStatus("online"));
  source.addEventListener("error", () => onStatus(source.readyState === EventSource.CLOSED ? "offline" : "connecting"));
  source.addEventListener("snapshot", (event) => onSnapshot(JSON.parse(event.data)));
  source.addEventListener("turn", (event) => onTurn(JSON.parse(event.data)));
  return source;
}

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

/** The waits between reconnect attempts: one second, doubling, never more than fifteen. */
export const RECONNECT_FIRST_MS = 1000;
export const RECONNECT_MAX_MS = 15_000;
/** The longest wait while somebody is waiting for Thetis to come back (`ext.awaitReturn`). */
const HURRIED_MS = 2000;

/**
 * Opens the event stream and keeps it open. Every connection starts with a snapshot. `sessions` says the
 * list changed on the server (another tab created, named or archived a conversation).
 *
 * The browser's own reconnect is not relied on: an HTTP 502 or 503 from the door while Thetis restarts
 * closes an `EventSource` for good, and the page used to sit "offline" until somebody reloaded it. So any
 * error closes the source here, and the page tries again itself: after one second, then two, four, up to
 * fifteen, saying "reconnecting" all the while. Before each attempt `probe()` asks something cheap (the
 * page asks `/api/me`, which also sends a signed-out page to sign in); only when it answers is a new
 * stream opened, so a dead gateway costs one small request per attempt and not a stream that fails.
 * `hurry(true)` caps the wait at two seconds while something is waiting for Thetis to come back.
 */
export function connect({ onSnapshot, onTurn, onSessions, onStatus, probe }) {
  let source = null;
  let wait = RECONNECT_FIRST_MS;
  let timer = null;
  let hurried = 0;

  function open() {
    const here = new EventSource("api/events");
    source = here;
    here.addEventListener("open", () => {
      wait = RECONNECT_FIRST_MS;
      onStatus("online");
    });
    here.addEventListener("error", () => {
      if (source !== here) return;
      here.close();
      source = null;
      onStatus("reconnecting");
      later();
    });
    here.addEventListener("snapshot", (event) => onSnapshot(JSON.parse(event.data)));
    here.addEventListener("turn", (event) => onTurn(JSON.parse(event.data)));
    here.addEventListener("sessions", () => onSessions?.());
  }

  function later() {
    clearTimeout(timer);
    const ms = hurried ? Math.min(wait, HURRIED_MS) : wait;
    wait = Math.min(wait * 2, RECONNECT_MAX_MS);
    timer = setTimeout(() => void attempt(), ms);
  }

  async function attempt() {
    timer = null;
    try {
      await probe?.();
    } catch (err) {
      if (err?.status === 401) return; // the page is on its way to sign in
      return later();
    }
    if (!source) open();
  }

  open();
  return {
    /** Shortens the wait between attempts while at least one caller has it on. An attempt already booked is brought forward. */
    hurry(on) {
      hurried = Math.max(0, hurried + (on ? 1 : -1));
      if (on && timer && !source) {
        clearTimeout(timer);
        timer = setTimeout(() => void attempt(), Math.min(HURRIED_MS, wait));
      }
    },
  };
}

// Shared Notion API client, formatting and error handling.
//
// Every notion_* tool imports this one module instead of carrying its own copy.
// The old (Rust/wasm) version of this tool group could not do that — each tool
// was a standalone component with no workspace to hold a common library, so the
// same client.rs was duplicated verbatim into eleven crates and kept in sync by
// hand. Thetis packages have no such boundary: one file, eleven importers.
//
// Everything talks to api.notion.com over the platform's global fetch. Node 24
// ships fetch built in, so there is nothing here to install.

export const API_BASE = "https://api.notion.com";

// The API version this module was written against. Notion *requires* the
// Notion-Version header on every request, and pinning it is the whole point of
// their versioning scheme: Notion promises that a given dated version keeps
// returning the same property shapes forever, and that promise is only worth
// anything if a client actually asks for one dated version instead of
// whatever is newest. A "floating" version — omitting the header, or resolving
// it at request time to "latest" — would mean a shape change on Notion's side
// (a new property type, a renamed field) silently breaks parsing here with no
// commit on this side to point at. Pinning turns that into a deliberate,
// reviewable upgrade: bump the constant, re-read the changelog, ship it.
export const DEFAULT_VERSION = "2026-03-11";

// Markdown longer than this is cut with a note. The tool host truncates output
// at a bound anyway; cutting it here means the tool can say *why* it was cut
// and what to do about it, instead of the text just stopping mid-word.
export const MAX_MARKDOWN_CHARS = 18_000;

// How much of a page to echo back after a write, as a confirmation rather than
// a read. Echoing a whole long page after appending one line would spend
// thousands of tokens answering a yes/no question.
export const PREVIEW_CHARS = 4_000;

const MISSING_TOKEN =
  "no Notion token configured. Create an internal connection or personal access " +
  "token at https://www.notion.so/my-integrations, then set the key `token` on this " +
  "package: the person can do it in the control panel (Configure on the package), or you " +
  "can call configure_package with the value they give you. Every notion_* tool reads the " +
  "same key, so it is set once.\n\n" +
  "To see why it is missing, call package_config for this package: it reports whether the key " +
  "was never set, was set to a ${VAR} reference that is not in the environment, or is inherited " +
  "from the package this one was forked from. The change is live on the next call; no restart.";

/**
 * Builds a client from this tool group's own config block (`env.config`).
 *
 * The token comes from `config.token` and nowhere else: not an environment
 * variable read here, not a fallback, not a default. That is the one place a
 * caller can look to know where the credential comes from, and the one place
 * that has to be right for every tool in the group to work.
 */
export function createClient(config) {
  const cfg = config && typeof config === "object" ? config : {};

  const token = typeof cfg.token === "string" ? cfg.token.trim() : "";
  if (!token) throw new Error(MISSING_TOKEN);

  const version =
    typeof cfg.version === "string" && cfg.version.trim() ? cfg.version.trim() : DEFAULT_VERSION;
  const beta = typeof cfg.beta === "string" && cfg.beta.trim() ? cfg.beta.trim() : undefined;
  const timeoutMs = Math.min(120_000, Math.max(5_000, Number(cfg.timeoutMs ?? 30_000) || 30_000));

  async function send(method, path, query, body) {
    const url = new URL(API_BASE + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers = {
      // The token is used here and only here. It is never interpolated into
      // any string this module returns to a caller or to an error.
      Authorization: `Bearer ${token}`,
      "Notion-Version": version,
      "Content-Type": "application/json",
    };
    if (beta) headers["Notion-Beta"] = beta;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      // A network-level failure. The message from `fetch`/undici can be
      // verbose; keep only what helps, never anything from `headers`.
      throw new Error(`could not reach api.notion.com: ${e && e.message ? e.message : e}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (response.status >= 200 && response.status < 300) {
      if (!text.trim()) return {};
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`Notion's response was not JSON: ${e.message}: ${clip(text, 300)}`);
      }
    }

    throw new Error(explainError(response.status, text));
  }

  const client = {
    get(path, query) {
      return send("GET", path, query);
    },
    post(path, body) {
      return send("POST", path, undefined, body ?? {});
    },
    patch(path, body) {
      return send("PATCH", path, undefined, body ?? {});
    },
    delete(path) {
      return send("DELETE", path);
    },
    send,
    /**
     * Walks a paginated endpoint until `has_more` is false or `max` results
     * are collected, whichever comes first.
     *
     * Returns `{ results, nextCursor }`. `nextCursor` is set only when the
     * walk stopped early, so a caller can report an honest "there is more"
     * rather than implying it saw everything.
     */
    async paginate(method, path, base, max) {
      const collected = [];
      let cursor = base && typeof base.start_cursor === "string" ? base.start_cursor : undefined;

      for (;;) {
        const want = Math.min(100, max - collected.length);
        if (want <= 0) break;

        let response;
        if (method === "GET") {
          const query = {};
          if (base) {
            for (const [k, v] of Object.entries(base)) {
              if (k === "start_cursor" || k === "page_size") continue;
              if (["string", "number", "boolean"].includes(typeof v)) query[k] = v;
            }
          }
          query.page_size = want;
          if (cursor) query.start_cursor = cursor;
          response = await client.get(path, query);
        } else {
          const body = { ...(base ?? {}) };
          body.page_size = want;
          if (cursor) body.start_cursor = cursor;
          else delete body.start_cursor;
          response = await send(method, path, undefined, body);
        }

        const results = Array.isArray(response.results) ? response.results : [];
        collected.push(...results);

        const hasMore = response.has_more === true;
        const next = typeof response.next_cursor === "string" ? response.next_cursor : undefined;

        // A cursor is opaque: pass it back verbatim, never parse it.
        if (hasMore && next && collected.length < max) {
          cursor = next;
          continue;
        }
        if (hasMore) return { results: collected, nextCursor: next };
        return { results: collected, nextCursor: undefined };
      }

      return { results: collected, nextCursor: cursor };
    },
  };

  return client;
}

/**
 * Notion's error body carries a stable `code` and a human `message`. The code
 * is what to branch on; the message is what to show. Both beat a bare status.
 * Never includes the token: it isn't in the response body, and nothing here
 * reads `config` to add it back in.
 */
function explainError(status, text) {
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON; fall through with an empty object
  }
  const code = typeof parsed.code === "string" ? parsed.code : "";
  const message = typeof parsed.message === "string" ? parsed.message : text.trim();
  const lower = message.toLowerCase();

  let hint;
  if (status === 401) {
    hint =
      "The token was rejected. Check the `token` configured for this tool group — a personal " +
      "access token starts with `ntn_`.";
  } else if (status === 404 && code === "object_not_found") {
    hint =
      "Either the id is wrong, or the page/database is not shared with this connection. " +
      "Sharing is per-page in Notion: open the page, ••• menu -> Connections -> add yours. " +
      "Children inherit access from the page you share.";
  } else if (status === 403 && code === "restricted_resource" && lower.includes("user")) {
    // The generic hint below used to talk about comments whatever the call
    // was, which is actively misleading on a user lookup: that one is a hard
    // limit of the token type, not a setting anybody can turn on.
    hint =
      "A personal access token may only look up its own user. Listing a workspace's people " +
      "needs an integration token with user-information capability, so names cannot be " +
      "resolved with this credential; ids still identify people uniquely.";
  } else if (status === 403 && code === "restricted_resource") {
    hint =
      "The connection lacks the capability this call needs. Comment reading and writing are " +
      "off by default; enable them in the connection's Configuration tab.";
  } else if (status === 400 && code === "validation_error" && lower.includes("no matches found")) {
    hint =
      "The text to replace is not on the page. Read the page with notion_page_get first and " +
      "copy the exact wording — whitespace and typographic quotes both matter.";
  } else if (status === 400 && code === "validation_error" && lower.includes("multiple matches")) {
    hint =
      "That text appears more than once, so the edit is ambiguous. Either extend it until it " +
      "is unique, or set replace_all on that edit.";
  } else if (status === 400 && code === "validation_error" && lower.includes("should be defined")) {
    hint =
      "A required field is missing from the request body. The message names it; this is a " +
      "defect in the tool rather than in how it was called.";
  } else if (status === 400 && code === "validation_error") {
    hint =
      "Notion rejected the request body. When writing properties, they must match the parent " +
      "data source's schema exactly — check notion_database_schema.";
  } else if (status === 429) {
    hint = "Rate limited. Wait a moment and retry; the average ceiling is about three requests a second.";
  } else if (status === 409 && code === "conflict_error") {
    hint = "A concurrent edit conflicted. Retrying usually succeeds.";
  }

  let out = `Notion returned ${status}`;
  if (code) out += ` (${code})`;
  out += `: ${clip(message, 600)}`;
  if (hint) out += `\n\n${hint}`;
  return out;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Turns anything that carries a Notion id into a dashed UUID.
 *
 * Accepts a bare id with or without dashes, and any Notion URL — the app
 * slugifies titles with dashes and puts the id last, so both
 * `https://www.notion.so/My-Page-1f2e3d...` and
 * `https://app.notion.com/p/1f2e3d...` reduce to the same thing. A link copied
 * from a database view names the database in its path and the page in `?p=`,
 * so that parameter wins. URLs are what
 * a person actually has to hand, so accepting them is not a nicety.
 */
export function normalizeId(raw, what) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new Error(`missing required argument '${what}'`);

  // A page opened from a database view ("peek") keeps the database in the path and the page in `?p=`;
  // the page is what the person meant.
  const peek = /[?&]p=([0-9a-fA-F-]{32,36})(?:[&#]|$)/.exec(trimmed);
  const core = peek ? peek[1] : trimmed.split(/[?#]/)[0].replace(/\/+$/, "");
  const segment = core.split("/").pop() ?? core;

  const compact = segment.replace(/-/g, "");
  if (compact.length >= 32) {
    const tail = compact.slice(compact.length - 32).toLowerCase();
    if (/^[0-9a-f]{32}$/.test(tail)) {
      return `${tail.slice(0, 8)}-${tail.slice(8, 12)}-${tail.slice(12, 16)}-${tail.slice(16, 20)}-${tail.slice(20, 32)}`;
    }
  }

  throw new Error(
    `${JSON.stringify(raw)} does not look like a Notion ${what}. Give a 32-character id, a ` +
      "dashed UUID, or the page URL copied from Notion."
  );
}

// ---------------------------------------------------------------------------
// Rendering
//
// Notion's JSON is deeply wrapped: every value is an object tagged with its
// own type. Handing that to a model verbatim burns context on braces, so these
// helpers flatten it to lines a reader can scan while keeping every id
// visible, because ids are what the next call needs.
// ---------------------------------------------------------------------------

/** Flattens a rich-text array to plain text, keeping link targets. */
export function richText(value) {
  if (!Array.isArray(value)) return "";
  let out = "";
  for (const item of value) {
    const text = item?.plain_text ?? item?.text?.content ?? "";
    out += text;
    const url = item?.href;
    if (url) out += ` <${url}>`;
  }
  return out;
}

/** The title of a page, data source or database, wherever it happens to live. */
export function titleOf(object) {
  if (object?.title) {
    const text = richText(object.title);
    if (text.trim()) return text;
  }
  const props = object?.properties;
  if (props && typeof props === "object") {
    for (const value of Object.values(props)) {
      if (value?.type === "title") {
        const text = richText(value.title ?? []);
        if (text.trim()) return text;
      }
    }
  }
  return "(untitled)";
}

const namesOf = (value) =>
  Array.isArray(value) ? value.map((v) => v?.name).filter((n) => typeof n === "string") : [];

/** A float without a trailing `.0`, so counts read as counts. */
function trimFloat(n) {
  return Number.isInteger(n) && Math.abs(n) < 1e15 ? String(n) : String(n);
}

/**
 * One page property value, flattened to a short string. Returns `undefined`
 * for a property that is genuinely empty, so callers can skip it rather than
 * printing a column of blanks.
 */
export function describeProperty(value) {
  const kind = value?.type ?? "";
  const inner = value?.[kind];

  let rendered;
  switch (kind) {
    case "title":
    case "rich_text":
      rendered = richText(inner);
      break;
    case "number":
      rendered = typeof inner === "number" ? trimFloat(inner) : "";
      break;
    case "checkbox":
      rendered = typeof inner === "boolean" ? String(inner) : "";
      break;
    case "select":
    case "status":
      rendered = inner?.name ?? "";
      break;
    case "multi_select":
      rendered = namesOf(inner).join(", ");
      break;
    case "date": {
      const start = inner?.start ?? "";
      rendered = inner?.end ? `${start} -> ${inner.end}` : start;
      break;
    }
    case "people":
      rendered = Array.isArray(inner)
        ? inner.map((p) => p?.name ?? (p?.id ? `?${p.id}` : "?")).join(", ")
        : "";
      break;
    case "relation":
      rendered = Array.isArray(inner) ? inner.map((r) => r?.id).filter(Boolean).join(", ") : "";
      break;
    case "files":
      rendered = Array.isArray(inner) ? inner.map((f) => f?.name ?? "file").join(", ") : "";
      break;
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      rendered = typeof inner === "string" ? inner : "";
      break;
    case "created_by":
    case "last_edited_by":
      rendered = inner?.name ?? "";
      break;
    case "unique_id": {
      const number = inner?.number;
      const prefix = inner?.prefix;
      if (prefix != null && number != null) rendered = `${prefix}-${number}`;
      else if (number != null) rendered = String(number);
      else rendered = "";
      break;
    }
    case "formula":
      rendered = describeProperty(inner) ?? "";
      break;
    case "rollup":
      if (inner?.type === "array" && Array.isArray(inner.array)) {
        rendered = inner.array.map(describeProperty).filter((v) => v !== undefined).join(", ");
      } else {
        rendered = describeProperty(inner) ?? "";
      }
      break;
    case "string":
      rendered = typeof inner === "string" ? inner : "";
      break;
    case "boolean":
      rendered = typeof inner === "boolean" ? String(inner) : "";
      break;
    case "verification":
      rendered = inner?.state ?? "";
      break;
    default:
      // An unknown type is new, not broken: show its JSON rather than hiding
      // it. Notion adds response fields to every API version at once.
      rendered = inner == null ? "" : clip(JSON.stringify(inner), 200);
  }

  rendered = (rendered ?? "").trim();
  return rendered ? rendered : undefined;
}

/** Every non-empty property of a page, as `name (type): value` lines. */
export function describeProperties(page, indent) {
  const props = page?.properties;
  if (!props || typeof props !== "object") return "";

  const names = Object.keys(props).sort();
  let out = "";
  for (const name of names) {
    const value = props[name];
    const kind = value?.type ?? "?";
    const rendered = describeProperty(value);
    if (rendered !== undefined) {
      out += `${indent}${name} (${kind}): ${clip(rendered, 400)}\n`;
    }
  }
  return out;
}

/** One line identifying a page or data source in a list of results. */
export function objectLine(object) {
  const kind = object?.object ?? "?";
  const id = object?.id ?? "?";
  let line = `${titleOf(object)} [${kind}] ${id}`;
  if (object?.url) line += `\n   ${object.url}`;
  if (object?.last_edited_time) line += `\n   edited ${clip(object.last_edited_time, 19)}`;
  if (object?.in_trash === true || object?.archived === true) line += "\n   (in trash / archived)";
  return line;
}

/** Where an object lives, as a line naming the parent's kind and id. */
export function parentLine(object) {
  const parent = object?.parent;
  if (!parent) return undefined;
  const kind = parent.type ?? "?";
  const raw = parent[kind];
  const id = typeof raw === "string" ? raw : raw === true ? "true" : "";
  return id ? `parent: ${kind} ${id}` : `parent: ${kind}`;
}

/**
 * Shortens the signed URLs Notion puts in markdown for uploaded files.
 *
 * An S3 link for an image comes back with the whole AWS signature attached —
 * about 1.5kB of credential, expiry and checksum per image. It is worthless to
 * a reader, it expires within the hour, and two of them on one page cost more
 * context than the page's actual prose. So the query string goes and the
 * filename stays, which is the only part that carries meaning.
 *
 * Anything that is not one of Notion's own file hosts is left alone: a link to
 * a real web page may well need its query string.
 */
function shortenSignedUrls(markdown) {
  const SIGNED_HOSTS = ["prod-files-secure.s3", "s3.us-west-2.amazonaws.com", "amazonaws.com", "attachment-secure"];

  let out = "";
  let rest = markdown;
  let at;
  while ((at = rest.indexOf("https://")) !== -1) {
    out += rest.slice(0, at);
    const tail = rest.slice(at);
    const endMatch = tail.match(/[\s)"'>]/);
    const end = endMatch ? endMatch.index : tail.length;
    const url = tail.slice(0, end);

    const qi = url.indexOf("?");
    if (qi !== -1) {
      const base = url.slice(0, qi);
      const query = url.slice(qi + 1);
      if (SIGNED_HOSTS.some((h) => base.includes(h)) && query.length > 80) {
        out += `${base}?[signature removed]`;
      } else {
        out += url;
      }
    } else {
      out += url;
    }
    rest = tail.slice(end);
  }
  out += rest;
  return out;
}

/**
 * Display names for the user ids appearing in a payload, where obtainable.
 *
 * Comments carry `created_by` as a bare `{object, id}` with no name, so a
 * thread otherwise renders as a wall of UUIDs.
 *
 * Resolving them is usually impossible. A **personal access token** is refused
 * by both `/v1/users/{id}` and `/v1/users`:
 *
 *     403 restricted_resource
 *     Personal access tokens can only retrieve their own authorized user.
 *
 * So rather than spend a failing request per author, the workspace listing is
 * attempted **once** and the whole map built from it. An integration token
 * with the "read user information" capability gets real names; a personal
 * access token gets an empty map and ids are shortened for display instead.
 */
export async function resolveUserNames(client) {
  const names = new Map();
  let listing;
  try {
    listing = await client.get("/v1/users", { page_size: 100 });
  } catch {
    return names;
  }
  for (const user of listing?.results ?? []) {
    if (user?.id && typeof user?.name === "string" && user.name.trim()) {
      names.set(user.id, user.name);
    }
  }
  return names;
}

/**
 * A user's display name, falling back to a shortened id.
 *
 * A full UUID tells a reader nothing and costs 36 characters, so an
 * unresolvable author shows only the first segment — enough to tell two
 * participants apart in a thread, which is what the name was for.
 */
export function userLabel(user, names) {
  if (typeof user?.name === "string" && user.name.trim()) return user.name;
  const id = user?.id;
  if (!id) return "(unknown author)";
  return names.get(id) ?? `user ${id.split("-")[0]}`;
}

/**
 * How to narrow a body that does not fit: a window, or a search. Without this
 * a long page is simply unreadable past the first MAX_MARKDOWN_CHARS
 * characters. A Notion page has no line numbers a caller can trust, so the
 * window is measured in characters, and the footer reports the offset to
 * resume from.
 */
export function markdownBody(response) {
  return markdownBodyWindow(response, {});
}

export function markdownBodyWindow(response, window) {
  const raw = typeof response?.markdown === "string" ? response.markdown : "";
  // Shorten before clipping, so the budget is spent on prose rather than on
  // AWS signatures.
  const markdown = shortenSignedUrls(raw);

  let out =
    window.find != null ? findInBody(markdown, window.find) : windowOfBody(markdown, window.offset ?? 0, window.limit ?? 0);

  if (response?.truncated === true) {
    out +=
      "\n\n[Notion truncated this page: it exceeds the block limit. The unknown block ids " +
      "below can be fetched individually.]";
  }
  const unknown = Array.isArray(response?.unknown_block_ids) ? response.unknown_block_ids : [];
  if (unknown.length) {
    out += `\n\n[${unknown.length} block(s) could not be loaded — unshared, unsupported, or truncated. Ids: ${unknown
      .slice(0, 10)
      .join(", ")}]`;
  }
  return out;
}

/** The body of a page after a write, capped as a confirmation rather than a read. */
export function markdownBodyPreview(response) {
  const raw = typeof response?.markdown === "string" ? response.markdown : "";
  const markdown = shortenSignedUrls(raw);
  const total = [...markdown].length;
  if (total <= PREVIEW_CHARS) return markdown;
  const kept = [...markdown].slice(0, PREVIEW_CHARS).join("");
  return `${kept}\n\n[${PREVIEW_CHARS} of ${total} characters shown — this is a confirmation of the write, not the whole page. Read the rest with notion_page_get, which takes content_offset/content_limit and find.]`;
}

/** Returns a character window of a body, with a footer naming the next offset. */
function windowOfBody(text, offset, limitArg) {
  const chars = [...text];
  const total = chars.length;
  const limit = limitArg === 0 ? MAX_MARKDOWN_CHARS : Math.min(limitArg, MAX_MARKDOWN_CHARS);

  if (offset >= total && total > 0) {
    return `[offset ${offset} is past the end; this page has ${total} characters]`;
  }

  const kept = chars.slice(offset, offset + limit).join("");
  const end = offset + [...kept].length;

  if (offset === 0 && end >= total) return kept;
  return `${kept}\n\n[characters ${offset}-${end} of ${total}. Read on with offset ${end}, or pass find to jump to the part you want.]`;
}

/** Returns the paragraphs of a body containing `needle`, with their offsets. */
function findInBody(text, needle) {
  const folded = needle.toLowerCase();
  const hits = [];
  let at = 0;

  for (const para of text.split("\n\n")) {
    const chars = [...para].length;
    if (para.toLowerCase().includes(folded)) {
      hits.push(`[at character ${at}]\n${para.replace(/\s+$/, "")}`);
    }
    at += chars + 2; // +2 for the blank line the split consumed
  }

  if (!hits.length) {
    const total = [...text].length;
    return `[no paragraph contains ${JSON.stringify(needle)} in ${total} characters. Omit find and read with offset/limit to page through the page instead.]`;
  }

  const joined = hits.join("\n\n");
  const body = clipNote(joined, MAX_MARKDOWN_CHARS);
  return `[${hits.length} matching paragraph(s) for ${JSON.stringify(needle)}]\n\n${body}`;
}

/**
 * A footer stating how much of a list was seen and how to see the rest. An
 * agent that cannot tell "all of them" from "the first hundred" will draw
 * confident conclusions from partial data.
 */
export function paginationNote(shown, nextCursor) {
  return nextCursor
    ? `\n${shown} shown, and there are more. Pass start_cursor to continue:\n  ${nextCursor}\n`
    : `\n${shown} shown; that is all of them.\n`;
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/** A required string argument, rejecting one that is present but blank. */
export function requiredStr(args, key) {
  const value = args?.[key];
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error(`missing required argument '${key}'`);
  return trimmed;
}

export function optionalStr(args, key) {
  const value = args?.[key];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

/** A required id argument, accepting any of the forms `normalizeId` takes. */
export function requiredId(args, key) {
  return normalizeId(requiredStr(args, key), key);
}

export function optionalId(args, key) {
  const raw = optionalStr(args, key);
  return raw === undefined ? undefined : normalizeId(raw, key);
}

export function pageSize(args, defaultValue) {
  const raw = Number(args?.page_size ?? defaultValue);
  return Math.min(100, Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : defaultValue));
}

/**
 * How many results to gather across pages. Bounded, because an unbounded walk
 * of a large data source would blow the context window and the rate limit.
 */
export function limitArg(args, defaultValue, max) {
  const raw = Number(args?.limit ?? defaultValue);
  return Math.min(max, Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : defaultValue));
}

/** Truncates on a character boundary. Never slices a multi-byte character in half. */
export function clip(text, max) {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("") + "...";
}

/** Like `clip`, but says how much was dropped. */
function clipNote(text, max) {
  const chars = [...text];
  const total = chars.length;
  if (total <= max) return text;
  return `${chars.slice(0, max).join("")}\n\n[cut here: ${max} of ${total} characters shown]`;
}

// ---------------------------------------------------------------------------
// Writing properties
//
// Notion's write format wraps every value in its own type: a select is
// `{"select": {"name": "Done"}}`, a date is `{"date": {"start": "..."}}`, and
// a number is `{"number": 3}`. A caller working from the page it just read
// will naturally write `{"Status": "Done"}`, which the API rejects with a bare
// validation_error naming no property.
//
// So these tools fetch the parent data source's schema and coerce plain
// values into the shape each property actually needs. A value that is already
// wrapped is passed through untouched, which keeps the full API reachable for
// anything the coercion does not cover.
// ---------------------------------------------------------------------------

/** Property types the API refuses to accept on write, because Notion computes them. */
const COMPUTED = new Set(["formula", "rollup", "created_by", "created_time", "last_edited_by", "last_edited_time", "unique_id"]);

const PROPERTY_KEYS = new Set([
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "people",
  "files",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "relation",
]);

/** Reads a data source's property schema. */
export async function fetchSchema(client, dataSourceId) {
  const source = await client.get(`/v1/data_sources/${dataSourceId}`);
  return schemaOf(source);
}

/** Extracts the name -> type map from a data source or database object. */
export function schemaOf(object) {
  const schema = new Map();
  const props = object?.properties;
  if (props && typeof props === "object") {
    for (const [name, spec] of Object.entries(props)) {
      if (typeof spec?.type === "string") schema.set(name, spec.type);
    }
  }
  return schema;
}

/**
 * Coerces a map of plain values into Notion's tagged write format.
 *
 * `schema` may be empty, in which case only values that are already wrapped,
 * plus bare strings (treated as title text), can be handled — that is the
 * situation for a page whose parent is another page, where `title` is the
 * only writable property anyway.
 */
export function coerceProperties(input, schema) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("'properties' must be a JSON object of property name to value");
  }

  const out = {};
  const unknown = [];

  for (const [name, value] of Object.entries(input)) {
    const declared = schema.get(name);

    if (declared && COMPUTED.has(declared)) {
      throw new Error(
        `'${name}' is a ${declared} property, which Notion computes and the API cannot write. Remove it from 'properties'.`
      );
    }

    // Already in write format: `{"select": {...}}` or an explicit
    // `{"type": "select", ...}`. Pass it through rather than second-guessing
    // a caller who knows the API.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const tagged = Object.keys(value).some((k) => k === "type" || k === declared || PROPERTY_KEYS.has(k));
      if (tagged) {
        out[name] = value;
        continue;
      }
    }

    if (declared) {
      out[name] = wrap(declared, value, name);
    } else if (schema.size === 0 && typeof value === "string") {
      // No schema entry. If the caller gave a string and we have no schema at
      // all, it is almost certainly the title.
      out[name] = wrap("title", value, name);
    } else {
      unknown.push(name);
    }
  }

  if (unknown.length) {
    const known = [...schema.entries()]
      .filter(([, kind]) => !COMPUTED.has(kind))
      .map(([name, kind]) => `${name} (${kind})`)
      .sort();
    throw new Error(
      `this data source has no propert${unknown.length === 1 ? "y" : "ies"} named ${unknown
        .map((u) => JSON.stringify(u))
        .join(", ")}. Writable properties are: ${known.length ? known.join(", ") : "(none)"}.\n\n` +
        "Property names are case- and space-sensitive. Use notion_database_schema to see the exact schema."
    );
  }

  return out;
}

/** A list of strings from either an array or a single value, so a caller may write one tag without wrapping it in a list. */
function stringList(value, name, kind) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item?.name != null) return String(item.name);
      if (item?.id != null) return String(item.id);
      throw new Error(`'${name}' is a ${kind} property; ${JSON.stringify(item)} is not a name or id`);
    });
  }
  throw new Error(`'${name}' is a ${kind} property; expected a string or a list of strings, got ${JSON.stringify(value)}`);
}

/** Wraps one plain value for one property type. */
function wrap(kind, value, name) {
  // An explicit null clears a property, whatever its type. Notion has no
  // empty string, so this is the documented way to unset a value.
  if (value === null) return { [kind]: null };

  const text = () => (typeof value === "string" ? value : JSON.stringify(value));

  switch (kind) {
    case "title":
    case "rich_text":
      return { [kind]: [{ text: { content: text() } }] };
    case "number": {
      const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
      if (!Number.isFinite(number)) throw new Error(`'${name}' is a number property; ${JSON.stringify(value)} is not a number`);
      return { number };
    }
    case "checkbox": {
      let flag;
      if (typeof value === "boolean") flag = value;
      else if (value === "true" || value === "yes") flag = true;
      else if (value === "false" || value === "no") flag = false;
      else throw new Error(`'${name}' is a checkbox property; ${JSON.stringify(value)} is not true or false`);
      return { checkbox: flag };
    }
    case "select":
    case "status":
      return { [kind]: { name: text() } };
    case "multi_select":
      return { multi_select: stringList(value, name, kind).map((o) => ({ name: o })) };
    case "date":
      return typeof value === "string" ? { date: { start: value } } : { date: value };
    case "people":
      return { people: stringList(value, name, kind).map((id) => ({ object: "user", id })) };
    case "relation":
      return { relation: stringList(value, name, kind).map((id) => ({ id: normalizeId(id, "related page id") })) };
    case "url":
    case "email":
    case "phone_number":
      return { [kind]: text() };
    case "files":
      return { files: value };
    default:
      // Unrecognised type: hand it to Notion as-is under its own tag and let
      // the API be the authority. Better than refusing something valid.
      return { [kind]: value };
  }
}

/** Builds an icon object from an emoji character or an image URL. */
export function iconValue(raw) {
  return raw.startsWith("http://") || raw.startsWith("https://")
    ? { type: "external", external: { url: raw } }
    : { type: "emoji", emoji: raw };
}

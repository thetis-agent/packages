// The eleven Notion tools. Each one is a thin function over the shared client
// in client.js: build the request, call it, render the response as lines a
// model can scan. A tool receives (args, env) and returns a string; env.config
// carries this package's own configuration, most importantly `token`.
//
// Errors: every tool lets client.js's exceptions propagate as thrown Errors.
// The kernel turns a thrown Error into the tool's error result; none of that
// text is constructed here, so there is nowhere in this file the token could
// leak into it even by accident.

import * as notion from "./client.js";

function client(env) {
  return notion.createClient(env?.config);
}

// ---------------------------------------------------------------------------
// notion_search
// ---------------------------------------------------------------------------

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;

export async function search(args, env) {
  const c = client(env);
  const query = notion.optionalStr(args, "query");
  const want = notion.limitArg(args, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);

  const body = {};
  if (query) body.query = query;
  const cursor = notion.optionalStr(args, "start_cursor");
  if (cursor) body.start_cursor = cursor;

  const object = notion.optionalStr(args, "filter");
  const inTrash = typeof args?.in_trash === "boolean" ? args.in_trash : undefined;
  if (object !== undefined) {
    body.filter = { property: "object", value: object };
    if (inTrash !== undefined) body.filter.in_trash = inTrash;
  } else if (inTrash !== undefined) {
    body.filter = { in_trash: inTrash };
  }

  switch (args?.sort) {
    case "last_edited_ascending":
      body.sort = { timestamp: "last_edited_time", direction: "ascending" };
      break;
    case "last_edited_descending":
      body.sort = { timestamp: "last_edited_time", direction: "descending" };
      break;
    case "relevance":
      body.sort = { property: "relevance" };
      break;
  }

  const { results, nextCursor } = await c.paginate("POST", "/v1/search", body, want);
  return formatSearch(results, nextCursor, query, object);
}

function formatSearch(results, nextCursor, query, filter) {
  const subject = query !== undefined ? JSON.stringify(query) : "everything shared with this connection";

  if (!results.length) {
    return (
      `No Notion pages or databases match ${subject}.\n\n` +
      "Search matches titles only, not page content, so try a shorter or different title " +
      "fragment. If you expected a result, the page may not be shared with this connection: " +
      "open it in Notion, use the ••• menu -> Connections, and add yours."
    );
  }

  const scope = filter === "page" ? " (pages only)" : filter === "data_source" ? " (data sources only)" : "";

  let out = `${results.length} result(s) for ${subject}${scope}. Titles matched; page content was not searched.\n`;

  results.forEach((object, i) => {
    out += `\n${i + 1}. ${notion.objectLine(object)}\n`;
    // A data source id is what notion_database_query needs, and it is not the
    // same as the database id it belongs to — so name both.
    if (object?.object === "data_source") {
      const line = notion.parentLine(object);
      if (line) {
        out += `   ${line}\n`;
        out += "   query this id with notion_database_query\n";
      }
    }
  });

  out += notion.paginationNote(results.length, nextCursor);
  return out;
}

// ---------------------------------------------------------------------------
// notion_page_get
// ---------------------------------------------------------------------------

export async function pageGet(args, env) {
  const c = client(env);
  const pageId = notion.requiredId(args, "page_id");

  const wantContent = flag(args, "include_content", true);
  const wantProperties = flag(args, "include_properties", true);
  if (!wantContent && !wantProperties) {
    throw new Error("include_content and include_properties are both false, so there is nothing to fetch. Leave at least one on.");
  }

  let out = "";
  let page;

  // The metadata call is what tells us the title and where the page lives, so
  // it goes first and its failure is the reported one: a 404 here is a wrong
  // id or an unshared page, which is the usual cause.
  if (wantProperties) {
    page = await c.get(`/v1/pages/${pageId}`);
    out += renderPage(page);
  }

  if (wantContent) {
    const query = {};
    if (flag(args, "include_transcript", false)) query.include_transcript = "true";
    const markdown = await c.get(`/v1/pages/${pageId}/markdown`, query);
    const body = notion.markdownBodyWindow(markdown, {
      offset: Number(args?.content_offset) || 0,
      limit: Number(args?.content_limit) || 0,
      find: typeof args?.find === "string" ? args.find : undefined,
    });

    out += "\n--- content (markdown) ---\n";
    out += body.trim() ? body + "\n" : "(this page has no content)\n";
  }

  if (!page) out += `\n(page id: ${pageId})\n`;
  return out;
}

function flag(args, key, defaultValue) {
  const v = args?.[key];
  return typeof v === "boolean" ? v : defaultValue;
}

function renderPage(page) {
  let out = `# ${notion.titleOf(page)}\n`;
  if (page?.id) out += `id: ${page.id}\n`;
  if (page?.url) out += `url: ${page.url}\n`;
  const line = notion.parentLine(page);
  if (line) out += `${line}\n`;
  if (page?.last_edited_time) out += `last edited: ${page.last_edited_time}\n`;
  if (page?.in_trash === true) out += "status: in trash\n";
  else if (page?.archived === true) out += "status: archived\n";
  if (page?.is_locked === true) out += "status: locked in the Notion UI (the API can still edit it)\n";

  const properties = notion.describeProperties(page, "  ");
  if (!properties.trim()) {
    // A page whose parent is another page has only a title, so this is normal
    // rather than a problem.
    out += "\nproperties: none set (pages outside a database have only a title)\n";
  } else {
    out += "\nproperties (non-empty only):\n" + properties;
  }
  return out;
}

// ---------------------------------------------------------------------------
// notion_page_create
// ---------------------------------------------------------------------------

export async function pageCreate(args, env) {
  const c = client(env);

  const parentPage = notion.optionalId(args, "parent_page_id");
  const parentSource = notion.optionalId(args, "parent_data_source_id");

  if (parentPage !== undefined && parentSource !== undefined) {
    throw new Error("give either parent_page_id or parent_data_source_id, not both: a page has one parent.");
  }

  const body = {};
  let schema = new Map();
  let whereTo = "the workspace root (a private page)";

  if (parentPage !== undefined) {
    body.parent = { type: "page_id", page_id: parentPage };
    whereTo = `page ${parentPage}`;
  } else if (parentSource !== undefined) {
    // An id that is really a database, not a data source, is the most common
    // mix-up since Notion split the two. Resolve it rather than returning a
    // validation error.
    const sourceId = await resolveDataSource(c, parentSource);
    body.parent = { type: "data_source_id", data_source_id: sourceId };
    schema = await notion.fetchSchema(c, sourceId);
    whereTo = `data source ${sourceId}`;
  }
  // No parent at all creates a private top-level page, which a personal
  // access token is allowed to do.

  const properties = {};
  const input = args?.properties;
  if (input != null) {
    Object.assign(properties, notion.coerceProperties(input, schema));
  }

  const title = notion.optionalStr(args, "title");
  if (title !== undefined) {
    const key = titleKey(schema);
    properties[key] = { title: [{ text: { content: title } }] };
  } else if (Object.keys(properties).length === 0) {
    throw new Error("give a 'title', or 'properties' including the title property: a page with no title at all is almost never intended.");
  }

  body.properties = properties;

  const content = notion.optionalStr(args, "content");
  if (content !== undefined) body.markdown = content;
  const icon = notion.optionalStr(args, "icon");
  if (icon !== undefined) body.icon = notion.iconValue(icon);

  const created = await c.post("/v1/pages", body);

  let out = `Created "${notion.titleOf(created)}" in ${whereTo}.\n`;
  if (created?.id) out += `id: ${created.id}\n`;
  if (created?.url) out += `url: ${created.url}\n`;
  const props = notion.describeProperties(created, "  ");
  if (props.trim()) out += "\nproperties:\n" + props;
  return out;
}

/**
 * Accepts either a data source id or a database id, returning a data source
 * id.
 *
 * Since API version 2025-09-03 a database holds one or more data sources, and
 * only a data source can parent a page or answer a query. The two ids look
 * identical, so being handed the wrong one is routine.
 */
async function resolveDataSource(c, id) {
  try {
    await c.get(`/v1/data_sources/${id}`);
    return id;
  } catch {
    // fall through to try it as a database id
  }

  let database;
  try {
    database = await c.get(`/v1/databases/${id}`);
  } catch (e) {
    throw new Error(`${id} is neither a data source nor a database this connection can see.\n\n${e.message}`);
  }

  const sources = Array.isArray(database?.data_sources) ? database.data_sources : [];
  if (sources.length === 0) throw new Error(`database ${id} has no data sources to add a page to.`);
  if (sources.length === 1) return sources[0]?.id;

  // Choosing for the caller here would silently put the row in the wrong
  // table, so ask.
  throw new Error(
    `${id} is a database with ${sources.length} data sources; say which one to use:\n` +
      sources.map((s) => `  ${s?.id ?? "?"} — ${s?.name ?? "(unnamed)"}`).join("\n")
  );
}

/** The schema's title property name, or plain "title" when there is no schema (a page parented by another page). */
function titleKey(schema) {
  for (const [name, kind] of schema) if (kind === "title") return name;
  return "title";
}

// ---------------------------------------------------------------------------
// notion_page_content
// ---------------------------------------------------------------------------

export async function pageContent(args, env) {
  const c = client(env);
  const pageId = notion.requiredId(args, "page_id");

  const mode = args?.mode ?? "append";
  const allowDeleting = args?.allow_deleting_content === true;

  let command, summary;

  if (mode === "edit") {
    const edits = Array.isArray(args?.edits) ? args.edits : undefined;
    if (!edits || edits.length === 0) {
      throw new Error("mode 'edit' needs a non-empty 'edits' array of {old_text, new_text}.");
    }

    const operations = edits.map((edit, i) => {
      const old = typeof edit?.old_text === "string" && edit.old_text ? edit.old_text : undefined;
      if (old === undefined) throw new Error(`edits[${i}] has no 'old_text'; it must be text to search for`);
      const now = edit?.new_text;
      if (typeof now !== "string") throw new Error(`edits[${i}] has no 'new_text'`);
      const operation = { old_str: old, new_str: now };
      if (edit?.replace_all === true) operation.replace_all_matches = true;
      return operation;
    });

    const contentUpdates = { content_updates: operations };
    if (allowDeleting) contentUpdates.allow_deleting_content = true;
    command = { type: "update_content", update_content: contentUpdates };
    summary = `applied ${operations.length} edit(s)`;
  } else if (mode === "replace") {
    if (args?.confirm_replace !== true) {
      throw new Error(
        "mode 'replace' discards everything currently on the page and Notion has no undo. Set " +
          "confirm_replace: true if that is really the intent — or use mode 'edit' to change " +
          "part of the page, or 'append' to add to it."
      );
    }
    const content = notion.requiredStr(args, "content");
    const replaceContent = { new_str: content };
    if (allowDeleting) replaceContent.allow_deleting_content = true;
    command = { type: "replace_content", replace_content: replaceContent };
    summary = "replaced the whole page body";
  } else if (mode === "prepend") {
    const content = notion.requiredStr(args, "content");
    command = { type: "insert_content", insert_content: { content, position: { type: "start" } } };
    summary = "inserted at the top of the page";
  } else if (mode === "append") {
    const content = notion.requiredStr(args, "content");
    command = { type: "insert_content", insert_content: { content, position: { type: "end" } } };
    summary = "appended to the end of the page";
  } else {
    throw new Error(`unknown mode ${JSON.stringify(mode)}. Use 'edit', 'append', 'prepend' or 'replace'.`);
  }

  const response = await c.patch(`/v1/pages/${pageId}/markdown`, command);

  let out = `Page ${pageId}: ${summary}.\n`;
  out += "\n--- page content now (markdown) ---\n";
  out += notion.markdownBodyPreview(response);
  out += "\n";
  return out;
}

// ---------------------------------------------------------------------------
// notion_page_update
// ---------------------------------------------------------------------------

export async function pageUpdate(args, env) {
  const c = client(env);
  const pageId = notion.requiredId(args, "page_id");

  const body = {};
  const changed = [];
  const properties = {};

  // Properties need the parent's schema, which costs one extra request — only
  // made when there are properties to coerce.
  const input = args?.properties;
  if (input != null) {
    const page = await c.get(`/v1/pages/${pageId}`);
    const schema = await schemaFor(c, page);
    const coerced = notion.coerceProperties(input, schema);
    for (const [k, v] of Object.entries(coerced)) {
      properties[k] = v;
      changed.push(k);
    }
  }

  // `title` is a shortcut: find whichever property is the title rather than
  // making the caller look it up.
  const title = notion.optionalStr(args, "title");
  if (title !== undefined) {
    const page = await c.get(`/v1/pages/${pageId}`);
    const key = titlePropertyOf(page) ?? "title";
    properties[key] = { title: [{ text: { content: title } }] };
    changed.push(`${key} (title)`);
  }

  if (Object.keys(properties).length) body.properties = properties;

  if (typeof args?.icon === "string") {
    body.icon = args.icon.trim() ? notion.iconValue(args.icon.trim()) : null;
    changed.push("icon");
  }
  if (typeof args?.cover === "string") {
    body.cover = args.cover.trim() ? { type: "external", external: { url: args.cover.trim() } } : null;
    changed.push("cover");
  }
  if (typeof args?.in_trash === "boolean") {
    body.in_trash = args.in_trash;
    changed.push(args.in_trash ? "moved to trash" : "restored from trash");
  }
  if (typeof args?.is_locked === "boolean") {
    body.is_locked = args.is_locked;
    changed.push(args.is_locked ? "locked" : "unlocked");
  }

  if (!changed.length) {
    throw new Error("nothing to change. Give at least one of: properties, title, icon, cover, in_trash, is_locked.");
  }

  const updated = await c.patch(`/v1/pages/${pageId}`, body);

  let out = `Updated "${notion.titleOf(updated)}".\nchanged: ${changed.join(", ")}\n`;
  if (updated?.url) out += `url: ${updated.url}\n`;
  const props = notion.describeProperties(updated, "  ");
  if (props.trim()) out += "\nproperties now (non-empty only):\n" + props;
  return out;
}

/** The schema of the data source a page belongs to, or an empty schema when the page's parent is an ordinary page (where only the title is writable). */
async function schemaFor(c, page) {
  const parent = page?.parent;
  const kind = parent?.type ?? "";

  if (kind === "data_source_id") {
    return notion.fetchSchema(c, parent.data_source_id);
  }
  if (kind === "database_id") {
    // Older parents still report database_id. A database's first data source
    // carries the schema.
    const database = await c.get(`/v1/databases/${parent.database_id}`);
    const sourceId = database?.data_sources?.[0]?.id;
    return sourceId ? notion.fetchSchema(c, sourceId) : new Map();
  }
  return new Map();
}

/** The name of whichever property holds the page title. */
function titlePropertyOf(page) {
  const props = page?.properties;
  if (!props) return undefined;
  for (const [name, value] of Object.entries(props)) {
    if (value?.type === "title") return name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// notion_database_list
// ---------------------------------------------------------------------------

const DB_LIST_DEFAULT_LIMIT = 25;
const DB_LIST_MAX_LIMIT = 100;

export async function databaseList(args, env) {
  const c = client(env);
  const query = notion.optionalStr(args, "query");
  const want = notion.limitArg(args, DB_LIST_DEFAULT_LIMIT, DB_LIST_MAX_LIMIT);

  // Searching for data sources rather than databases: the data source is the
  // queryable thing, and each one names its parent database.
  const body = { filter: { property: "object", value: "data_source" } };
  if (query) body.query = query;
  const cursor = notion.optionalStr(args, "start_cursor");
  if (cursor) body.start_cursor = cursor;

  const { results, nextCursor } = await c.paginate("POST", "/v1/search", body, want);

  if (!results.length) {
    return query
      ? `No databases match ${JSON.stringify(query)}.\n\n` +
          "This matches database titles only. If you expected one, it may not be shared with " +
          "this connection: open the database in Notion, use the ••• menu -> Connections, and " +
          "add yours."
      : "This connection can see no databases.\n\n" +
          "Notion shares nothing by default. Open a database in Notion, use the ••• menu -> " +
          "Connections, and add this connection to it.";
  }

  let out = `${results.length} data source(s) available.\n`;
  out +=
    "\nQuery a data source with notion_database_query, and add rows to it with " +
    "notion_page_create (parent_data_source_id). A database id is not interchangeable with a " +
    "data source id.\n";

  results.forEach((source, i) => {
    const id = source?.id ?? "?";
    out += `\n${i + 1}. ${notion.titleOf(source)}\n   data_source_id: ${id}\n`;
    const databaseId = source?.parent?.database_id;
    if (databaseId) out += `   in database: ${databaseId}\n`;
    if (source?.url) out += `   ${source.url}\n`;

    // The column names, so a caller can write a filter without a second call
    // for the schema.
    const schema = notion.schemaOf(source);
    if (schema.size) {
      const columns = [...schema.entries()].map(([name, kind]) => `${name} (${kind})`);
      out += `   properties: ${notion.clip(columns.join(", "), 400)}\n`;
    }
  });

  out += notion.paginationNote(results.length, nextCursor);
  return out;
}

// ---------------------------------------------------------------------------
// notion_database_query
// ---------------------------------------------------------------------------

const DB_QUERY_DEFAULT_LIMIT = 25;
const DB_QUERY_MAX_LIMIT = 200;

export async function databaseQuery(args, env) {
  const c = client(env);
  const given = notion.requiredId(args, "data_source_id");
  const want = notion.limitArg(args, DB_QUERY_DEFAULT_LIMIT, DB_QUERY_MAX_LIMIT);

  const body = {};
  if (args?.filter != null) body.filter = args.filter;
  if (Array.isArray(args?.sorts) && args.sorts.length) body.sorts = args.sorts;
  if (args?.is_archived === true) body.is_archived = true;
  const cursor = notion.optionalStr(args, "start_cursor");
  if (cursor) body.start_cursor = cursor;

  // filter_properties is a repeated query parameter, not a body field, so it
  // is appended to the path.
  const wanted = Array.isArray(args?.properties) ? args.properties.filter((p) => typeof p === "string") : [];

  let path = `/v1/data_sources/${given}/query`;
  if (wanted.length) {
    path += "?" + wanted.map((p) => `filter_properties[]=${encodeURIComponent(p)}`).join("&");
  }

  let rows, nextCursor;
  try {
    ({ results: rows, nextCursor } = await c.paginate("POST", path, body, want));
  } catch (first) {
    // Being handed a database id instead of a data source id is the most
    // common failure here, so try to recover from it before reporting
    // anything.
    const sourceId = await resolveViaDatabase(c, given);
    if (sourceId && sourceId !== given) {
      const retryPath = path.replace(given, sourceId);
      ({ results: rows, nextCursor } = await c.paginate("POST", retryPath, body, want));
    } else {
      throw first;
    }
  }

  return formatQuery(rows, nextCursor, given);
}

function formatQuery(rows, nextCursor, source) {
  if (!rows.length) {
    return (
      `No rows in data source ${source} match this query.\n\n` +
      "An empty result is not an error: the filter may simply match nothing. If a filter was " +
      "given, check the property names and type keys against notion_database_schema — a filter " +
      "naming a property that does not exist is rejected, but one with the wrong expectation " +
      "quietly matches nothing."
    );
  }

  let out = `${rows.length} row(s) from data source ${source}.\n`;

  rows.forEach((row, i) => {
    out += `\n${i + 1}. ${notion.titleOf(row)}\n`;
    if (row?.id) out += `   id: ${row.id}\n`;

    const properties = notion.describeProperties(row, "   ");
    // The title is already the heading; repeating it as a property doubles
    // every entry for no gain.
    for (const line of properties.split("\n")) {
      if (!line || line.includes("(title):")) continue;
      out += line + "\n";
    }
  });

  out += notion.paginationNote(rows.length, nextCursor);
  return out;
}

/** A data source id for something that might be a database id. */
async function resolveViaDatabase(c, id) {
  let database;
  try {
    database = await c.get(`/v1/databases/${id}`);
  } catch {
    return undefined;
  }
  const sources = Array.isArray(database?.data_sources) ? database.data_sources : [];
  return sources.length === 1 ? sources[0]?.id : undefined;
}

// ---------------------------------------------------------------------------
// notion_database_schema
// ---------------------------------------------------------------------------

export async function databaseSchema(args, env) {
  const c = client(env);
  const id = notion.requiredId(args, "data_source_id");

  try {
    const source = await c.get(`/v1/data_sources/${id}`);
    return renderSchema(source);
  } catch (first) {
    // Perhaps it is a database id. Listing its data sources is more use than
    // repeating a 404.
    try {
      const database = await c.get(`/v1/databases/${id}`);
      return renderDatabase(database, id);
    } catch {
      throw first;
    }
  }
}

function renderSchema(source) {
  let out = `# ${notion.titleOf(source)} (data source)\n`;
  if (source?.id) out += `data_source_id: ${source.id}\n`;
  const databaseId = source?.parent?.database_id;
  if (databaseId) out += `in database: ${databaseId}\n`;
  if (source?.description) {
    const text = notion.richText(source.description);
    if (text.trim()) out += `description: ${text}\n`;
  }

  const properties = source?.properties;
  if (!properties || typeof properties !== "object") {
    return out + "\nThis data source reports no properties.\n";
  }

  const names = Object.keys(properties).sort();
  out += `\n${names.length} propert(ies):\n`;

  for (const name of names) {
    const spec = properties[name];
    const kind = spec?.type ?? "?";
    out += `\n- ${name} — ${kind}`;
    if (spec?.id) out += ` (id ${spec.id})`;
    out += "\n";

    if (kind === "select" || kind === "status" || kind === "multi_select") {
      const options = optionsOf(spec, kind);
      out += options.length ? `  options: ${options.join(" | ")}\n` : "  no options configured yet\n";
    } else if (kind === "number") {
      const format = spec?.number?.format;
      if (format) out += `  format: ${format}\n`;
    } else if (kind === "formula") {
      const expression = spec?.formula?.expression;
      if (expression) out += `  expression: ${notion.clip(expression, 200)}\n`;
      out += "  computed by Notion; cannot be written\n";
    } else if (kind === "relation") {
      const target = spec?.relation?.data_source_id;
      if (target) out += `  points at data source: ${target}\n`;
      out += "  write with a list of page ids\n";
    } else if (kind === "rollup") {
      out += "  computed by Notion; cannot be written\n";
    } else if (kind === "title") {
      out += "  this is the page title\n";
    } else if (["created_time", "created_by", "last_edited_time", "last_edited_by", "unique_id"].includes(kind)) {
      out += "  maintained by Notion; cannot be written\n";
    }
  }

  out +=
    "\nWhen writing these with notion_page_create or notion_page_update, plain values are " +
    "accepted: a string for text/select/url, a number for number, true/false for checkbox, an " +
    "ISO date for date, a list of option names for multi_select, a list of page ids for relation.\n";
  return out;
}

function optionsOf(spec, kind) {
  const options = spec?.[kind]?.options;
  return Array.isArray(options) ? options.map((o) => o?.name).filter((n) => typeof n === "string") : [];
}

/** A database is a container: it has no schema of its own, its data sources do. */
function renderDatabase(database, id) {
  const sources = Array.isArray(database?.data_sources) ? database.data_sources : [];
  let out =
    `${id} is a database, not a data source: "${notion.titleOf(database)}".\n\n` +
    "A database holds one or more data sources, and the schema belongs to the data source. " +
    "Call this tool again with one of these ids:\n";

  if (!sources.length) return out + "  (this database reports no data sources)\n";
  for (const source of sources) {
    out += `  ${source?.id ?? "?"} — ${source?.name ?? "(unnamed)"}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// notion_users
// ---------------------------------------------------------------------------

const USERS_DEFAULT_LIMIT = 50;
const USERS_MAX_LIMIT = 100;

export async function users(args, env) {
  const c = client(env);

  if (args?.whoami === true) {
    const me = await c.get("/v1/users/me");
    return renderMe(me);
  }

  const want = notion.limitArg(args, USERS_DEFAULT_LIMIT, USERS_MAX_LIMIT);
  const { results: all, nextCursor } = await c.paginate("GET", "/v1/users", {}, want);

  // Notion has no user search parameter, so filtering happens here. Worth
  // having anyway: a large workspace's user list is mostly noise.
  const query = notion.optionalStr(args, "query")?.toLowerCase();
  const matched = query
    ? all.filter((user) => {
        const name = (user?.name ?? "").toLowerCase();
        const email = (emailOf(user) ?? "").toLowerCase();
        return name.includes(query) || email.includes(query);
      })
    : all;

  if (!matched.length) {
    return query
      ? `No users match ${JSON.stringify(query)} among the ${all.length} the connection can see.`
      : "This connection can see no users. Listing users needs the 'read user information' " +
          "capability, which is set per connection.";
  }

  let out = `${matched.length} user(s).\n`;
  for (const user of matched) {
    const kind = user?.type || "user";
    out += `\n- ${user?.name ?? "(no name)"} [${kind}]\n  id: ${user?.id ?? "?"}\n`;
    const email = emailOf(user);
    if (email) out += `  email: ${email}\n`;
  }

  out += '\nWrite a people property with these ids, e.g. {"Owner": ["<id>"]}.\n';
  if (!query) out += notion.paginationNote(matched.length, nextCursor);
  return out;
}

function emailOf(user) {
  return user?.person?.email;
}

function renderMe(me) {
  let out = "This token authenticates as:\n";
  out += `  name: ${me?.name ?? "(none)"}\n`;
  out += `  id: ${me?.id ?? "?"}\n`;
  const kind = me?.type ?? "";
  out += `  type: ${kind}\n`;

  const bot = me?.bot;
  if (bot?.owner) {
    const ownerType = bot.owner?.type ?? "?";
    out += `  owner: ${ownerType}\n`;
    const ownerName = bot.owner?.user?.name;
    if (ownerName) out += `  acting for: ${ownerName}\n`;
  }
  if (bot?.workspace_name) out += `  workspace: ${bot.workspace_name}\n`;

  out +=
    "\nThe token works. Note that authenticating says nothing about what it can see: Notion " +
    "shares no content with a connection until a page or database is explicitly connected to " +
    "it. If reads return 404, sharing is the thing to check.\n";
  return out;
}

// ---------------------------------------------------------------------------
// notion_comment_list
// ---------------------------------------------------------------------------

const COMMENTS_DEFAULT_LIMIT = 50;
const COMMENTS_MAX_LIMIT = 100;

export async function commentList(args, env) {
  const c = client(env);
  const pageId = notion.requiredId(args, "page_id");
  const want = notion.limitArg(args, COMMENTS_DEFAULT_LIMIT, COMMENTS_MAX_LIMIT);

  const base = { block_id: pageId };
  const cursor = notion.optionalStr(args, "start_cursor");
  if (cursor) base.start_cursor = cursor;

  const { results: comments, nextCursor } = await c.paginate("GET", "/v1/comments", base, want);

  if (!comments.length) {
    return (
      `No unresolved comments on ${pageId}.\n\n` +
      "The API only exposes unresolved comments, so resolved threads would not appear here. If " +
      "you expected comments and the connection is new, check that it has comment read " +
      "capability — that is off by default."
    );
  }

  return renderComments(c, comments, nextCursor, pageId);
}

/** Renders threads, resolving author ids to names first. */
async function renderComments(c, comments, nextCursor, pageId) {
  // Group by discussion, preserving the order threads first appear so the
  // output is stable between calls.
  const threads = [];
  const byId = new Map();
  for (const comment of comments) {
    const discussion = comment?.discussion_id ?? "(no discussion id)";
    if (!byId.has(discussion)) {
      byId.set(discussion, []);
      threads.push(discussion);
    }
    byId.get(discussion).push(comment);
  }

  // Comments carry only an author id. One attempt at the workspace user
  // listing turns those into names; a personal access token is refused it, in
  // which case ids are shortened for display instead.
  const names = await notion.resolveUserNames(c);
  const namesUnavailable = names.size === 0;

  let out = `${comments.length} unresolved comment(s) on ${pageId}, in ${threads.length} thread(s).\n`;

  for (const discussion of threads) {
    out += `\n--- discussion ${discussion} ---\n`;
    for (const comment of byId.get(discussion)) {
      const author = notion.userLabel(comment?.created_by ?? {}, names);
      const when = comment?.created_time ?? "";
      out += `${author} at ${when}:\n`;

      const text = notion.richText(comment?.rich_text ?? []);
      if (!text.trim()) {
        out += "  (empty comment)\n";
      } else {
        for (const line of notion.clip(text.trim(), 1500).split("\n")) out += `  ${line}\n`;
      }

      if (comment?.id) out += `  comment id: ${comment.id}\n`;
      if (Array.isArray(comment?.attachments) && comment.attachments.length) {
        out += `  ${comment.attachments.length} attachment(s)\n`;
      }
    }
    out += `reply into this thread: notion_comment_add with discussion_id ${discussion}\n`;
  }

  if (namesUnavailable) {
    out +=
      "\nAuthors show as ids: this token cannot read the workspace user list (a personal " +
      "access token may only look itself up). An integration token with user-information " +
      "capability would show names.\n";
  }
  out += notion.paginationNote(comments.length, nextCursor);
  return out;
}

// ---------------------------------------------------------------------------
// notion_comment_add
// ---------------------------------------------------------------------------

export async function commentAdd(args, env) {
  const c = client(env);

  const text = notion.requiredStr(args, "text");
  const page = notion.optionalId(args, "page_id");
  const block = notion.optionalId(args, "block_id");
  const discussion = notion.optionalId(args, "discussion_id");

  const targets = [page, block, discussion].filter((t) => t !== undefined).length;
  if (targets !== 1) {
    throw new Error(
      `give exactly one target, not ${targets}: page_id to comment on a page, block_id to ` +
        "comment on one block within a page, or discussion_id to reply to an existing thread " +
        "(list them with notion_comment_list)."
    );
  }

  // Markdown, not rich_text: the API accepts either, and markdown means a
  // caller does not have to build rich-text objects to write bold text.
  const body = { markdown: text };

  let whereTo;
  if (discussion !== undefined) {
    body.discussion_id = discussion;
    whereTo = `discussion ${discussion}`;
  } else if (page !== undefined) {
    body.parent = { page_id: page };
    whereTo = `page ${page}`;
  } else {
    body.parent = { block_id: block };
    whereTo = `block ${block}`;
  }

  const displayName = notion.optionalStr(args, "display_name");
  if (displayName !== undefined) body.display_name = { type: "custom", custom: { name: displayName } };

  const comment = await c.post("/v1/comments", body);

  let out = `Comment added to ${whereTo}.\n`;
  if (comment?.id) out += `comment id: ${comment.id}\n`;
  if (comment?.discussion_id) out += `discussion id: ${comment.discussion_id}\n`;

  const written = notion.richText(comment?.rich_text ?? []);
  if (written.trim()) out += `\ntext as stored: ${notion.clip(written, 500)}\n`;
  return out;
}

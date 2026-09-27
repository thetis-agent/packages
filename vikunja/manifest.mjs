// Generates package.json. Run: node manifest.mjs  (from this directory)
// Tool descriptions live here as JS so they can be edited without fighting
// JSON escaping; the output file is what the kernel reads.
import { writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";

const S = (description, extra = {}) => ({ type: "string", description, ...extra });
const B = (description) => ({ type: "boolean", description });
const I = (description, extra = {}) => ({ type: "integer", description, ...extra });
const N = (description) => ({ type: "number", description });
const O = (description) => ({ type: "object", description, additionalProperties: true });
const A = (description, items = { type: "string" }) => ({ type: "array", description, items });
const obj = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
/** An argument that may be an id or a title. */
const IDT = (description) => ({ type: ["string", "integer"], description });

const PROJECT = IDT("The project: its numeric id, or its title (exact, case-insensitive; the id is safer when titles repeat).");
const VIEW = IDT("The kanban view: its id or title. Omit when the project has exactly one kanban view, which is the usual case.");
const BUCKET = IDT("The bucket (column): its id or its title, e.g. \"In Progress\".");

const TASK_FIELDS = {
  title: S("The task title."),
  description: S("The description. Plain text or markdown-ish paragraphs are wrapped as HTML for Vikunja's editor; HTML passes through. Empty string clears."),
  done: B("Mark done or not done. Marking done moves the card to the view's done bucket when one is set."),
  due_date: S("Due date: ISO 8601, \"today\", \"tomorrow\", \"+3d\", \"+2w\"; empty string clears."),
  start_date: S("Start date, same forms as due_date."),
  end_date: S("End date, same forms as due_date."),
  priority: I("0 unset, 1 low, 2 medium, 3 high, 4 urgent, 5 DO NOW."),
  percent_done: N("Progress: 0-1, or 0-100 (values above 1 are read as percent)."),
  color: S("Card colour as hex, with or without #. Empty string clears."),
  is_favorite: B("Star the task (it then appears in the Favorites pseudo-project)."),
  repeat_after: S("Repeat interval: seconds, or a number with s/m/h/d/w such as \"1d\" or \"2w\". 0 or empty stops repeating."),
  repeat_mode: S("How a repeat is computed when the task is marked done: default (from the dates), month (each month), from_done (from the completion time).", { enum: ["default", "month", "from_done"] }),
  reminders: A("Reminders, replacing the current list. Each is an absolute date, or relative like \"-1d due\", \"-2h start\", \"0m end\"."),
  add_labels: A("Labels to add, by title or id. Unknown titles are created when create_labels is true."),
  remove_labels: A("Labels to remove, by title or id."),
  create_labels: B("Create labels named in add_labels that do not exist yet. Defaults to false."),
  assign: A("Users to assign, by username, display name or id."),
  unassign: A("Users to unassign, by username or id."),
};

const tools = [
  {
    name: "vikunja_health",
    description:
      "Check the configured Vikunja instance: version, features, and whether the API token works and as which user. Call this first when anything else fails.",
    parameters: obj({}),
    export: "vikunjaHealth",
  },
  {
    name: "vikunja_projects",
    description:
      "List projects as a tree (id, title, identifier, archived), or with `id` read one project with its views. The discovery tool: every other tool takes a project id or title from here. A kanban board is a project's kanban view; read it with vikunja_board.",
    parameters: obj({
      id: I("Read this one project with its views instead of listing."),
      query: S("Text matched against titles. Omit to list everything."),
      include_archived: B("Also list archived projects."),
      limit: I("Projects per page, 1-500. Defaults to 50."),
      page: I("Page number, starting at 1."),
    }),
    export: "vikunjaProjects",
  },
  {
    name: "vikunja_project_save",
    description:
      "Create a project (title required; Vikunja gives it List, Gantt, Table and Kanban views with To-Do/Doing/Done buckets), or update one by id: title, description, identifier (the prefix of task identifiers), parent, colour, archive or favourite.",
    parameters: obj({
      id: I("Project to update. Omit to create."),
      title: S("The project title."),
      description: S("The project description."),
      identifier: S("Short identifier used to build task identifiers, e.g. WEB gives WEB-12. Empty string clears."),
      parent_project_id: I("Nest under this project. 0 moves it to the top level."),
      color: S("Hex colour, with or without #."),
      is_archived: B("Archive (true) or unarchive (false)."),
      is_favorite: B("Favourite or not."),
    }),
    export: "vikunjaProjectSave",
  },
  {
    name: "vikunja_project_delete",
    description: "Delete a project and every task in it. Irreversible. Prefer vikunja_project_save with is_archived=true.",
    parameters: obj({ id: I("The project id.") }, ["id"]),
    export: "vikunjaProjectDelete",
  },
  {
    name: "vikunja_views",
    description:
      "List a project's views (list, gantt, table, kanban) with their ids, bucket mode and done/default bucket. Only needed when a project has several kanban views or none; vikunja_board finds the single kanban view itself.",
    parameters: obj({ project: PROJECT }, ["project"]),
    export: "vikunjaViews",
  },
  {
    name: "vikunja_view_save",
    description:
      "Create a view in a project (title and kind required), or update one by id: title, filter, position, bucket configuration mode, and for kanban views which bucket is the done bucket (cards moved there are marked done) and which is the default bucket (new tasks land there).",
    parameters: obj(
      {
        project: PROJECT,
        id: I("View to update. Omit to create."),
        title: S("The view title."),
        kind: S("The view kind, required to create.", { enum: ["list", "gantt", "table", "kanban"] }),
        filter: S("A Vikunja filter query the view applies, e.g. `done = false && priority >= 3`. See https://vikunja.io/docs/filters. Empty string clears."),
        position: N("Order among the project's views; lower is first."),
        bucket_configuration_mode: S("Kanban only: manual (drag cards between buckets), filter (each bucket is a filter), none.", { enum: ["none", "manual", "filter"] }),
        done_bucket: IDT("Kanban only: the bucket (id or title) that marks tasks done. Empty string unsets."),
        default_bucket: IDT("Kanban only: the bucket (id or title) new tasks are added to. Empty string unsets (leftmost)."),
      },
      ["project"]
    ),
    export: "vikunjaViewSave",
  },
  {
    name: "vikunja_view_delete",
    description: "Delete a view from a project. Tasks are untouched; only this arrangement of them goes.",
    parameters: obj({ project: PROJECT, id: I("The view id.") }, ["project", "id"]),
    export: "vikunjaViewDelete",
  },
  {
    name: "vikunja_board",
    description:
      "Read a kanban board: every bucket (column) in order with its id, WIP limit and the cards in it, one line per task with id, title, priority, due date, labels and assignees. Give the project by id or title; the view is found automatically when the project has one kanban view. Pass raw=true for JSON.",
    parameters: obj(
      {
        project: PROJECT,
        view: VIEW,
        filter: S("Only cards matching this Vikunja filter, e.g. `labels in 'bug'` or `due_date < now+7d`."),
        search: S("Only cards whose title matches this text."),
        hide_done: B("Leave out done tasks."),
        with_descriptions: B("Include each card's description text (clipped)."),
        per_bucket: I("Cards per bucket, 1-500. Defaults to 50."),
        raw: B("Return JSON instead of the text rendering."),
      },
      ["project"]
    ),
    export: "vikunjaBoard",
  },
  {
    name: "vikunja_bucket_save",
    description:
      "Add a column to a kanban board (title required, bucket omitted), or update one by id or title: rename, set a WIP limit (0 = none), reorder by position, and optionally make it the view's done or default bucket.",
    parameters: obj(
      {
        project: PROJECT,
        view: VIEW,
        bucket: IDT("The bucket to update, by id or title. Omit to create."),
        title: S("The column title."),
        limit: I("WIP limit: how many tasks may sit in this column. 0 for no limit."),
        position: N("Order among the columns; lower is further left. Use a value between two neighbours to insert."),
        set_done: B("Make this the view's done bucket."),
        set_default: B("Make this the view's default bucket for new tasks."),
      },
      ["project"]
    ),
    export: "vikunjaBucketSave",
  },
  {
    name: "vikunja_bucket_delete",
    description: "Remove a column from a kanban board. Its cards move to the view's default bucket. The last bucket cannot be removed.",
    parameters: obj({ project: PROJECT, view: VIEW, bucket: BUCKET }, ["project", "bucket"]),
    export: "vikunjaBucketDelete",
  },
  {
    name: "vikunja_tasks",
    description:
      "List tasks as a flat list, across all projects or in one, with search, a Vikunja filter query, done state, sorting and paging. For a board's columns use vikunja_board instead. Filter syntax: fields done, priority, due_date, start_date, end_date, percent_done, labels, assignees, project, created, updated; operators = != > >= < <= like in; join with && ||; dates accept now, now+7d, now-1w, ISO. Examples: `done = false && due_date < now+7d`, `labels in 'bug', 'urgent'`, `assignees in 'alice'`.",
    parameters: obj({
      project: IDT("Limit to this project (id or title). Omit for every project the token's user can see."),
      search: S("Text matched against task titles."),
      filter: S("A Vikunja filter query; see the tool description."),
      done: B("Only done (true) or only open (false) tasks. Omit for both."),
      sort_by: A("Fields to sort by: due_date, priority, done, created, updated, title, id, position, start_date, end_date."),
      order_by: A("asc or desc, one per sort_by entry."),
      expand: A("Extra data: subtasks, buckets, reactions, comment_count."),
      limit: I("Tasks per page, 1-500. Defaults to 50."),
      page: I("Page number, starting at 1."),
      raw: B("Return JSON instead of text lines."),
    }),
    export: "vikunjaTasks",
  },
  {
    name: "vikunja_task_get",
    description:
      "Read one task in full: description, dates, labels, assignees, reminders, attachments, related tasks, which bucket it sits in on each kanban view of its project, and its comments.",
    parameters: obj(
      {
        id: I("The task id (the number after # in listings, or in the /tasks/<id> URL)."),
        with_comments: B("Include comments. Defaults to true."),
      },
      ["id"]
    ),
    export: "vikunjaTaskGet",
  },
  {
    name: "vikunja_task_create",
    description:
      "Create a task (card) in a project, with any of title, description, dates, priority, labels, assignees, reminders, repeat, and optionally straight into a named kanban bucket. Returns the new id and a one-line summary.",
    parameters: obj(
      {
        project: PROJECT,
        ...TASK_FIELDS,
        bucket: IDT("Put the card in this bucket (id or title) of the kanban view instead of the default bucket."),
        view: VIEW,
      },
      ["project", "title"]
    ),
    export: "vikunjaTaskCreate",
  },
  {
    name: "vikunja_task_update",
    description:
      "Change a task's fields: title, description, done, dates, priority, progress, colour, favourite, repeat, reminders; add or remove labels and assignees; or move it to another project. Only the fields given change. To move a card between columns use vikunja_task_move.",
    parameters: obj(
      {
        id: I("The task id."),
        ...TASK_FIELDS,
        project: IDT("Move the task to this project (id or title)."),
      },
      ["id"]
    ),
    export: "vikunjaTaskUpdate",
  },
  {
    name: "vikunja_task_move",
    description:
      "Move a card to another column of its kanban board, by bucket id or title (e.g. \"Done\", \"In Progress\"). Moving into the view's done bucket marks the task done. Optionally set its place within the column.",
    parameters: obj(
      {
        task_id: I("The task id."),
        bucket: BUCKET,
        project: IDT("The task's project (id or title). Omit to read it off the task."),
        view: VIEW,
        position: S("Where in the column: \"top\", \"bottom\", \"after:<task id>\", \"before:<task id>\", or a raw position number. Omit to keep Vikunja's default."),
      },
      ["task_id", "bucket"]
    ),
    export: "vikunjaTaskMove",
  },
  {
    name: "vikunja_task_delete",
    description: "Delete a task. Irreversible from here (Vikunja keeps soft-deleted tasks 30 days server-side). Prefer marking it done.",
    parameters: obj({ id: I("The task id.") }, ["id"]),
    export: "vikunjaTaskDelete",
  },
  {
    name: "vikunja_labels",
    description: "List labels (id, title, colour), search them by title, or create one with `create`. Labels are per user and shared across projects.",
    parameters: obj({
      query: S("Text matched against label titles."),
      create: S("Create a label with this title (no-op with a note when it exists)."),
      color: S("Hex colour for the created label."),
      description: S("Description for the created label."),
    }),
    export: "vikunjaLabels",
  },
  {
    name: "vikunja_comments",
    description: "Read the comments on a task, add one with `add`, or edit/delete one by comment_id.",
    parameters: obj(
      {
        task_id: I("The task id."),
        add: S("Add a comment with this text."),
        comment_id: I("With edit or delete: the comment to change."),
        edit: S("New text for comment_id."),
        delete: B("Delete comment_id."),
      },
      ["task_id"]
    ),
    export: "vikunjaComments",
  },
  {
    name: "vikunja_relate",
    description:
      "Link two tasks: subtask, parenttask, related, duplicateof, duplicates, blocking, blocked, precedes, follows, copiedfrom, copiedto. `task_id kind other_task_id` reads as a sentence: task 5 `subtask` 3 makes 5 a subtask of 3. Pass remove=true to unlink.",
    parameters: obj(
      {
        task_id: I("The base task."),
        other_task_id: I("The other task."),
        kind: S("The relation kind. Defaults to related.", { enum: ["subtask", "parenttask", "related", "duplicateof", "duplicates", "blocking", "blocked", "precedes", "follows", "copiedfrom", "copiedto"] }),
        remove: B("Remove the relation instead of adding it."),
      },
      ["task_id", "other_task_id"]
    ),
    export: "vikunjaRelate",
  },
  {
    name: "vikunja_request",
    description:
      "Call any Vikunja API v1 endpoint with the configured URL and token, for what the other tools do not cover: teams, sharing, webhooks, saved filters, attachments, bulk task edits (POST /tasks/bulk), user settings. Vikunja creates with PUT and updates with POST. Paths are relative to /api/v1. Returns the JSON reply.",
    parameters: obj(
      {
        method: S("HTTP method. Defaults to GET.", { enum: ["GET", "PUT", "POST", "PATCH", "DELETE"] }),
        path: S("The path under /api/v1, e.g. /projects/3/webhooks or /tasks/bulk."),
        query: O("Query string parameters."),
        body: O("JSON request body for PUT/POST/PATCH."),
      },
      ["path"]
    ),
    export: "vikunjaRequest",
  },
];

const config = {
  url: {
    type: "string",
    required: true,
    help: "Base URL of the Vikunja instance, e.g. http://vikunja.local:3456 or https://tasks.example.com. With or without /api/v1.",
  },
  token: {
    type: "string",
    secret: true,
    required: true,
    help: "An API token (tk_…) from Settings → API Tokens in Vikunja, with the permission groups the tasks need: projects, tasks, labels, project views, kanban buckets, task comments, assignees, relations. Every vikunja_* tool reads it.",
  },
  timeoutMs: {
    type: "number",
    default: 30000,
    help: "Per-request timeout in milliseconds, clamped to 5000-120000.",
  },
};

const dir = new URL(".", import.meta.url).pathname;
const existing = existsSync(`${dir}package.json`) ? JSON.parse(readFileSync(`${dir}package.json`, "utf8")) : {};

const manifest = {
  name: "@bitmuse/vikunja",
  version: existing.version ?? "0.1.0",
  description:
    "Vikunja's REST API as tools: read and edit kanban boards (projects, views, buckets, cards), create, update, move, label, assign and relate tasks, comments, and call any other endpoint, against one configured self-hosted Vikunja instance.",
  keywords: ["vikunja", "kanban", "tasks", "todo", "project management", "board"],
  license: "MIT",
  type: "module",
  main: "index.js",
  scripts: { test: "node test.smoke.mjs" },
  thetis: {
    type: "tool",
    toolGroup: {
      id: "vikunja",
      brief: "Read and edit Vikunja kanban boards and tasks over its REST API.",
      tags: ["vikunja", "kanban", "kanban board", "bucket", "buckets", "todo list", "to-do", "task board", "backlog", "sprint board", "card", "cards"],
    },
    tools,
    config,
  },
};

writeFileSync(`${dir}package.json`, JSON.stringify(manifest, null, 2) + "\n");
// The agent imports main with ?v=<its mtime>, so an edit to tools.js or
// client.js alone is invisible until index.js changes too. Touch it.
if (existsSync(`${dir}index.js`)) utimesSync(`${dir}index.js`, new Date(), new Date());
console.log(`wrote package.json: ${tools.length} tools, ${Object.keys(config).length} config keys, version ${manifest.version}`);

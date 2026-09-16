/* The three list sections of the project page. `directoriesSection` draws the project directories: one
 * row per path, and under the path one sentence that says what an agent in this project can do with it
 * right now, because a directory a project names is not a directory the agent can reach. A mount is what
 * makes it reachable, and a mount is the operator's to give: an admin binds one from the row itself, and
 * anyone else is given the line to hand to an admin. The states come from the server (`get` and `mounts`),
 * never from a guess in the browser, so a row cannot claim more than the fence really has.
 * `toolsSection` draws every installed package's tools with a switch per tool, on unless the project
 * switched it off. `skillsSection` draws every skill the loaders see, grouped by the package it comes
 * from, with the same switch; a nested skill whose parent is off is off with it and its switch is greyed.
 * All three edit the draft they are given and ask the page to redraw through `redraw`; only the mount
 * buttons send a request, through the `mount` function the page passes in. */

const X = ["M5 5l10 10", "M15 5l-10 10"];

/** How each state looks and reads. `act` is what the row offers an admin: bind it, or nothing to do. */
const STATES = {
  ready: { badge: ["mounted · read-write", "ok"], line: () => "The file tools can read and write here.", act: "unbind" },
  "ready-ro": { badge: ["mounted · read-only", "accent"], line: () => "The file tools can read here. Writing is refused.", act: "unbind" },
  "ready-home": { badge: ["in your space", "ok"], line: () => "Inside your own space: the file tools can read and write here, and it needs no mount.", act: null },
  "empty-path": { badge: ["nothing at this path", "warn"], line: () => "Nothing is at this path yet. Make the directory, or fix the path.", act: "unbind" },
  "not-a-directory": { badge: ["not a directory", "warn"], line: () => "A file is at this path, not a directory.", act: "unbind" },
  skipped: { badge: ["not mounted", "err"], line: (s) => `A mount is written down for ${s.mount}, and the host has no directory there, so your workspace opened without it. The path is wrong, or the directory is gone.`, act: "bind" },
  unmounted: { badge: ["not mounted", "err"], line: () => "Nothing is bound over this path, so the file tools cannot reach it. An agent in this project will find it missing.", act: "bind" },
  unknown: { badge: ["checking…", "dim"], line: () => "Reading what the fence has here.", act: null },
};

/** The state record for one row, with the read-only variant of `ready` folded in. */
function keyOf(state) {
  if (!state) return "unknown";
  if (state.state === "ready") return state.home ? "ready-home" : state.mode === "ro" ? "ready-ro" : "ready";
  return STATES[state.state] ? state.state : "unknown";
}

/** One sentence for the whole section: how many directories an agent in this project can actually use. */
function summaryOf(paths, states) {
  const bad = paths.filter((p) => !["ready", "ready-ro", "ready-home"].includes(keyOf(states[p])));
  if (!paths.length || !bad.length) return null;
  const n = bad.length;
  return `${n} of ${paths.length} ${n === 1 ? "directory is" : "directories are"} not usable. An agent in this project cannot read ${n === 1 ? "it" : "them"}.`;
}

function dirRow(ext, path, state, draft, redraw, mount, user) {
  const { el, icon } = ext.dom;
  const { badge, button } = ext.ui;
  const key = keyOf(state);
  const spec = STATES[key];
  const admin = ext.can("mount");
  const actions = [];
  if (admin && spec.act === "bind") {
    const bind = button("Bind it", { tone: "primary", onClick: () => mount(bind, path, "rw") });
    actions.push(bind);
  }
  if (admin && spec.act === "unbind" && state?.mode && !state.home) {
    const other = state.mode === "rw" ? "ro" : "rw";
    const swap = button(other === "ro" ? "Make read-only" : "Allow writing", { onClick: () => mount(swap, path, other) });
    const off = button("Unbind", { tone: "warn", onClick: () => mount(off, path, null) });
    actions.push(swap, off);
  }
  return el(
    "li",
    { class: `pj-dir is-${key}`, "data-path": path },
    el("div", { class: "pj-dir-top" },
      el("code", { class: "pj-dir-path" }, path),
      badge(...spec.badge),
      el("span", { class: "pj-dir-spacer" }),
      el("button", {
        type: "button",
        class: "icon-btn sm pj-dir-remove",
        title: `Remove ${path} from the project`,
        "aria-label": `Remove ${path} from the project`,
        onClick: () => {
          draft.directories = draft.directories.filter((d) => d !== path);
          redraw();
        },
      }, icon(X, { size: 11, width: 1.9 }))
    ),
    el("p", { class: "pj-dir-state" }, spec.line(state ?? {})),
    actions.length ? el("div", { class: "pj-dir-actions" }, ...actions) : null,
    !admin && spec.act === "bind" ? el("p", { class: "pj-dir-ask" }, "Ask an admin for: ", el("code", {}, `thetis mounts add ${user} ${path}`)) : null
  );
}

/**
 * The directories section. `states` maps a path to what the server says about it; `mount` binds, changes
 * or unbinds one (only an admin has it); `pick` opens the directory picker, so a path that goes in is a
 * path the host really has.
 */
export function directoriesSection(ext, draft, states, redraw, { mount, pick, user = "you" } = {}) {
  const { el } = ext.dom;
  const { section, button } = ext.ui;
  const rows = draft.directories.map((path) => dirRow(ext, path, states[path], draft, redraw, mount, user));
  const input = el("input", { class: "input pj-dir-input", type: "text", placeholder: "/srv/repos/example", "aria-label": "A directory to add", spellcheck: "false", autocomplete: "off" });
  const accept = (value) => {
    if (!value) return false;
    if (!value.startsWith("/")) return ext.toast("A project directory is an absolute path, starting with /.", { tone: "error" }), false;
    if (value.split("/").includes("..")) return ext.toast('A project directory cannot contain "..".', { tone: "error" }), false;
    if (draft.directories.includes(value)) return ext.toast("That directory is already listed.", { tone: "warn" }), false;
    if (draft.directories.length >= 64) return ext.toast("A project holds at most 64 directories.", { tone: "error" }), false;
    draft.directories = [...draft.directories, value];
    return true;
  };
  const add = () => {
    const value = input.value.trim().replace(/(?!^)\/+$/, "");
    if (!accept(value)) return;
    input.value = "";
    redraw();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  });
  const choose = ext.can("browse") && pick ? button("Choose a directory…", { tone: "primary", onClick: () => pick(choose, accept) }) : null;
  const summary = summaryOf(draft.directories, states);
  return el(
    "section",
    { class: "pj-section" },
    section("Project directories", `${draft.directories.length} of 64`),
    summary ? el("p", { class: "pj-warn" }, summary) : null,
    rows.length ? el("ul", { class: "pj-dirs" }, ...rows) : el("p", { class: "pj-empty" }, "No project directories."),
    el("div", { class: "pj-dir-add" }, choose, input, button("Add a directory", { onClick: add })),
    el("p", { class: "pj-note" }, choose
      ? "A directory is reachable once it is bound into your workspace. Binding closes and reopens the workspace, so this page reconnects; conversations are not lost."
      : "None by default. A directory outside your space reaches the file tools once an admin binds it; until then it is listed here and marked not mounted.")
  );
}

function toolRow(ext, tool, draft, redraw) {
  const { el } = ext.dom;
  const input = el("input", { type: "checkbox", class: "pj-switch", checked: !draft.disable.has(tool.name) ? "" : null, "aria-label": `${tool.name} on` });
  input.addEventListener("change", () => {
    if (input.checked) draft.disable.delete(tool.name);
    else draft.disable.add(tool.name);
    redraw();
  });
  return el(
    "label",
    { class: `pj-tool${draft.disable.has(tool.name) ? " is-off" : ""}` },
    el("span", { class: "pj-tool-text" }, el("code", { class: "pj-tool-name" }, tool.name), tool.description ? el("span", { class: "pj-tool-desc" }, tool.description) : null),
    input
  );
}

export function toolsSection(ext, draft, groups, redraw) {
  const { el } = ext.dom;
  const { section } = ext.ui;
  const total = groups.reduce((n, g) => n + g.tools.length, 0);
  const off = draft.disable.size;
  const blocks = groups.map((g) =>
    el(
      "div",
      { class: "pj-tool-group" },
      el("div", { class: "pj-tool-group-head" }, el("code", { class: "pj-tool-package" }, g.package), g.version ? el("span", { class: "pj-tool-version" }, g.version) : null),
      el("div", { class: "pj-tool-list" }, ...g.tools.map((t) => toolRow(ext, t, draft, redraw)))
    )
  );
  return el(
    "section",
    { class: "pj-section" },
    section("Tools", off ? `${total} tools, ${off} switched off for this project` : `${total} tools, every one on`),
    blocks.length ? el("div", { class: "pj-tool-groups" }, ...blocks) : el("p", { class: "pj-empty" }, "No tool packages are installed."),
    el("p", { class: "pj-note" }, "Every tool is on unless switched off here. A switched-off tool is left out of the call for conversations in this project.")
  );
}

/** "self" when the id is switched off by name, the parent's id when a parent is, or null. */
export function skillOffBy(id, off) {
  if (off.has(id)) return "self";
  for (const x of off) if (id.startsWith(`${x}/`)) return x;
  return null;
}

function skillRow(ext, skill, draft, redraw) {
  const { el } = ext.dom;
  const by = skillOffBy(skill.id, draft.disableSkills);
  const byParent = by && by !== "self";
  const input = el("input", { type: "checkbox", class: "pj-switch", checked: by ? null : "", disabled: byParent ? "" : null, "aria-label": `${skill.id} on`, title: byParent ? `Switched off with ${by}` : null });
  input.addEventListener("change", () => {
    if (input.checked) draft.disableSkills.delete(skill.id);
    else draft.disableSkills.add(skill.id);
    redraw();
  });
  return el(
    "label",
    { class: `pj-tool pj-skill${by ? " is-off" : ""}${skill.id.includes("/") ? " is-nested" : ""}`, "data-skill": skill.id },
    el("span", { class: "pj-tool-text" }, el("code", { class: "pj-tool-name" }, skill.id), skill.short ? el("span", { class: "pj-tool-desc" }, skill.short) : null),
    input
  );
}

/** Every skill the loaders see, grouped by the package it comes from (the home last), a switch per skill. */
export function skillsSection(ext, draft, skills, redraw) {
  const { el } = ext.dom;
  const { section } = ext.ui;
  const groups = new Map();
  for (const s of skills) {
    const key = s.package ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const off = skills.filter((s) => skillOffBy(s.id, draft.disableSkills)).length;
  const blocks = [...groups].map(([pkg, list]) =>
    el(
      "div",
      { class: "pj-tool-group pj-skill-group" },
      el("div", { class: "pj-tool-group-head" }, el("code", { class: "pj-tool-package" }, pkg || "your skills/")),
      el("div", { class: "pj-tool-list" }, ...list.map((s) => skillRow(ext, s, draft, redraw)))
    )
  );
  return el(
    "section",
    { class: "pj-section pj-skills" },
    section("Skills", skills.length ? (off ? `${skills.length} skills, ${off} switched off for this project` : `${skills.length} skills, every one on`) : null),
    blocks.length ? el("div", { class: "pj-tool-groups" }, ...blocks) : el("p", { class: "pj-empty" }, "No skills are installed. A package that declares thetis.skills, or a skills/ directory under your home, adds some; each appears here with a switch."),
    el("p", { class: "pj-note" }, "Every skill is on unless switched off here. A switched-off skill is left out of the prompt and of skill_fetch for conversations in this project, and a switched-off parent switches off its nested skills too.")
  );
}

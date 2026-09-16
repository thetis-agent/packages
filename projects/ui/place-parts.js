/* The three list sections of the project page. `directoriesSection` draws the project directories: one
 * row per path with a badge that says whether the fence has it mounted (read-write, read-only, or not
 * at all), a remove ✕, an input and a button to add one, and the note that a directory outside the
 * person's space needs an admin's mount. `toolsSection` draws every installed package's tools with a
 * switch per tool, on unless the project switched it off. `skillsSection` draws every skill the loaders
 * see, grouped by the package it comes from, with the same switch; a nested skill whose parent is off is
 * off with it and its switch is greyed. All three edit the draft they are given and ask the page to
 * redraw through `redraw`; none sends a request. */

const X = ["M5 5l10 10", "M15 5l-10 10"];

function isWithin(p, root) {
  return p === root || (p.startsWith(root.endsWith("/") ? root : root + "/"));
}

/** "rw", "ro", or null: the same rule the package applies on the server, for a row added just now. */
export function mountModeOf(directory, mounts) {
  for (const m of mounts) if (isWithin(directory, m.path)) return m.mode;
  return null;
}

function mountBadge(ext, mode) {
  const { badge } = ext.ui;
  if (mode === "rw") return badge("mounted · read-write", "ok");
  if (mode === "ro") return badge("mounted · read-only", "accent");
  return badge("not mounted", "warn");
}

export function directoriesSection(ext, draft, mounts, redraw) {
  const { el, icon } = ext.dom;
  const { section, button } = ext.ui;
  const rows = draft.directories.map((path) =>
    el(
      "li",
      { class: "pj-dir" },
      el("code", { class: "pj-dir-path" }, path),
      mountBadge(ext, mountModeOf(path, mounts)),
      el(
        "button",
        {
          type: "button",
          class: "icon-btn sm pj-dir-remove",
          title: `Remove ${path}`,
          "aria-label": `Remove ${path}`,
          onClick: () => {
            draft.directories = draft.directories.filter((d) => d !== path);
            redraw();
          },
        },
        icon(X, { size: 11, width: 1.9 })
      )
    )
  );
  const input = el("input", { class: "input pj-dir-input", type: "text", placeholder: "/srv/repos/example", "aria-label": "A directory to add", spellcheck: "false", autocomplete: "off" });
  const add = () => {
    const value = input.value.trim().replace(/\/+$/, "") || (input.value.trim() === "/" ? "/" : "");
    if (!value) return;
    if (!value.startsWith("/")) return ext.toast("A project directory is an absolute path, starting with /.", { tone: "error" });
    if (value.split("/").includes("..")) return ext.toast('A project directory cannot contain "..".', { tone: "error" });
    if (draft.directories.includes(value)) return ext.toast("That directory is already listed.", { tone: "warn" });
    if (draft.directories.length >= 64) return ext.toast("A project holds at most 64 directories.", { tone: "error" });
    draft.directories = [...draft.directories, value];
    input.value = "";
    redraw();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  });
  return el(
    "section",
    { class: "pj-section" },
    section("Project directories", `${draft.directories.length} of 64`),
    rows.length ? el("ul", { class: "pj-dirs" }, ...rows) : el("p", { class: "pj-empty" }, "No project directories."),
    el("div", { class: "pj-dir-add" }, input, button("Add a directory", { onClick: add })),
    el("p", { class: "pj-note" }, "None by default. A directory outside your space reaches the file tools once an admin mounts it (thetis mounts add …); until then it is listed and marked.")
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

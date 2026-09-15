/* The two list sections of the project page. `directoriesSection` draws the project directories: one
 * row per path with a badge that says whether the fence has it mounted (read-write, read-only, or not
 * at all), a remove ✕, an input and a button to add one, and the note that a directory outside the
 * person's space needs an admin's mount. `toolsSection` draws every installed package's tools with a
 * switch per tool, on unless the project switched it off. Both edit the draft they are given and ask
 * the page to redraw through `redraw`; neither sends a request. */

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

export function skillsSection(ext) {
  const { el } = ext.dom;
  const { section } = ext.ui;
  return el("section", { class: "pj-section" }, section("Skills"), el("p", { class: "pj-empty" }, "No skill packages are installed. When one is, its skills appear here with the same switches."));
}

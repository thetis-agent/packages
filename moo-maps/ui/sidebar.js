/* The Maps section of the sidebar: the maps of the space the person is in — a project's own, or under No
 * project those with none and those whose project is gone (a gateway without spaces shows every map) —
 * newest first, with its publish state as a badge (draft, linked, published, changed), its room count, and
 * how long ago it changed. ＋ makes a map in the space and opens its tab there; a row's menu renames it,
 * moves it to a project or out of one, copies its id for a chat, or deletes it (the world is never touched). */

const TAB = "map";
const PLUS = "M10 4v12M4 10h12";
const MORE = "M5 10h.01M10 10h.01M15 10h.01";
const BADGE = { draft: "draft", linked: "linked", published: "live", changed: "changed" };

function when(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function mountSidebar(ext, model, body, tools) {
  const { el, icon, clear } = ext.dom;
  let renaming = null;
  const list = el("div", { class: "mm-list", role: "list" });
  body.append(list);
  const plus = el("button", { type: "button", class: "icon-btn sm", title: "New map", "aria-label": "New map", onClick: () => void create() }, icon(PLUS, { size: 14, width: 1.8 }));
  tools?.setActions?.(plus);

  async function create() {
    plus.disabled = true;
    try {
      const map = await model.create("Untitled map");
      if (map) await ext.open.tab(TAB, map.id, { id: map.id }, { space: map.project ?? null });
    } catch (err) {
      ext.toast(`The map was not created: ${err.message}`, { tone: "error" });
    } finally {
      plus.disabled = false;
    }
  }

  /** The rows the space shows: a project's own, or under No project those with none and those whose
   *  project is gone. A gateway without spaces shows every row. */
  function visible() {
    if (!model.spaced) return model.maps;
    const chosen = model.project();
    return model.maps.filter((m) => (chosen ? m.project === chosen : !m.project || m.projectMissing));
  }

  /** The space a row's tab belongs to: its project, or No project when it has none or that one is gone. */
  const spaceOf = (row) => (row.project && !row.projectMissing ? row.project : null);
  const openTab = (row) => void ext.open.tab(TAB, row.id, { id: row.id }, { space: spaceOf(row) });

  function menu(anchor, row) {
    const items = [
      { label: "Open", run: () => openTab(row) },
      { label: "Rename", run: () => { renaming = row.id; draw(); } },
    ];
    for (const p of model.projects.filter((p) => p.id !== row.project)) items.push({ label: `Move to ${p.name}`, run: () => void move(row, p.id) });
    if (row.project) items.push({ label: "Move out of its project", run: () => void move(row, null) });
    items.push(
      { label: "Copy id", hint: "To name it in a chat", run: () => void navigator.clipboard?.writeText(row.id).then(() => ext.toast(`Copied ${row.id}`)) },
      "-",
      { label: "Delete", danger: true, run: () => void remove(anchor, row) },
    );
    ext.ui.menu(anchor, items);
  }

  async function move(row, project) {
    try {
      await model.assign(row.id, project);
      await model.refresh();
    } catch (err) {
      ext.toast(`The map was not moved: ${err.message}`, { tone: "error" });
    }
  }

  async function remove(anchor, row) {
    const target = typeof anchor?.getBoundingClientRect === "function" ? anchor : list;
    const ok = await ext.ui.confirm(target, {
      title: "Delete this map?",
      lines: [["Map", row.title], ["Rooms", String(row.rooms)], ["State", row.label ?? row.state]],
      note: row.linked ? "Only the map is deleted. The rooms already in the MOO stay there; map_import brings them back into a new map." : "The map is deleted for good.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await model.remove(row.id);
      ext.close.tab(TAB, row.id);
      await model.refresh();
    } catch (err) {
      ext.toast(`The map was not deleted: ${err.message}`, { tone: "error" });
    }
  }

  function renameField(row) {
    const input = el("input", { type: "text", class: "mm-row-rename", value: row.title, "aria-label": "Map name", spellcheck: "false" });
    let settled = false;
    const finish = async (commit) => {
      if (settled) return;
      settled = true;
      renaming = null;
      const name = input.value.trim();
      if (commit && name && name !== row.title) {
        try {
          await model.rename(row.id, name);
        } catch (err) {
          ext.toast(`The map was not renamed: ${err.message}`, { tone: "error" });
        }
      }
      draw();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") void finish(true);
      if (event.key === "Escape") void finish(false);
    });
    input.addEventListener("blur", () => void finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    return input;
  }

  function rowNode(row) {
    const title = renaming === row.id ? renameField(row) : el("span", { class: "mm-row-title" }, row.title);
    const more = el("button", { type: "button", class: "icon-btn sm mm-row-more", title: "More", "aria-label": `More for ${row.title}`, onClick: (event) => { event.stopPropagation(); menu(more, row); } }, icon(MORE, { size: 14, width: 2 }));
    const node = el(
      "div",
      { class: `mm-row${model.active === row.id ? " is-active" : ""}`, role: "listitem", "data-map": row.id, title: `${row.title} · ${row.id}\n${row.rooms} rooms in ${row.areas} area${row.areas === 1 ? "" : "s"}\n${row.label ?? ""}${row.projectMissing ? "\nIts project is gone, so it shows under No project" : ""}` },
      el("button", { type: "button", class: "mm-row-open", onClick: () => openTab(row) },
        el("span", { class: `mm-dot is-${row.state}` }),
        title,
        el("span", { class: `mm-badge is-${row.state}` }, BADGE[row.state] ?? row.state),
        el("span", { class: "mm-row-when" }, `${row.rooms}r · ${when(row.updatedAt)}`)),
      more
    );
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      menu({ x: event.clientX, y: event.clientY }, row);
    });
    return node;
  }

  // A refusal (an extension renamed or removed since this page loaded, say) reads differently from a drop.
  const lostText = () => (model.lastError && !/ended$/.test(model.lastError) ? `Reconnecting… (${model.lastError}; reloading the page may help)` : "Reconnecting…");

  function draw() {
    clear(list);
    const rows = visible();
    tools?.setCount?.(rows.length);
    if (!rows.length) {
      const none = model.project() ? "No maps in this project. ＋ makes one." : "No maps yet. ＋ makes one, or ask in a chat to sketch an area or import one from the MOO.";
      list.append(el("div", { class: "mm-empty" }, model.status === "lost" ? lostText() : none));
      return;
    }
    for (const row of rows) list.append(rowNode(row));
    if (model.status === "lost") list.append(el("div", { class: "mm-empty" }, lostText()));
  }

  const unwatch = model.watch(draw);
  draw();
  return () => {
    unwatch();
    clear(list);
  };
}

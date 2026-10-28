/* A map as a tab: the cartographer in a sandboxed frame (lib/commands.js `editor`), and this page between
 * it and the map file. The frame edits its own copy and posts the whole document a moment after each
 * edit; the tab diffs it against the document that copy grew from and sends only that patch, which the
 * gateway lays on top of whatever is on disk — so an agent's edit made meanwhile is kept, not overwritten.
 * When anyone else changes the map (a tool call in the chat, another browser tab), the tab reads it again
 * and hands it to the frame, which keeps the view and the selection. Saves go one at a time. */

import { completeDoc, diffDocs, isEmptyPatch } from "./core/doc.js";

const FOCUS_MS = 400;

export function openMapTab(ext, model, root, handle) {
  const { el } = ext.dom;
  const id = handle.id;
  const node = el("div", { class: "mm-tab" });
  const banner = el("div", { class: "mm-banner", hidden: true });
  const body = el("div", { class: "mm-body" }, el("div", { class: "mm-wait" }, "Opening the map…"));
  node.append(banner, body);
  root.append(node);

  let frame = null;
  let rev = 0; // the revision the frame's copy is in step with
  let seq = 0; // the newest load handed to the frame
  const bases = new Map(); // seq -> the document that load handed over, as later saves left it
  let chain = Promise.resolve();
  let pendingReload = false;
  let busy = 0;
  let gone = false;
  let active = true;
  let focusTimer = null;

  const say = (text, tone = "warn") => {
    banner.hidden = !text;
    banner.className = `mm-banner is-${tone}`;
    banner.textContent = text ?? "";
  };

  async function load(message) {
    const out = await model.doc(id);
    seq += 1;
    bases.clear();
    bases.set(seq, out.doc);
    rev = out.rev;
    handle.setTitle(out.doc.name);
    const linked = { ...(out.linked ?? {}) };
    frame?.post({ type: "load", seq, doc: out.doc, rev: out.rev, state: out.state, label: out.label, linked, message });
  }

  /** One step at a time: saves and reloads never overlap, so each patch is taken against a known base. */
  const queue = (fn) => {
    busy += 1;
    chain = chain.then(fn).catch((err) => console.error("moo-maps:", err)).finally(() => {
      busy -= 1;
    });
    return chain;
  };

  function save(raw, from) {
    const doc = completeDoc(raw); // the engine's objects in the file's own shape and key order, so only real changes differ
    queue(async () => {
      const base = bases.get(from);
      if (!base) return; // a load since replaced that copy; its edits were flushed before it
      const patch = diffDocs(base, doc);
      if (isEmptyPatch(patch) && patch.nextId === undefined) {
        frame?.post({ type: "saved", ok: true, rev });
        return;
      }
      let out;
      try {
        out = await model.save(id, patch, rev);
      } catch (err) {
        frame?.post({ type: "saved", ok: false, error: err.message });
        say(`The last edit was not saved: ${err.message}`, "error");
        return;
      }
      say(null);
      bases.set(from, doc);
      const behind = out.rev !== rev + 1 && !out.unchanged; // someone else wrote in between: theirs was merged in
      if (!out.unchanged) rev = out.rev;
      frame?.post({ type: "saved", ok: true, rev, conflicts: out.conflicts });
      frame?.post({ type: "state", state: out.state, label: out.label });
      if (behind || from !== seq || out.conflicts?.length || out.renumbered?.length) await load(behind ? "Merged with changes made elsewhere" : undefined);
    });
  }

  function onMessage(data) {
    if (data.type === "save" && data.doc) save(data.doc, Number(data.seq) || 0);
    else if (data.type === "reload") queue(() => load());
    else if (data.type === "view") {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => void model.focus(id, { sel: data.sel, area: data.area, floor: data.floor }), FOCUS_MS);
    }
  }

  const unwatch = model.onMap(id, (event) => {
    if (event.kind === "removed") {
      gone = true;
      say("This map was deleted.", "error");
      node.classList.add("is-gone");
      return;
    }
    if (event.row) handle.setTitle(event.row.title);
    if (event.kind !== "changed" || event.own || event.rev <= rev) return;
    if (pendingReload) return;
    pendingReload = true;
    queue(async () => {
      pendingReload = false;
      if (event.rev <= rev) return;
      await load(event.by === "agent" ? `Updated by the agent: ${String(event.what ?? "").slice(0, 120)}` : "Updated elsewhere");
    });
  });

  async function start() {
    if (!ext.frame?.mount || !ext.raw?.url) {
      body.replaceChildren(el("div", { class: "mm-wait" }, "This gateway is too old for the map editor: it needs frames and raw commands."));
      return;
    }
    try {
      frame = await ext.frame.mount("editor", { map: id }, {
        title: "Map editor",
        className: "mm-frame",
        onMessage,
        onReady: (ok) => {
          if (!ok) {
            say("The editor did not start. Close the tab and open the map again.", "error");
            return;
          }
          queue(() => load()).then(() => {
            if (active) model.setActive(id);
          });
        },
      });
      body.replaceChildren(frame.node);
    } catch (err) {
      body.replaceChildren(el("div", { class: "mm-wait" }, `The map could not be opened: ${err.message}`));
    }
  }
  void start();

  return {
    activate() {
      active = true;
      model.setActive(id);
    },
    deactivate() {
      active = false;
      if (model.active === id) model.setActive(null);
    },
    unmount() {
      clearTimeout(focusTimer);
      unwatch();
      if (!gone) frame?.post({ type: "flush" });
      if (model.active === id) model.setActive(null);
      // a last edit still waiting in the frame posts itself on flush; give it a moment before the frame goes
      setTimeout(() => {
        frame?.destroy();
        node.remove();
      }, busy ? 1500 : 200);
    },
  };
}

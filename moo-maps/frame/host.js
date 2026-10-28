/* The glue between the cartographer and the page that holds this frame. The frame has an opaque origin
 * and may fetch nothing, so everything goes by postMessage, each message carrying the nonce the page put
 * in this document's fragment:
 *
 *   page → frame   { type: "load", seq, doc, rev, state, label, linked, message? }   the map as it is on disk
 *                  { type: "state", state, label, rev? }                         the publish badge, a save's answer
 *                  { type: "saved", rev, ok, error? }                            how the last save went
 *                  { type: "flush" }                                             send any edit still waiting
 *                  { type: "select", room }                                      show one room
 *   frame → page   { type: "ready" }  { type: "save", doc, seq }  { type: "reload" }  { type: "view", sel, area, floor }
 */
(function host() {
  var nonce = String(location.hash || "").slice(1);
  var mapper = null;
  var saving = "";
  var linked = {};
  var seq = 0; // which load the frame's state descends from: the page diffs a save against that load's doc
  var pub = document.getElementById("pubState");
  var bootNote = document.getElementById("boot");

  function post(msg) {
    msg.nonce = nonce;
    try { window.parent.postMessage(msg, "*"); } catch (e) { /* opened on its own */ }
  }

  var STATE_TEXT = { draft: "draft", linked: "linked", published: "published", changed: "unpublished changes" };
  function showState(state, label) {
    pub.textContent = STATE_TEXT[state] || state || "…";
    pub.className = "st-" + (state || "none");
    pub.title = (label || "") + "\n\nThe map is saved to Thetis as you edit. Ask the agent to publish it (map_publish) to write it to the MOO.";
  }

  function reloadFromPage() {
    return new Promise(function (resolve) {
      pendingReload = resolve;
      post({ type: "reload" });
      setTimeout(function () { if (pendingReload === resolve) { pendingReload = null; resolve(null); } }, 15000);
    });
  }
  var pendingReload = null;

  function start(msg) {
    var root = document.getElementById("root");
    mapper = createMapper(root, {
      map: msg.doc,
      reload: reloadFromPage,
      save: function (doc) { saving = "saving…"; post({ type: "save", doc: doc, seq: seq }); },
      status: function (waiting) {
        if (waiting) return "editing…";
        return saving;
      },
      onView: function (v) {
        post({ type: "view", sel: v.sel, area: v.area, floor: v.floor });
        var id = v.sel && v.sel.kind === "room" ? linked[v.sel.id] : v.sel && v.sel.kind === "exit" ? linked["exit:" + v.sel.id] : null;
        var side = document.getElementById("side");
        if (id && side && side.firstElementChild) {
          var note = document.createElement("div");
          note.className = "linked-id";
          note.textContent = "in the MOO as " + id;
          side.firstElementChild.appendChild(note);
        }
      },
    });
    bootNote.hidden = true;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.nonce !== nonce) return;
    if (msg.type === "load") {
      if (mapper) mapper.flush(); // an edit still waiting goes out first, so it is merged and not lost
      linked = msg.linked || {};
      seq = msg.seq || 0;
      showState(msg.state, msg.label);
      if (pendingReload) {
        var r = pendingReload; pendingReload = null; r(msg.doc); // the engine's own Reload adopts it
        return;
      }
      saving = msg.rev ? "saved · rev " + msg.rev : "";
      if (!mapper) start(msg);
      else { mapper.load(msg.doc, { undoable: false, message: msg.message }); mapper.status(); }
    } else if (msg.type === "state") {
      showState(msg.state, msg.label);
    } else if (msg.type === "saved") {
      saving = msg.ok ? "saved · rev " + msg.rev : "not saved: " + (msg.error || "error");
      if (!msg.ok && mapper) mapper.toast("The map was not saved: " + (msg.error || "error"), "err");
      if (msg.conflicts && msg.conflicts.length && mapper) mapper.toast(msg.conflicts[0], "err");
      if (mapper) mapper.status();
    } else if (msg.type === "flush") {
      if (mapper) mapper.flush();
      post({ type: "flushed" });
    } else if (msg.type === "select") {
      if (mapper && typeof msg.room === "string") mapper.selectRoom(msg.room);
    }
  });

  post({ type: "ready" });
})();

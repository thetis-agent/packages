/* eslint-disable */
/*
 * MUD Cartographer engine.
 *
 * The body of this module is the script from the standalone mud-mapper.html kept at the
 * repository root, moved here with only the changes needed to run inside the SPA: DOM
 * lookups are scoped to the component root, listeners outside that root are tracked so
 * they can be removed, persistence uses localStorage, and the initial map comes from the
 * game instead of a blank grid. Its dense formatting is preserved so that it can still be
 * diffed against the reference copy, hence the eslint exemption.
 *
 * With Live edit off, changes stay in a private browser draft. With Live edit on, each
 * mutation is sent through the NetSat write routes in docs/netsat-mapper-write-interface.md.
 */

const DRAFT_KEY = "torchship.mapper.draft";

export function createMapper(root, options = {}) {
/* =========================================================
   MUD Cartographer — grid-based MUD map planner
   ========================================================= */
const CELL = 104;          // grid cell size (world units)
const ROOM = 62;           // room square size
const EXIT_TYPES = {
  open:    {label:"Open",    color:"var(--t-open)",    hex:"#9aa8bd"},
  door:    {label:"Door",    color:"var(--t-door)",    hex:"#d98e3f"},
  locked:  {label:"Locked",  color:"var(--t-locked)",  hex:"#e26666"},
  climb:   {label:"Climb",   color:"var(--t-climb)",   hex:"#5fc08b"},
  swim:    {label:"Swim",    color:"var(--t-swim)",    hex:"#58b7e8"},
  special: {label:"Special", color:"var(--t-special)", hex:"#b48bf2"},
};
const ROOM_COLORS = ["#2a3140","#4a3038","#4a4028","#2c4436","#283a4a","#3c3050","#233"];
const EDGE_HEX = "#e685b5";   // edge (jump) exits
/* z grows downward: up = −1, down = +1 (Torchship / MOO convention). */
const PLANAR = ["n","ne","e","se","s","sw","w","nw"];
const DIRS = { n:[0,-1,0], ne:[1,-1,0], e:[1,0,0], se:[1,1,0], s:[0,1,0],
               sw:[-1,1,0], w:[-1,0,0], nw:[-1,-1,0], up:[0,0,-1], down:[0,0,1] };
const DIR_LABEL = {n:"N",ne:"NE",e:"E",se:"SE",s:"S",sw:"SW",w:"W",nw:"NW",up:"UP",down:"DN"};
const OPPOSITE = {n:"s",s:"n",e:"w",w:"e",ne:"sw",sw:"ne",nw:"se",se:"nw",up:"down",down:"up"};
/* The sixteen vertical diagonals: nu "northup" is one floor up and one north; its twin is sd "southdown". */
for(const p of PLANAR){ const [dx,dy]=DIRS[p];
  DIRS[p+"u"]=[dx,dy,-1]; DIRS[p+"d"]=[dx,dy,1];
  DIR_LABEL[p+"u"]=p.toUpperCase()+"↑"; DIR_LABEL[p+"d"]=p.toUpperCase()+"↓";
  OPPOSITE[p+"u"]=OPPOSITE[p]+"d"; OPPOSITE[p+"d"]=OPPOSITE[p]+"u"; }
const isVertical=d=>!!(DIRS[d]&&DIRS[d][2]);

/* ---------- state ---------- */
let state = null;                 // {name, nextId, rooms:{}, exits:{}}
let view  = {area:null, panX:0, panY:0, zoom:1, floor:0};
let sel   = null;                 // {kind:'room'|'exit', id}
let ghostBelow = true;
let coordIdx = new Map();         // "x,y,z" -> roomId
let undoStack = [], redoStack = [];
let saveTimer = null, storageOk = null;

/* Live edit is gone here: the map is a file Thetis keeps, and publishing to the MOO is a tool. These
   stubs keep the engine's call sites unchanged so it can still be diffed against the reference copy. */
const api = null;
const liveEdit = false, liveSyncing = 0, livePending = false;
const roomPatchTimers = Object.create(null);
let mapNameTimer = null;
function canon(id){ return id; }
function enqueueLive(){}
function scheduleRoomPatch(){}
function liveMoveRoom(){}
function setLiveEdit(){}
function syncLiveToggle(){}

/* Listeners attached outside `root` outlive the component's DOM, so they are tracked. */
const teardown = [];
function bind(target,type,fn,opts){
  target.addEventListener(type,fn,opts);
  teardown.push(()=>target.removeEventListener(type,fn,opts));
}

const $ = id => root.querySelector("#"+id);
const svg = $("board"), vp = $("viewport");
const layers = { ghost:$("ghostLayer"), block:$("blockLayer"), exit:$("exitLayer"), room:$("roomLayer"), over:$("overlayLayer") };
const SVGNS = "http://www.w3.org/2000/svg";
const el = (tag, attrs={}) => { const n=document.createElementNS(SVGNS,tag);
  for(const k in attrs) n.setAttribute(k,attrs[k]); return n; };

function blankState(){ return {name:"Untitled Map", nextId:1, areas:{}, rooms:{}, exits:{}, edges:{}, blocks:{}, elevators:{}}; }
function key(a,x,y,z){ return a+":"+x+","+y+","+z; }
function isBlocked(x,y,z,area){ return !!state.blocks[key(area,x,y,z)]; }
function rebuildIdx(){ coordIdx.clear();
  for(const id in state.rooms){ const r=state.rooms[id]; coordIdx.set(key(r.area,r.x,r.y,r.z), id); } }
function roomAt(x,y,z,area){ const id=coordIdx.get(key(area,x,y,z)); return id?state.rooms[id]:null; }
/* Prefer ground (0); otherwise the most positive z (down-most floor). */
function defaultFloor(area){
  const zs=Object.values(state.rooms).filter(r=>r.area===area).map(r=>r.z);
  if(!zs.length) return 0;
  if(zs.includes(0)) return 0;
  return Math.max(...zs);
}
function areaName(id){ return state.areas[id]?state.areas[id].name:"?"; }
function otherRoom(e,r){ return state.rooms[e.a===r.id?e.b:e.a]; }
function exitBetween(a,b){
  for(const id in state.exits){ const e=state.exits[id];
    if((e.a===a&&e.b===b)||(e.a===b&&e.b===a)) return e; } return null; }
function roomExits(rid){ const out=[];
  for(const id in state.exits){ const e=state.exits[id];
    if(e.a===rid||e.b===rid) out.push(e); } return out; }
function dirFromTo(ra,rb){
  const dx=Math.sign(rb.x-ra.x), dy=Math.sign(rb.y-ra.y), dz=Math.sign(rb.z-ra.z);
  for(const d in DIRS){ const v=DIRS[d]; if(v[0]===dx&&v[1]===dy&&v[2]===dz) return d; }
  return "?";
}
/* direction of exit e as seen from room r — works across areas (uses stored adir/bdir) */
function exitDirFrom(e,r){
  const o=otherRoom(e,r); if(!o) return null;
  if(o.area===r.area) return dirFromTo(r,o);
  return e.a===r.id ? (e.adir||"e") : (e.bdir||OPPOSITE[e.adir||"e"]);
}
function straightLine(ax,ay,bx,by){ const dx=bx-ax, dy=by-ay;
  return (dx||dy) && (dx===0 || dy===0 || Math.abs(dx)===Math.abs(dy)); }

/* ---------- undo / persistence ---------- */
function pushUndo(){
  if(liveEdit) return false;
  undoStack.push(JSON.stringify(state));
  if(undoStack.length>100) undoStack.shift(); redoStack.length=0; syncUndoBtns();
  return true;
}
function undo(){ if(liveEdit){ toast("Undo disabled while live","err"); return; }
  if(!undoStack.length) return;
  redoStack.push(JSON.stringify(state));
  state=JSON.parse(undoStack.pop()); sel=null; commit(false); toast("Undone"); }
function redo(){ if(liveEdit){ toast("Redo disabled while live","err"); return; }
  if(!redoStack.length) return;
  undoStack.push(JSON.stringify(state));
  state=JSON.parse(redoStack.pop()); sel=null; commit(false); toast("Redone"); }
function syncUndoBtns(){
  $("btnUndo").classList.toggle("ghosted", liveEdit || !undoStack.length);
  $("btnRedo").classList.toggle("ghosted", liveEdit || !redoStack.length); }

/* Saving goes to the host page: options.save(doc) after a short pause, which writes the map file. */
function trySave(){
  saveTimer=null;
  if(typeof options.save==="function"){ try{ options.save(JSON.parse(exportJSON())); storageOk=true; }catch(e){ storageOk=false; } }
  renderStatus();
}
function scheduleSave(){ clearTimeout(saveTimer); storageOk=null; saveTimer=setTimeout(trySave,450); renderStatus(); }
function flushSave(){ if(saveTimer){ clearTimeout(saveTimer); trySave(); } }
function tryLoad(){ return null; }
function clearDraft(){}

function commit(recordUndoAlreadyDone=true){ rebuildIdx(); render(); scheduleSave(); }

/* ---------- mutations ---------- */
function createArea(name){
  const id="a"+(state.nextId++);
  const localName=name||"Area";
  state.areas[id]={id,name:localName};
  enqueueLive(async()=>{
    if(!state.areas[id]) return;
    const remote=await api.createArea({ name: state.areas[id].name });
    if(state.areas[id]) remapArea(id, remote);
  });
  return state.areas[id];
}
function createRoom(x,y,z,name,area){
  const id="r"+(state.nextId++);
  const room={id,area,x,y,z,name:name??"", color:ROOM_COLORS[0], description:"", notes:""};
  state.rooms[id]=room;
  coordIdx.set(key(area,x,y,z),id);
  enqueueLive(async()=>{
    const r=state.rooms[id];
    if(!r) return;
    const remote=await api.createRoom({
      area:canon(r.area), x:r.x, y:r.y, z:r.z,
      name:r.name, color:r.color, description:r.description, notes:r.notes,
    });
    if(!state.rooms[id]){
      try{ await api.deleteRoom(remote.id); }catch(e){ /* ignore */ }
      return;
    }
    remapRoom(id, remote);
  });
  return room;
}
function deleteRoom(rid, opts={}){
  const doomed=rid;
  roomExits(rid).forEach(e=>delete state.exits[e.id]);
  for(const id in state.edges){ const g=state.edges[id];
    if(g.from===rid||g.success===rid||g.fail===rid) delete state.edges[id]; }
  for(const id in state.elevators){ const v=state.elevators[id]; v.stops=v.stops.filter(st=>st.room!==rid); }
  delete state.rooms[rid];
  if(!opts.silent) enqueueLive(async()=>{ await api.deleteRoom(canon(doomed)); });
}
function edgesFrom(rid){
  return Object.values(state.edges).filter(g=>g.from===rid);
}
function createEdge(from,dir,success,fail){
  const id="j"+(state.nextId++);
  const edge={id,from,dir,success,fail,hidden:false};
  state.edges[id]=edge;
  enqueueLive(async()=>{
    const g=state.edges[id];
    if(!g) return;
    const remote=await api.createEdge({
      from:canon(g.from), dir:g.dir, success:canon(g.success), fail:canon(g.fail), hidden:!!g.hidden,
    });
    if(state.edges[id]) remapEdge(id, remote);
  });
  return edge;
}
/* relocate a room one floor up/down, keeping every exit and edge intact */
function shiftRoomFloor(r,dz){
  const occ=roomAt(r.x,r.y,r.z+dz,r.area);
  if(occ){ toast(`Floor ${r.z+dz} already has a room at ${r.x}, ${r.y}`,"err"); return; }
  if(isBlocked(r.x,r.y,r.z+dz,r.area)){ toast(`Floor ${r.z+dz} is blocked out at ${r.x}, ${r.y}`,"err"); return; }
  pushUndo();
  coordIdx.delete(key(r.area,r.x,r.y,r.z));
  r.z+=dz;
  view.floor=r.z;                 // follow the room
  sel={kind:"room",id:r.id};
  commit(); ensureVisible(r);
  liveMoveRoom(r);
  toast(`Shifted to floor ${r.z} — exits kept`);
}
function createExit(a,b,opts={}){
  const id="e"+(state.nextId++);
  const e={id,a,b,type:opts.type||"open",hidden:!!opts.hidden,dir:opts.dir||"both"};
  if(opts.adir){ e.adir=opts.adir; e.bdir=opts.bdir||OPPOSITE[opts.adir]; }
  state.exits[id]=e;
  enqueueLive(async()=>{
    const ex=state.exits[id];
    if(!ex) return;
    const body={ a:canon(ex.a), b:canon(ex.b), type:ex.type, hidden:!!ex.hidden, dir:ex.dir };
    if(ex.adir) body.adir=ex.adir;
    if(ex.bdir) body.bdir=ex.bdir;
    const remote=await api.createExit(body);
    if(state.exits[id]) remapExit(id, remote);
  });
  return e;
}

/* "dig": ensure a room+exit exist in direction d from room; returns target room */
function dig(fromRoom,d){
  const v=DIRS[d];
  const tx=fromRoom.x+v[0], ty=fromRoom.y+v[1], tz=fromRoom.z+v[2];
  if(isBlocked(tx,ty,tz,fromRoom.area)){
    toast("That space is blocked out","err"); return null; }
  let target=roomAt(tx,ty,tz,fromRoom.area), made=false;
  const snapped=pushUndo();
  if(!target){ target=createRoom(tx,ty,tz,"",fromRoom.area); made=true; }
  if(!exitBetween(fromRoom.id,target.id)){ createExit(fromRoom.id,target.id); made=true; }
  if(!made){ if(snapped){ undoStack.pop(); syncUndoBtns(); } }   // nothing changed; drop snapshot
  else scheduleSave();
  return target;
}

/* ---------- coordinate transforms ---------- */
function worldOf(r){ return {x:r.x*CELL, y:r.y*CELL}; }
function screenToWorld(sx,sy){ const rect=svg.getBoundingClientRect();
  return {x:(sx-rect.left-view.panX)/view.zoom, y:(sy-rect.top-view.panY)/view.zoom}; }
function worldToCell(wx,wy){ return {x:Math.round(wx/CELL), y:Math.round(wy/CELL)}; }
function applyView(){
  vp.setAttribute("transform",`translate(${view.panX},${view.panY}) scale(${view.zoom})`);
  const s=CELL*view.zoom;
  svg.style.background =
    `radial-gradient(circle, #3a4456 1.2px, transparent 1.4px) ` +
    `${view.panX - s/2}px ${view.panY - s/2}px / ${s}px ${s}px`;
}
function ensureVisible(r){
  const rect=svg.getBoundingClientRect(), w=worldOf(r);
  const sx=w.x*view.zoom+view.panX, sy=w.y*view.zoom+view.panY, M=90;
  if(sx<M) view.panX+=M-sx; if(sx>rect.width-M) view.panX-=sx-(rect.width-M);
  if(sy<M) view.panY+=M-sy; if(sy>rect.height-M) view.panY-=sy-(rect.height-M);
  applyView();
}
function fitView(){
  const rs=Object.values(state.rooms).filter(r=>r.area===view.area&&r.z===view.floor);
  const rect=svg.getBoundingClientRect();
  if(!rs.length){ view.panX=rect.width/2; view.panY=rect.height/2; view.zoom=1; applyView(); return; }
  let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  rs.forEach(r=>{ const w=worldOf(r);
    minX=Math.min(minX,w.x); maxX=Math.max(maxX,w.x);
    minY=Math.min(minY,w.y); maxY=Math.max(maxY,w.y); });
  minX-=CELL; maxX+=CELL; minY-=CELL; maxY+=CELL;
  view.zoom=Math.min(2, Math.max(0.3, Math.min(rect.width/(maxX-minX), rect.height/(maxY-minY))));
  view.panX=rect.width/2-(minX+maxX)/2*view.zoom;
  view.panY=rect.height/2-(minY+maxY)/2*view.zoom;
  applyView();
}

/* ---------- rendering ---------- */
function render(){
  if(!state.areas[view.area]){
    if(!Object.keys(state.areas).length) createArea("Main");
    view.area=Object.keys(state.areas)[0];
  }
  layers.ghost.innerHTML=""; layers.block.innerHTML=""; layers.exit.innerHTML="";
  layers.room.innerHTML=""; layers.over.innerHTML="";
  const F=view.floor, A=view.area;

  if(ghostBelow){
    for(const id in state.rooms){ const r=state.rooms[id];
      if(r.area!==A||r.z!==F+1) continue; const w=worldOf(r);
      layers.ghost.appendChild(el("rect",{x:w.x-ROOM/2,y:w.y-ROOM/2,width:ROOM,height:ROOM,
        rx:8,fill:"none",stroke:"#3a4456",["stroke-dasharray"]:"3 4",["stroke-width"]:1}));
    }
    for(const k in state.blocks){ const b=parseBlockKey(k);
      if(!b||b.area!==A||b.z!==F+1) continue;
      layers.ghost.appendChild(el("rect",{x:b.x*CELL-CELL/2,y:b.y*CELL-CELL/2,
        width:CELL,height:CELL,fill:"none",stroke:"#2a3342",
        ["stroke-dasharray"]:"3 5",["stroke-width"]:1}));
    }
  }
  renderBlocks();

  // exits: same-area lines on this floor; cross-area exits render as portal stubs
  for(const id in state.exits){
    const e=state.exits[id], ra=state.rooms[e.a], rb=state.rooms[e.b];
    if(!ra||!rb) continue;
    if(ra.area===rb.area){
      if(ra.area!==A||ra.z!==F||rb.z!==F) continue;   // vertical exits render as glyphs on rooms
      drawExit(e,ra,rb);
    }else{
      if(ra.area===A&&ra.z===F) drawAreaStub(e,ra);
      if(rb.area===A&&rb.z===F) drawAreaStub(e,rb);
    }
  }
  // edges (jump exits) originating from rooms on this floor of this area
  for(const id in state.edges){
    const g=state.edges[id], f=state.rooms[g.from];
    if(f&&f.area===A&&f.z===F) drawEdge(g,f);
  }
  // rooms on this floor of this area
  for(const id in state.rooms){ const r=state.rooms[id];
    if(r.area===A&&r.z===F) drawRoom(r); }

  if(sel&&sel.kind==="room"){ const r=state.rooms[sel.id];
    if(r&&r.area===A&&r.z===F) drawPorts(r); }

  renderSide(); renderFloorGauge(); renderStatus(); renderAreaSel();
  root.classList.toggle("hasSel", !!sel);
  if(typeof options.onView==="function") options.onView({sel:sel?{...sel}:null, area:view.area, floor:view.floor});
  $("onboard").style.display = Object.keys(state.rooms).length<=1 ? "" : "none";
  $("mapName").value = state.name;
}

function exitColor(e){ return (EXIT_TYPES[e.type]||EXIT_TYPES.open).color; }

/* ---------- blocks (impassable cells) ---------- */
function parseBlockKey(k){
  const i=k.indexOf(":"); if(i<0) return null;
  const area=k.slice(0,i), p=k.slice(i+1).split(",");
  if(p.length!==3) return null;
  const [x,y,z]=p.map(Number);
  if(![x,y,z].every(Number.isFinite)) return null;
  return {area,x,y,z};
}
function renderBlocks(){
  layers.block.innerHTML="";
  for(const k in state.blocks){
    const b=parseBlockKey(k);
    if(!b||b.area!==view.area||b.z!==view.floor) continue;
    const bx=b.x*CELL-CELL/2, by=b.y*CELL-CELL/2;
    layers.block.appendChild(el("rect",{x:bx,y:by,width:CELL,height:CELL,
      fill:"#171c24"}));
    layers.block.appendChild(el("rect",{x:bx,y:by,width:CELL,height:CELL,
      fill:"url(#hatch)",stroke:"#2b3444",["stroke-width"]:1}));
  }
}
/* returns true if the cell changed */
function paintCell(cell,erase){
  const k=key(view.area,cell.x,cell.y,view.floor);
  if(erase){
    if(!state.blocks[k]) return false;
    delete state.blocks[k];
    enqueueLive(async()=>{
      await api.removeBlock({ area:canon(view.area), x:cell.x, y:cell.y, z:view.floor });
    });
    return true;
  }
  if(state.blocks[k]) return false;
  if(roomAt(cell.x,cell.y,view.floor,view.area)) return false;   // rooms can't be blocked
  state.blocks[k]=1;
  enqueueLive(async()=>{
    await api.addBlock({ area:canon(view.area), x:cell.x, y:cell.y, z:view.floor });
  });
  return true;
}
let blockMode=false;
function setBlockMode(on){
  blockMode=on;
  $("btnBlock").classList.toggle("primary",on);
  svg.style.cursor=on?"crosshair":"";
  layers.over.querySelectorAll(".tmp").forEach(n=>n.remove());
  if(on){ sel=null; render();
    toast("Block mode — drag to paint solid cells, drag from a block to erase. B or Esc to exit"); }
  else renderStatus();
}

function drawExit(e,ra,rb){
  const A=worldOf(ra), B=worldOf(rb);
  const dx=B.x-A.x, dy=B.y-A.y, len=Math.hypot(dx,dy)||1;
  const ux=dx/len, uy=dy/len;
  const t=(ROOM/2+4)/Math.max(Math.abs(ux),Math.abs(uy));  // exit through rect boundary
  const ax=A.x+ux*t, ay=A.y+uy*t, bx=B.x-ux*t, by=B.y-uy*t;
  const col=exitColor(e), seld = sel&&sel.kind==="exit"&&sel.id===e.id;
  const g=el("g");

  const vis=el("line",{x1:ax,y1:ay,x2:bx,y2:by,stroke:col,["stroke-width"]:seld?4:2.5,
    ["stroke-linecap"]:"round"});
  vis.classList.add("exitVis");
  if(e.hidden) vis.setAttribute("stroke-dasharray","5 6");
  if(seld) vis.setAttribute("filter","url(#glow)");

  // arrowheads: one-way exits get an arrow at the destination end
  const heads=[];
  if(e.dir==="ab") heads.push([bx,by,ux,uy]);
  if(e.dir==="ba") heads.push([ax,ay,-ux,-uy]);
  const hit=el("line",{x1:ax,y1:ay,x2:bx,y2:by}); hit.classList.add("exitHit");
  hit.addEventListener("pointerdown",ev=>{ev.stopPropagation();});
  hit.addEventListener("click",ev=>{ev.stopPropagation(); select({kind:"exit",id:e.id});});
  g.appendChild(hit); g.appendChild(vis);

  heads.forEach(([hx,hy,hux,huy])=>{
    const px=-huy, py=hux, L=10, W=4.5;
    g.appendChild(el("path",{fill:col,
      d:`M ${hx} ${hy} L ${hx-hux*L+px*W} ${hy-huy*L+py*W} L ${hx-hux*L-px*W} ${hy-huy*L-py*W} Z`}));
  });
  // classic MUD notation: doors get a crossbar at the midpoint
  if(e.type==="door"||e.type==="locked"){
    const mx=(ax+bx)/2, my=(ay+by)/2, px=-uy, py=ux, s=6;
    g.appendChild(el("line",{x1:mx-px*s,y1:my-py*s,x2:mx+px*s,y2:my+py*s,
      stroke:col,["stroke-width"]:3,["stroke-linecap"]:"round"}));
    if(e.type==="locked")
      g.appendChild(el("line",{x1:mx-px*s+ux*4,y1:my-py*s+uy*4,x2:mx+px*s+ux*4,y2:my+py*s+uy*4,
        stroke:col,["stroke-width"]:3,["stroke-linecap"]:"round"}));
  }
  layers.exit.appendChild(g);
}

/* cross-area exit: a stub line leaving the room, ending in a dashed portal tag
   labelled with the destination area. Click = select, double-click = travel. */
function drawAreaStub(e,r){
  const d=exitDirFrom(e,r);
  if(!d||d==="up"||d==="down") return;          // straight up/down cross-area → room glyph only
  const o=otherRoom(e,r); if(!o) return;
  const v=DIRS[d], len=Math.hypot(v[0],v[1])||1;
  const ux=v[0]/len, uy=v[1]/len;
  const w=worldOf(r);
  const t=(ROOM/2+4)/Math.max(Math.abs(ux),Math.abs(uy));
  const sx=w.x+ux*t, sy=w.y+uy*t;
  const ex=sx+ux*26, ey=sy+uy*26;
  const col=(EXIT_TYPES[e.type]||EXIT_TYPES.open).hex;
  const seld = sel&&sel.kind==="exit"&&sel.id===e.id;
  const g=el("g"); g.style.cursor="pointer";

  const ln=el("line",{x1:sx,y1:sy,x2:ex,y2:ey,stroke:col,
    ["stroke-width"]:seld?4:2.5,["stroke-linecap"]:"round"});
  if(e.hidden) ln.setAttribute("stroke-dasharray","5 6");
  g.appendChild(ln);

  // one-way arrow: out of the room, or into it
  if(e.dir!=="both"){
    const out=(e.dir==="ab")===(e.a===r.id);
    const hx=out?ex:sx, hy=out?ey:sy, hux=out?ux:-ux, huy=out?uy:-uy;
    const px=-huy, py=hux, L=9, W=4;
    g.appendChild(el("path",{fill:col,
      d:`M ${hx} ${hy} L ${hx-hux*L+px*W} ${hy-huy*L+py*W} L ${hx-hux*L-px*W} ${hy-huy*L-py*W} Z`}));
  }
  // portal tag with destination area name
  const label=(areaName(o.area)||"?").slice(0,9);
  const tw=label.length*6.4+12, th=16;
  const cx=ex+ux*(tw/2+7), cy=ey+uy*(th/2+7);
  const tag=el("rect",{x:cx-tw/2,y:cy-th/2,width:tw,height:th,rx:8,
    fill:"var(--panel)",stroke:col,["stroke-width"]:seld?2:1.3,["stroke-dasharray"]:"3 3"});
  if(seld) tag.setAttribute("filter","url(#glow)");
  const txt=el("text",{x:cx,y:cy+3,["text-anchor"]:"middle",fill:col,["font-size"]:"9.5","font-weight":"700"});
  txt.textContent=label;
  const title=el("title");
  title.textContent=`${areaName(o.area)} · ${o.name||"(unnamed)"} — double-click to travel`;
  g.appendChild(title); g.appendChild(tag); g.appendChild(txt);

  g.addEventListener("pointerdown",ev=>ev.stopPropagation());
  g.addEventListener("click",ev=>{ ev.stopPropagation(); select({kind:"exit",id:e.id}); });
  g.addEventListener("dblclick",ev=>{ ev.stopPropagation(); jumpToRoom(o); });
  layers.exit.appendChild(g);
}

/* edge (jump) exit: a bowed arc in the edge colour, arrow at the success end,
   ↓ marker at the midpoint for the failure landing. Bows sideways so it stays
   readable when it overlaps a straight cardinal exit in the same direction. */
function drawEdge(gEdge,f){
  const s=state.rooms[gEdge.success], fl=state.rooms[gEdge.fail];
  const w=worldOf(f);
  const seld = sel&&sel.kind==="edge"&&sel.id===gEdge.id;
  const visS = s && s.area===f.area && s.z===f.z && s.id!==f.id;
  let sx,sy,ex,ey,ux,uy;
  if(visS){
    const B=worldOf(s);
    const dx=B.x-w.x, dy=B.y-w.y, len=Math.hypot(dx,dy)||1;
    ux=dx/len; uy=dy/len;
    const t=(ROOM/2+4)/Math.max(Math.abs(ux),Math.abs(uy));
    sx=w.x+ux*t; sy=w.y+uy*t; ex=B.x-ux*t; ey=B.y-uy*t;
  }else{
    const v=DIRS[gEdge.dir]||DIRS.n, len=Math.hypot(v[0],v[1])||1;
    ux=v[0]/len; uy=v[1]/len;
    const t=(ROOM/2+4)/Math.max(Math.abs(ux),Math.abs(uy));
    sx=w.x+ux*t; sy=w.y+uy*t; ex=sx+ux*34; ey=sy+uy*34;
  }
  const px=-uy, py=ux, bow=18;
  const cx=(sx+ex)/2+px*bow, cy=(sy+ey)/2+py*bow;
  const g=el("g"); g.style.cursor="pointer";

  const title=el("title");
  title.textContent=`Edge ${DIR_LABEL[gEdge.dir]||"?"} — success: ${s?.name||"?"}`+
    (s&&s.area!==f.area?` (${areaName(s.area)})`:s&&s.z!==f.z?` (fl ${s.z})`:"")+
    ` · failure: ${fl?.name||"?"} — double-click arc to travel`;
  g.appendChild(title);

  const dPath=`M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
  const hit=el("path",{d:dPath,fill:"none",stroke:"transparent",["stroke-width"]:16});
  const vis=el("path",{d:dPath,fill:"none",stroke:EDGE_HEX,
    ["stroke-width"]:seld?4:2.5,["stroke-linecap"]:"round"});
  if(gEdge.hidden) vis.setAttribute("stroke-dasharray","5 6");
  if(seld) vis.setAttribute("filter","url(#glow)");
  g.appendChild(hit); g.appendChild(vis);

  // arrowhead at the success end (tangent of the quadratic at t=1)
  let hux=ex-cx, huy=ey-cy; const hl=Math.hypot(hux,huy)||1; hux/=hl; huy/=hl;
  const ppx=-huy, ppy=hux, L=10, W=4.5;
  g.appendChild(el("path",{fill:EDGE_HEX,
    d:`M ${ex} ${ey} L ${ex-hux*L+ppx*W} ${ey-huy*L+ppy*W} L ${ex-hux*L-ppx*W} ${ey-huy*L-ppy*W} Z`}));

  // remote destination tag (other floor or other area)
  if(!visS){
    const label=s ? (s.area!==f.area ? (areaName(s.area)||"?").slice(0,9) : "fl "+s.z) : "?";
    const tw=label.length*6.4+12, th=16;
    const tcx=ex+ux*(tw/2+7), tcy=ey+uy*(th/2+7);
    g.appendChild(el("rect",{x:tcx-tw/2,y:tcy-th/2,width:tw,height:th,rx:8,
      fill:"var(--panel)",stroke:EDGE_HEX,["stroke-width"]:seld?2:1.3,["stroke-dasharray"]:"3 3"}));
    const txt=el("text",{x:tcx,y:tcy+3,["text-anchor"]:"middle",fill:EDGE_HEX,
      ["font-size"]:"9.5","font-weight":"700"});
    txt.textContent=label; g.appendChild(txt);
  }

  // failure landing marker at the arc midpoint
  const mx=(sx+2*cx+ex)/4, my=(sy+2*cy+ey)/4;
  const fm=el("g"); fm.style.cursor="pointer";
  fm.appendChild(el("circle",{cx:mx,cy:my,r:7,fill:"var(--panel)",
    stroke:EDGE_HEX,["stroke-width"]:1.4}));
  const ft=el("text",{x:mx,y:my+3.5,["text-anchor"]:"middle",fill:EDGE_HEX,
    ["font-size"]:"10","font-weight":"700"});
  ft.textContent="↓"; fm.appendChild(ft);
  const ftitle=el("title");
  ftitle.textContent=`Failure landing: ${fl?.name||"?"}`+
    (fl&&fl.area!==f.area?` (${areaName(fl.area)})`:fl&&fl.z!==f.z?` (fl ${fl.z})`:"")+
    ` — double-click to go there`;
  fm.appendChild(ftitle);
  fm.addEventListener("dblclick",ev=>{ ev.stopPropagation(); jumpToRoom(fl); });

  g.addEventListener("pointerdown",ev=>ev.stopPropagation());
  g.addEventListener("click",ev=>{ ev.stopPropagation(); select({kind:"edge",id:gEdge.id}); });
  g.addEventListener("dblclick",ev=>{ ev.stopPropagation(); jumpToRoom(s); });
  g.appendChild(fm);
  layers.exit.appendChild(g);
}

function splitName(name){
  if(!name) return ["",""];
  const MAX=10;
  if(name.length<=MAX) return [name,""];
  let brk=name.lastIndexOf(" ",MAX);
  if(brk<3) brk=MAX;
  let l1=name.slice(0,brk).trim(), l2=name.slice(brk).trim();
  if(l1.length>MAX) l1=l1.slice(0,MAX-1)+"…";
  if(l2.length>MAX) l2=l2.slice(0,MAX-1)+"…";
  return [l1,l2];
}

function drawRoom(r){
  const w=worldOf(r), seld = sel&&sel.kind==="room"&&sel.id===r.id;
  const g=el("g"); g.classList.add("roomG"); g.dataset.rid=r.id;
  const rect=el("rect",{x:w.x-ROOM/2,y:w.y-ROOM/2,width:ROOM,height:ROOM,rx:8,
    fill:r.color||ROOM_COLORS[0],
    stroke:seld?"var(--accent)":"#46526688",["stroke-width"]:seld?2.5:1.2});
  if(seld) rect.setAttribute("filter","url(#glow)");
  g.appendChild(rect);

  const [l1,l2]=splitName(r.name||"");
  const txt=el("text",{x:w.x,y:w.y+(l2?0:4),["text-anchor"]:"middle",
    fill:"var(--ink)",["font-size"]:"11","font-weight":"600"});
  const t1=el("tspan",{x:w.x}); t1.textContent=l1||"·";
  if(!l1) t1.setAttribute("fill","var(--faint)");
  txt.appendChild(t1);
  if(l2){ const t2=el("tspan",{x:w.x,dy:12}); t2.textContent=l2; txt.appendChild(t2); }
  g.appendChild(txt);

  // vertical exit glyphs (same-area floor changes, and cross-area up/down portals)
  const ups=roomExits(r.id).filter(e=>{
    const o=otherRoom(e,r); if(!o) return false;
    if(o.area===r.area) return o.z!==r.z;
    return isVertical(exitDirFrom(e,r));
  });
  let gy=w.y-ROOM/2+11;
  ups.forEach(e=>{
    const o=otherRoom(e,r);
    const cross=o.area!==r.area;
    const up=cross ? DIRS[exitDirFrom(e,r)][2]<0 : o.z<r.z;
    const gx=w.x+ROOM/2-9;
    const wrap=el("g"); wrap.style.cursor="pointer"; wrap.style.pointerEvents="all";
    if(cross){
      wrap.appendChild(el("circle",{cx:gx,cy:gy,r:7.5,fill:"none",
        stroke:exitColor(e),["stroke-width"]:1.2,["stroke-dasharray"]:"2.5 2.5"}));
      const title=el("title");
      title.textContent=`${DIR_LABEL[exitDirFrom(e,r)]||(up?"Up":"Down")} to ${areaName(o.area)} · ${o.name||"(unnamed)"} — double-click to travel`;
      wrap.appendChild(title);
    }
    const tri=el("path",{d:up?`M ${gx} ${gy-4} L ${gx-4.5} ${gy+3} L ${gx+4.5} ${gy+3} Z`
                            :`M ${gx} ${gy+3} L ${gx-4.5} ${gy-4} L ${gx+4.5} ${gy-4} Z`,
      fill:e.hidden?"none":exitColor(e), stroke:exitColor(e),["stroke-width"]:1.4});
    wrap.appendChild(tri);
    if(!cross){ const t=el("title"); t.textContent=`${DIR_LABEL[exitDirFrom(e,r)]||"?"} to floor ${o.z} · ${o.name||"(unnamed)"}`; wrap.appendChild(t); }
    wrap.addEventListener("pointerdown",ev=>ev.stopPropagation());
    wrap.addEventListener("click",ev=>{ev.stopPropagation(); select({kind:"exit",id:e.id});});
    if(cross) wrap.addEventListener("dblclick",ev=>{ev.stopPropagation(); jumpToRoom(o);});
    g.appendChild(wrap); gy+=cross?17:12;
    // A vertical diagonal (nu, swd …) also points along its bearing: a short dashed spoke to the room's edge.
    const d=exitDirFrom(e,r), v=DIRS[d];
    if(v&&v[2]&&(v[0]||v[1])&&!cross){
      const len=Math.hypot(v[0],v[1]), ux=v[0]/len, uy=v[1]/len;
      const t0=(ROOM/2+3)/Math.max(Math.abs(ux),Math.abs(uy));
      const sx=w.x+ux*t0, sy=w.y+uy*t0, ex=sx+ux*16, ey=sy+uy*16;
      const sp=el("g"); sp.style.cursor="pointer"; sp.style.pointerEvents="all";
      sp.appendChild(el("line",{x1:sx,y1:sy,x2:ex,y2:ey,stroke:"transparent",["stroke-width"]:10}));
      sp.appendChild(el("line",{x1:sx,y1:sy,x2:ex,y2:ey,stroke:exitColor(e),["stroke-width"]:2.5,
        ["stroke-linecap"]:"round",["stroke-dasharray"]:"3 3"}));
      const px=-uy, py=ux, hx=ex+ux*5, hy=ey+uy*5;
      sp.appendChild(el("path",{d:`M ${hx} ${hy} L ${ex+px*4} ${ey+py*4} L ${ex-px*4} ${ey-py*4} Z`,fill:exitColor(e)}));
      const tt=el("title"); tt.textContent=`${DIR_LABEL[d]} to floor ${o.z} · ${o.name||"(unnamed)"}`; sp.appendChild(tt);
      sp.addEventListener("pointerdown",ev=>ev.stopPropagation());
      sp.addEventListener("click",ev=>{ev.stopPropagation(); select({kind:"exit",id:e.id});});
      sp.addEventListener("dblclick",ev=>{ev.stopPropagation(); view.floor=o.z; select({kind:"room",id:o.id}); ensureVisible(o);});
      layers.exit.appendChild(sp);
    }
  });

  // Elevator lobbies: a badge with the stop's label in the bottom-left corner; click selects the elevator.
  const lifts=elevatorsAt(r.id);
  lifts.forEach(({v,st},i)=>{
    const bx=w.x-ROOM/2+3+i*4, by=w.y+ROOM/2-15-i*4;
    const label=st.label.length>3?st.label.slice(0,3):st.label;
    const bw=14+label.length*6;
    const seldV=sel&&sel.kind==="elevator"&&sel.id===v.id;
    const b=el("g"); b.style.cursor="pointer"; b.style.pointerEvents="all"; b.classList.add("liftBadge");
    b.appendChild(el("rect",{x:bx,y:by,width:bw,height:12,rx:3,fill:"#132a2e",stroke:seldV?"var(--accent)":LIFT_HEX,["stroke-width"]:seldV?2:1.2}));
    const t=el("text",{x:bx+bw/2,y:by+9,["text-anchor"]:"middle",fill:LIFT_HEX,["font-size"]:"8.5","font-weight":"700"});
    t.textContent="⇕"+label; b.appendChild(t);
    const tt=el("title"); tt.textContent=`${v.name}: stop ${st.label} (${v.stops.length} stop${v.stops.length===1?"":"s"}) — click to edit the elevator`; b.appendChild(tt);
    b.addEventListener("pointerdown",ev=>ev.stopPropagation());
    b.addEventListener("click",ev=>{ev.stopPropagation(); select({kind:"elevator",id:v.id});});
    g.appendChild(b);
  });

  g.addEventListener("pointerdown",ev=>startRoomDrag(ev,r.id));
  g.addEventListener("dblclick",ev=>{ ev.stopPropagation();
    select({kind:"room",id:r.id}); focusName(); });
  layers.room.appendChild(g);
}

function drawPorts(r){
  const w=worldOf(r);
  for(const d of PLANAR){
    const v=DIRS[d];
    const px=w.x+v[0]*(ROOM/2+2), py=w.y+v[1]*(ROOM/2+2);
    const hit=el("circle",{cx:px,cy:py,r:14,fill:"transparent"});
    hit.style.cursor="crosshair"; hit.style.pointerEvents="all";
    hit.addEventListener("pointerdown",ev=>startLinkDrag(ev,r.id));
    const c=el("circle",{cx:px,cy:py,r:5,["pointer-events"]:"none"}); c.classList.add("port");
    layers.over.appendChild(hit); layers.over.appendChild(c);
  }
}

/* ---------- floor gauge / status ---------- */
function renderFloorGauge(){
  $("floorNum").textContent=view.floor;
  const zs=[...new Set(Object.values(state.rooms).filter(r=>r.area===view.area).map(r=>r.z))].sort((a,b)=>a-b);
  const rail=$("floorRail"); rail.innerHTML="";
  zs.forEach(z=>{ const b=document.createElement("button");
    b.textContent=z; if(z===view.floor) b.classList.add("on");
    b.title="Jump to floor "+z;
    b.onclick=()=>{ view.floor=z; sel=null; render(); };
    rail.appendChild(b); });
}
function renderAreaSel(){
  const s=$("areaSel"); s.innerHTML="";
  for(const id in state.areas){ const o=document.createElement("option");
    o.value=id; o.textContent=areaName(id);
    if(id===view.area) o.selected=true; s.appendChild(o); }
  const nu=document.createElement("option");
  nu.value="__new"; nu.textContent="＋ New area…"; s.appendChild(nu);
}
let hoverCell=null;
function renderStatus(){
  const rooms=Object.values(state.rooms);
  const nA=rooms.filter(r=>r.area===view.area).length, nT=rooms.length;
  const save = typeof options.status==="function" ? options.status(saveTimer!==null) : "";
  $("statusBar").innerHTML =
    (liveEdit?`<span style="color:var(--accent)">● live</span>`:"")+
    (blockMode?`<span style="color:var(--accent)">▦ block mode</span>`:"")+
    (hoverCell?`cell <b>${hoverCell.x}, ${hoverCell.y}</b>`:"")+
    `<span>${escapeHTML(short(areaName(view.area)))} · fl <b>${view.floor}</b></span>`+
    `<span><b>${nA}</b>${nT!==nA?" / "+nT:""} room${nT===1?"":"s"}</span>`+
    (save?`<span>${escapeHTML(save)}</span>`:"");
}

/* ---------- area navigation ---------- */
let viewMem={};   // per-area remembered floor/pan/zoom
function switchArea(aid){                 // returns true if a remembered view existed
  if(aid===view.area) return true;
  viewMem[view.area]={floor:view.floor,panX:view.panX,panY:view.panY,zoom:view.zoom};
  view.area=aid;
  const m=viewMem[aid];
  if(m){ view.floor=m.floor; view.panX=m.panX; view.panY=m.panY; view.zoom=m.zoom;
         applyView(); return true; }
  view.floor=0; return false;
}
function jumpToRoom(o){
  if(!o) return;
  const had = o.area===view.area ? true : switchArea(o.area);
  view.floor=o.z;
  sel={kind:"room",id:o.id};
  render();
  if(!had) fitView();
  ensureVisible(o);
}

/* ---------- selection & sidebar ---------- */
function select(s){ sel=s; render(); }
function focusName(){ const i=$("roomNameInput"); if(i){ i.focus(); i.select(); } }

function renderSide(){
  const side=$("side"); side.innerHTML="";
  if(sel&&sel.kind==="room"&&state.rooms[sel.id]){ renderRoomPanel(side,state.rooms[sel.id]); return; }
  if(sel&&sel.kind==="exit"&&state.exits[sel.id]){ renderExitPanel(side,state.exits[sel.id]); return; }
  if(sel&&sel.kind==="edge"&&state.edges[sel.id]){ renderEdgePanel(side,state.edges[sel.id]); return; }
  if(sel&&sel.kind==="elevator"&&state.elevators[sel.id]){ renderElevatorPanel(side,state.elevators[sel.id]); return; }
  side.innerHTML=`
   <div class="section"><h3>Quick reference</h3>
    <div class="cheat">
      <span><span class="kbd">dbl-click</span></span><span>empty cell → new room · room → rename</span>
      <span><span class="kbd">↑↓←→</span> <span class="kbd">numpad</span></span><span>dig / walk from selected room</span>
      <span><span class="kbd">shift</span>+move</span><span>move selection only</span>
      <span><span class="kbd">U</span> <span class="kbd">D</span></span><span>dig up / down a floor</span>
      <span><span class="kbd">shift</span>+<span class="kbd">U</span>/<span class="kbd">D</span></span><span>shift room a floor up/down (exits kept)</span>
      <span><span class="kbd">J</span></span><span>add a jumpable edge from the room</span>
      <span><span class="kbd">A</span> / <span class="kbd">L</span></span><span>dig a new area / link to another area</span>
      <span><span class="kbd">B</span></span><span>block-out mode: paint impassable cells</span>
      <span><span class="kbd">enter</span></span><span>rename selected room</span>
      <span><span class="kbd">del</span></span><span>delete selection</span>
      <span><span class="kbd">drag</span></span><span>room → move it · dot → draw an exit</span>
      <span><span class="kbd">esc</span></span><span>deselect</span>
    </div></div>
   <div class="section"><h3>Exit legend</h3><div class="legend">${legendHTML()}</div></div>
   <div class="section"><span class="hint">Select a room or an exit to edit it here. Exit lines are easiest to click near their middle.</span></div>`;
  side.appendChild(elevatorListSection());
}
function legendHTML(){
  let h="";
  for(const t in EXIT_TYPES){
    const extra=t==="door"||t==="locked"?" (crossbar on line)":"";
    h+=`<span class="legLine" style="border-color:${EXIT_TYPES[t].hex}"></span><span>${EXIT_TYPES[t].label}${extra}</span>`;
  }
  h+=`<span class="legLine dot" style="border-color:var(--muted)"></span><span>Hidden (any type)</span>`;
  h+=`<span style="color:var(--muted);border:1px dashed var(--muted);border-radius:8px;font-size:9px;padding:1px 3px;text-align:center;justify-self:start">area</span><span>Portal to another area — dbl-click to travel</span>`;
  h+=`<svg width="34" height="13" style="overflow:visible"><path d="M2 11 Q17 -2 32 11" fill="none" stroke="${EDGE_HEX}" stroke-width="2.5" stroke-linecap="round"/></svg><span>Edge (jump) — arrow = success, ↓ dot = failure landing</span>`;
  h+=`<svg width="34" height="14"><rect x="1" y="1" width="32" height="12" fill="#171c24" stroke="#2b3444"/><line x1="4" y1="12" x2="14" y2="2" stroke="#2b3444" stroke-width="1.5"/><line x1="14" y1="12" x2="24" y2="2" stroke="#2b3444" stroke-width="1.5"/></svg><span>Blocked-out cell (impassable)</span>`;
  h+=`<span style="color:var(--muted)">→</span><span>One-way (arrow points where it leads)</span>`;
  h+=`<svg width="34" height="14"><rect x="2" y="1" width="28" height="12" rx="3" fill="#132a2e" stroke="${LIFT_HEX}"/><text x="16" y="10" text-anchor="middle" fill="${LIFT_HEX}" font-size="8.5" font-weight="700">⇕G</text></svg><span>Elevator lobby — the stop's button; click to edit the elevator</span>`;
  return h;
}

function renderRoomPanel(side,r){
  const sec=document.createElement("div"); sec.className="section";
  sec.innerHTML=`<h3><button class="sideClose" title="Close panel">✕</button>Room <span class="coordChip">(${r.x}, ${r.y}, fl ${r.z}) · ${escapeHTML(short(areaName(r.area)))}</span></h3>
    <label class="fld" for="roomNameInput">Name</label>
    <input type="text" id="roomNameInput" placeholder="e.g. Temple Square" maxlength="60">
    <label class="fld" for="roomDesc">Description</label>
    <textarea id="roomDesc" placeholder="What a player sees when they look…"></textarea>
    <label class="fld">Color</label><div class="swatches" id="swatches"></div>
    <label class="fld" for="roomNotes">Notes</label>
    <textarea id="roomNotes" placeholder="Keys needed, mobs, quest hints…"></textarea>
    <div class="row" style="margin-top:10px">
      <button id="digUp" title="Create/link a room one floor up (U)">▲ Dig up</button>
      <button id="digDown" title="Create/link a room one floor down (D)">▼ Dig down</button>
      <button id="digSlope" title="Dig up or down and across: northup, southwestdown … (hold U or D and press an arrow)">⬈ Slope…</button>
    </div>
    <div class="row" style="margin-top:6px">
      <button id="shiftUp" title="Move this room one floor up — all exits and edges stay connected (Shift+U)">⤒ Shift up</button>
      <button id="shiftDown" title="Move this room one floor down — all exits and edges stay connected (Shift+D)">⤓ Shift down</button>
    </div>
    <div class="row" style="margin-top:6px">
      <button id="digArea" title="Dig an exit into a brand-new area (A)">⇗ New area</button>
      <button id="linkArea" title="Link an exit to a room in an existing area (L)">⛓ Link area</button>
      <span class="spacer"></span>
      <button id="delRoom" class="danger" title="Delete room and its exits (Del)">Delete</button>
    </div>`;
  side.appendChild(sec);
  const rc=sec.querySelector(".sideClose"); if(rc) rc.onclick=()=>{ sel=null; render(); };

  const ni=sec.querySelector("#roomNameInput"); ni.value=r.name;
  ni.addEventListener("input",()=>{ r.name=ni.value; redrawRoomsOnly(); scheduleSave(); scheduleRoomPatch(r.id,{name:r.name}); });
  ni.addEventListener("focus",()=>pushUndo());
  ni.addEventListener("keydown",e=>{ if(e.key==="Enter"){ ni.blur(); svg.focus?.(); }});

  const sw=sec.querySelector("#swatches");
  ROOM_COLORS.forEach(c=>{ const b=document.createElement("button");
    b.className="sw"+(r.color===c?" on":""); b.style.background=c; b.title=c;
    b.onclick=()=>{ pushUndo(); r.color=c; commit(); scheduleRoomPatch(r.id,{color:c}); };
    sw.appendChild(b); });

  const desc=sec.querySelector("#roomDesc"); desc.value=r.description||"";
  desc.addEventListener("focus",()=>pushUndo());
  desc.addEventListener("input",()=>{ r.description=desc.value; scheduleSave(); scheduleRoomPatch(r.id,{description:r.description}); });

  const notes=sec.querySelector("#roomNotes"); notes.value=r.notes||"";
  notes.addEventListener("focus",()=>pushUndo());
  notes.addEventListener("input",()=>{ r.notes=notes.value; scheduleSave(); scheduleRoomPatch(r.id,{notes:r.notes}); });

  sec.querySelector("#digUp").onclick=()=>digVertical(r,"up");
  sec.querySelector("#digDown").onclick=()=>digVertical(r,"down");
  sec.querySelector("#digSlope").onclick=()=>openDigSlope(r);
  sec.querySelector("#shiftUp").onclick=()=>shiftRoomFloor(r,-1);
  sec.querySelector("#shiftDown").onclick=()=>shiftRoomFloor(r,1);
  sec.querySelector("#digArea").onclick=()=>openDigArea(r);
  sec.querySelector("#linkArea").onclick=()=>openLinkArea(r);
  sec.querySelector("#delRoom").onclick=()=>{ pushUndo(); deleteRoom(r.id); sel=null; commit(); toast("Room deleted"); };

  side.appendChild(roomElevatorSection(r));

  // exits list
  const ex=document.createElement("div"); ex.className="section";
  const list=roomExits(r.id);
  ex.innerHTML=`<h3>Exits (${list.length})</h3>`;
  if(!list.length) ex.innerHTML+=`<span class="hint">No exits yet. Drag one of the amber dots around the room to a neighbouring cell, or press an arrow / numpad key to dig.</span>`;
  list.sort((a,b)=>dirOrder(a,r)-dirOrder(b,r));
  list.forEach(e=>ex.appendChild(exitRow(e,r)));
  side.appendChild(ex);

  // edges (jumps)
  const eg=document.createElement("div"); eg.className="section";
  const elist=edgesFrom(r.id);
  eg.innerHTML=`<h3>Edges — jumps (${elist.length})</h3>`;
  if(!elist.length){
    const hint=document.createElement("span"); hint.className="hint";
    hint.innerHTML=`An edge is a jumpable exit: succeed and you reach one room, fail and you always land in another. Press <span class="kbd">J</span> or the button below to add one.`;
    eg.appendChild(hint);
  }
  elist.forEach(g=>eg.appendChild(edgeRow(g,r)));
  const addRow=document.createElement("div"); addRow.className="row"; addRow.style.marginTop="8px";
  const addBtn=document.createElement("button");
  addBtn.textContent="⤼ Add edge";
  addBtn.title="Add a jumpable edge from this room (J)";
  addBtn.onclick=()=>openAddEdge(r);
  addRow.appendChild(addBtn); eg.appendChild(addRow);
  side.appendChild(eg);
}
function edgeRow(g,r){
  const s=state.rooms[g.success], fl=state.rooms[g.fail];
  const row=document.createElement("div"); row.className="exitRow"; row.style.flexWrap="wrap";
  const sTag = s&&s.area!==r.area ? ` <span style="color:${EDGE_HEX}">⇗${escapeHTML(short(areaName(s.area)))}</span>`
             : s&&s.z!==r.z ? ` <span style="color:${EDGE_HEX}">fl ${s.z}</span>` : "";
  row.innerHTML=`<span class="dirBadge" style="color:${EDGE_HEX}">${DIR_LABEL[g.dir]||"?"}</span>
    <button class="jump" title="Go to the success room">⤼ ${escapeHTML(s?.name||"?")}${sTag}</button>
    <button class="iconBtn" title="Edit this edge">✎</button>
    <button class="iconBtn danger" title="Delete edge">✕</button>
    <span style="flex-basis:100%;padding-left:40px;font-size:11px;color:var(--muted)">↓ fail → ${escapeHTML(fl?.name||"?")}</span>`;
  const [jump,edit,del]=[row.children[1],row.children[2],row.children[3]];
  jump.onclick=()=>jumpToRoom(s);
  edit.onclick=()=>select({kind:"edge",id:g.id});
  del.onclick=()=>{ const doomed=g.id; pushUndo(); delete state.edges[g.id]; commit(); toast("Edge deleted");
    enqueueLive(async()=>{ await api.deleteEdge(canon(doomed)); }); };
  return row;
}
function dirOrder(e,r){
  const d=exitDirFrom(e,r);
  return d?Object.keys(DIRS).indexOf(d):99;
}
function exitRow(e,r){
  const other=otherRoom(e,r);
  const d=exitDirFrom(e,r);
  const cross=other&&other.area!==r.area;
  const row=document.createElement("div"); row.className="exitRow";
  const arrow = e.dir==="both"?"⇄" : ((e.dir==="ab")===(e.a===r.id) ? "→":"←");
  const tgt = escapeHTML(other?.name||"(unnamed)") +
    (cross?` <span style="color:${(EXIT_TYPES[e.type]||EXIT_TYPES.open).hex}">⇗${escapeHTML(short(areaName(other.area)))}</span>`:"");
  row.innerHTML=`<span class="dirBadge" style="color:${(EXIT_TYPES[e.type]||EXIT_TYPES.open).hex}">${DIR_LABEL[d]||"?"}</span>
    <button class="jump" title="${cross?"Travel to "+escapeHTML(areaName(other.area)):"Go to this room"}">${arrow} ${tgt}</button>
    <select title="Exit type">${typeOptions(e.type)}</select>
    <button class="iconBtn" title="${e.hidden?"Hidden exit — click to reveal":"Visible — click to make hidden (dotted)"}">${e.hidden?"◌":"●"}</button>
    <button class="iconBtn danger" title="Delete exit">✕</button>`;
  const [jump,type,hid,del]=[row.children[1],row.children[2],row.children[3],row.children[4]];
  jump.onclick=()=>jumpToRoom(other);
  type.onchange=()=>{ pushUndo(); e.type=type.value; commit();
    enqueueLive(async()=>{ await api.patchExit(canon(e.id),{type:e.type}); }); };
  hid.onclick=()=>{ pushUndo(); e.hidden=!e.hidden; commit();
    enqueueLive(async()=>{ await api.patchExit(canon(e.id),{hidden:e.hidden}); }); };
  del.onclick=()=>{ const doomed=e.id; pushUndo(); delete state.exits[e.id]; commit(); toast("Exit deleted");
    enqueueLive(async()=>{ await api.deleteExit(canon(doomed)); }); };
  return row;
}
function typeOptions(cur){ let h="";
  for(const t in EXIT_TYPES) h+=`<option value="${t}" ${t===cur?"selected":""}>${EXIT_TYPES[t].label}</option>`;
  return h; }

function dirOptions(cur){ let h="";
  for(const d in DIRS) h+=`<option value="${d}" ${d===cur?"selected":""}>${DIR_LABEL[d]}</option>`;
  return h; }

function renderExitPanel(side,e){
  const ra=state.rooms[e.a], rb=state.rooms[e.b];
  const cross = ra&&rb&&ra.area!==rb.area;
  const chip = cross ? "area link" : (ra&&rb?DIR_LABEL[dirFromTo(ra,rb)]:"");
  const sec=document.createElement("div"); sec.className="section";
  sec.innerHTML=`<h3><button class="sideClose" title="Close panel">✕</button>Exit <span class="coordChip">${chip}</span></h3>
    <div class="hint" style="margin-bottom:8px">
      <b style="color:var(--ink)">${escapeHTML(ra?.name||"(unnamed)")}</b>${cross?` <span class="coordChip">(${escapeHTML(short(areaName(ra.area)))})</span>`:""}
      ⟷ <b style="color:var(--ink)">${escapeHTML(rb?.name||"(unnamed)")}</b>${cross?` <span class="coordChip">(${escapeHTML(short(areaName(rb.area)))})</span>`:""}</div>
    <label class="fld">Type</label><select id="exType">${typeOptions(e.type)}</select>
    ${cross?`
    <label class="fld">Direction leaving ${escapeHTML(short(ra?.name))}</label>
    <select id="adirSel">${dirOptions(e.adir||"e")}</select>
    <label class="fld">Direction leaving ${escapeHTML(short(rb?.name))}</label>
    <select id="bdirSel">${dirOptions(e.bdir||OPPOSITE[e.adir||"e"])}</select>`:""}
    <label class="fld">Direction</label>
    <div class="row tight" id="exDir">
      <button data-d="both">⇄ Two-way</button>
      <button data-d="ab">→ ${escapeHTML(short(rb?.name))}</button>
      <button data-d="ba">→ ${escapeHTML(short(ra?.name))}</button>
    </div>
    <label class="fld" style="display:flex;gap:6px;align-items:center;cursor:pointer;margin-top:10px">
      <input type="checkbox" id="exHidden"> Hidden exit (dotted line)</label>
    ${cross?`<div class="row" style="margin-top:12px">
      <button id="goA">⇗ ${escapeHTML(short(ra?.name))}</button>
      <button id="goB">⇗ ${escapeHTML(short(rb?.name))}</button></div>`:""}
    <div class="row" style="margin-top:12px">
      <button id="exDel" class="danger">Delete exit</button></div>`;
  side.appendChild(sec);
  const xc=sec.querySelector(".sideClose"); if(xc) xc.onclick=()=>{ sel=null; render(); };
  sec.querySelector("#exType").onchange=ev=>{ pushUndo(); e.type=ev.target.value; commit();
    enqueueLive(async()=>{ await api.patchExit(canon(e.id),{type:e.type}); }); };
  if(cross){
    sec.querySelector("#adirSel").onchange=ev=>{ pushUndo(); e.adir=ev.target.value; commit();
      enqueueLive(async()=>{ await api.patchExit(canon(e.id),{adir:e.adir}); }); };
    sec.querySelector("#bdirSel").onchange=ev=>{ pushUndo(); e.bdir=ev.target.value; commit();
      enqueueLive(async()=>{ await api.patchExit(canon(e.id),{bdir:e.bdir}); }); };
    sec.querySelector("#goA").onclick=()=>jumpToRoom(ra);
    sec.querySelector("#goB").onclick=()=>jumpToRoom(rb);
  }
  sec.querySelectorAll("#exDir button").forEach(b=>{
    if(b.dataset.d===e.dir){ b.classList.add("primary"); }
    b.onclick=()=>{ pushUndo(); e.dir=b.dataset.d; commit();
      enqueueLive(async()=>{ await api.patchExit(canon(e.id),{dir:e.dir}); });
      sec.querySelectorAll("#exDir button").forEach(x=>x.classList.toggle("primary",x===b));
    };
  });
  const hc=sec.querySelector("#exHidden"); hc.checked=e.hidden;
  hc.onchange=()=>{ pushUndo(); e.hidden=hc.checked; commit();
    enqueueLive(async()=>{ await api.patchExit(canon(e.id),{hidden:e.hidden}); }); };
  sec.querySelector("#exDel").onclick=()=>{ const doomed=e.id; pushUndo(); delete state.exits[e.id]; sel=null; commit(); toast("Exit deleted");
    enqueueLive(async()=>{ await api.deleteExit(canon(doomed)); }); };
}
function short(n){ n=n||"(unnamed)"; return n.length>12?n.slice(0,11)+"…":n; }
function escapeHTML(s){ return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------- shared pickers ---------- */
function planarDirOptions(cur){
  return PLANAR.map(d=>`<option value="${d}" ${d===cur?"selected":""}>${DIR_LABEL[d]}</option>`).join("");
}
function areaOptionsHTML(selId){
  return Object.values(state.areas).map(a=>
    `<option value="${a.id}" ${a.id===selId?"selected":""}>${escapeHTML(a.name)}</option>`).join("");
}
function fillRoomSelect(selEl,areaId,selectedId){
  const rs=Object.values(state.rooms).filter(r=>r.area===areaId)
    .sort((a,b)=>(a.name||"~").localeCompare(b.name||"~"));
  selEl.innerHTML=rs.map(r=>
    `<option value="${r.id}" ${r.id===selectedId?"selected":""}>${escapeHTML(r.name||"(unnamed)")} (${r.x},${r.y},${r.z})</option>`).join("")
    || `<option value="">(no rooms in this area)</option>`;
}
/* area+room picker pair inside a container; onPick(roomId) fires when a room is chosen */
function wireRoomPicker(areaSel,roomSel,initialRoom,onPick){
  const startArea=initialRoom?initialRoom.area:Object.keys(state.areas)[0];
  areaSel.innerHTML=areaOptionsHTML(startArea);
  fillRoomSelect(roomSel,startArea,initialRoom?.id);
  areaSel.onchange=()=>fillRoomSelect(roomSel,areaSel.value,null);
  if(onPick) roomSel.onchange=()=>{ if(roomSel.value) onPick(roomSel.value); };
}

function renderEdgePanel(side,g){
  const f=state.rooms[g.from], s=state.rooms[g.success], fl=state.rooms[g.fail];
  const sec=document.createElement("div"); sec.className="section";
  sec.innerHTML=`<h3><button class="sideClose" title="Close panel">✕</button>Edge <span class="coordChip" style="color:${EDGE_HEX}">jump ${DIR_LABEL[g.dir]||"?"}</span></h3>
    <div class="hint" style="margin-bottom:8px">From <b style="color:var(--ink)">${escapeHTML(f?.name||"(unnamed)")}</b> — succeed and reach one room, fail and always land in the other.</div>
    <label class="fld">Jump direction</label>
    <select id="egDir">${planarDirOptions(g.dir)}</select>
    <label class="fld" style="color:${EDGE_HEX}">⤼ Success room</label>
    <div class="row tight"><select id="egSA" style="flex:1"></select><select id="egSR" style="flex:2"></select></div>
    <label class="fld" style="color:${EDGE_HEX}">↓ Failure room (fixed landing)</label>
    <div class="row tight"><select id="egFA" style="flex:1"></select><select id="egFR" style="flex:2"></select></div>
    <label class="fld" style="display:flex;gap:6px;align-items:center;cursor:pointer;margin-top:10px">
      <input type="checkbox" id="egHidden"> Hidden edge (dotted arc)</label>
    <div class="row" style="margin-top:12px">
      <button id="egGoF">${escapeHTML(short(f?.name))}</button>
      <button id="egGoS">⤼ ${escapeHTML(short(s?.name))}</button>
      <button id="egGoX">↓ ${escapeHTML(short(fl?.name))}</button>
    </div>
    <div class="row" style="margin-top:12px">
      <button id="egDel" class="danger">Delete edge</button></div>`;
  side.appendChild(sec);
  const xc=sec.querySelector(".sideClose"); if(xc) xc.onclick=()=>{ sel=null; render(); };
  sec.querySelector("#egDir").onchange=ev=>{ pushUndo(); g.dir=ev.target.value; commit();
    enqueueLive(async()=>{ await api.patchEdge(canon(g.id),{dir:g.dir}); }); };
  wireRoomPicker(sec.querySelector("#egSA"),sec.querySelector("#egSR"),s,
    rid=>{ pushUndo(); g.success=rid; commit();
      enqueueLive(async()=>{ await api.patchEdge(canon(g.id),{success:canon(rid)}); }); });
  wireRoomPicker(sec.querySelector("#egFA"),sec.querySelector("#egFR"),fl,
    rid=>{ pushUndo(); g.fail=rid; commit();
      enqueueLive(async()=>{ await api.patchEdge(canon(g.id),{fail:canon(rid)}); }); });
  const hc=sec.querySelector("#egHidden"); hc.checked=!!g.hidden;
  hc.onchange=()=>{ pushUndo(); g.hidden=hc.checked; commit();
    enqueueLive(async()=>{ await api.patchEdge(canon(g.id),{hidden:g.hidden}); }); };
  sec.querySelector("#egGoF").onclick=()=>jumpToRoom(f);
  sec.querySelector("#egGoS").onclick=()=>jumpToRoom(state.rooms[g.success]);
  sec.querySelector("#egGoX").onclick=()=>jumpToRoom(state.rooms[g.fail]);
  sec.querySelector("#egDel").onclick=()=>{ const doomed=g.id; pushUndo(); delete state.edges[g.id]; sel=null; commit(); toast("Edge deleted");
    enqueueLive(async()=>{ await api.deleteEdge(canon(doomed)); }); };
}

/* live-redraw room layer while typing a name (cheap, no sidebar rebuild) */
function redrawRoomsOnly(){
  layers.room.innerHTML="";
  for(const id in state.rooms){ const r=state.rooms[id];
    if(r.area===view.area&&r.z===view.floor) drawRoom(r); }
}

/* ---------- vertical digging ---------- */
function digVertical(r,dirName){
  // an existing cross-area portal in this direction? travel through it instead
  const portal=roomExits(r.id).find(e=>{
    const o=otherRoom(e,r); return o&&o.area!==r.area&&exitDirFrom(e,r)===dirName; });
  if(portal){ const o=otherRoom(portal,r); jumpToRoom(o); toast("⇗ "+areaName(o.area)); return; }
  const v=DIRS[dirName];
  const existing=roomAt(r.x+v[0],r.y+v[1],r.z+v[2],r.area);
  const target=dig(r,dirName);
  if(!target) return;
  view.floor=target.z;
  select({kind:"room",id:target.id});
  ensureVisible(target);
  toast(existing?`Linked ${DIR_LABEL[dirName]} to floor ${target.z}`:`Dug ${DIR_LABEL[dirName]} → floor ${target.z}`);
  if(!existing) focusName();
}

/* ---------- pointer interactions ---------- */
let ptr=null; // active gesture
const activePtrs=new Map();
let longPress=null;
function cancelLongPress(){ if(longPress){ clearTimeout(longPress); longPress=null; } }

/* capture-phase tracking so pinch works even if one finger starts on a room */
svg.addEventListener("pointerdown",ev=>{
  activePtrs.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
  if(activePtrs.size===2){
    cancelLongPress();
    layers.over.querySelectorAll(".tmp").forEach(n=>n.remove());
    const [p1,p2]=[...activePtrs.values()];
    const rect=svg.getBoundingClientRect();
    const midx=(p1.x+p2.x)/2-rect.left, midy=(p1.y+p2.y)/2-rect.top;
    ptr={mode:"pinch", d0:Math.hypot(p1.x-p2.x,p1.y-p2.y)||1, zoom0:view.zoom,
         wx:(midx-view.panX)/view.zoom, wy:(midy-view.panY)/view.zoom};
    svg.classList.remove("panning","linking");
  }
},true);
svg.addEventListener("pointermove",ev=>{
  const p=activePtrs.get(ev.pointerId); if(p){ p.x=ev.clientX; p.y=ev.clientY; }
},true);
const untrack=ev=>{
  activePtrs.delete(ev.pointerId);
  if(ptr&&ptr.mode==="pinch"&&activePtrs.size<2) ptr=null;
};
svg.addEventListener("pointerup",untrack,true);
svg.addEventListener("pointercancel",untrack,true);

svg.addEventListener("pointerdown",ev=>{
  if(ev.button!==0||(ptr&&ptr.mode==="pinch")) return;
  if(blockMode){
    const w=screenToWorld(ev.clientX,ev.clientY), cell=worldToCell(w.x,w.y);
    const erase=isBlocked(cell.x,cell.y,view.floor,view.area);
    ptr={mode:"paint",erase,changed:false,undoPushed:false};
    svg.setPointerCapture(ev.pointerId);
    applyPaint(cell);
    return;
  }
  ptr={mode:"pan",sx:ev.clientX,sy:ev.clientY,panX:view.panX,panY:view.panY,moved:false};
  svg.setPointerCapture(ev.pointerId);
  svg.classList.add("panning");
  if(ev.pointerType==="touch"){
    cancelLongPress();
    longPress=setTimeout(()=>{
      longPress=null;
      if(!ptr||ptr.mode!=="pan"||ptr.moved) return;
      const w=screenToWorld(ptr.sx,ptr.sy), cell=worldToCell(w.x,w.y);
      ptr=null; svg.classList.remove("panning");
      if(roomAt(cell.x,cell.y,view.floor,view.area)) return;
      if(isBlocked(cell.x,cell.y,view.floor,view.area)) return;
      pushUndo();
      const r=createRoom(cell.x,cell.y,view.floor,"",view.area);
      commit(); select({kind:"room",id:r.id});
      toast("New room — type its name"); focusName();
    },520);
  }
});
function startRoomDrag(ev,rid){
  if(ev.button!==0||blockMode) return;
  ev.stopPropagation();
  ptr={mode:"room",rid,sx:ev.clientX,sy:ev.clientY,moved:false};
  svg.setPointerCapture(ev.pointerId);
}
function startLinkDrag(ev,rid){
  if(ev.button!==0||blockMode) return;
  ev.stopPropagation();
  ptr={mode:"link",rid,moved:true};
  svg.setPointerCapture(ev.pointerId);
  svg.classList.add("linking");
}

function applyPaint(cell){
  if(!ptr||ptr.mode!=="paint") return;
  if(!ptr.undoPushed){ ptr.undoPushed=!!pushUndo(); }
  if(paintCell(cell,ptr.erase)){ ptr.changed=true; renderBlocks(); }
}

svg.addEventListener("pointermove",ev=>{
  if(ptr&&ptr.mode==="pinch"){
    if(activePtrs.size<2) return;
    const [p1,p2]=[...activePtrs.values()];
    const rect=svg.getBoundingClientRect();
    const d=Math.hypot(p1.x-p2.x,p1.y-p2.y)||1;
    const midx=(p1.x+p2.x)/2-rect.left, midy=(p1.y+p2.y)/2-rect.top;
    const nz=Math.min(2.5,Math.max(0.25,ptr.zoom0*d/ptr.d0));
    view.zoom=nz;
    view.panX=midx-ptr.wx*nz; view.panY=midy-ptr.wy*nz;
    applyView();
    return;
  }
  const w=screenToWorld(ev.clientX,ev.clientY), cell=worldToCell(w.x,w.y);
  if(!hoverCell||hoverCell.x!==cell.x||hoverCell.y!==cell.y){ hoverCell=cell; renderStatus(); }
  if(ptr&&ptr.mode==="paint"){ applyPaint(cell); return; }
  if(blockMode&&!ptr){
    layers.over.querySelectorAll(".tmp").forEach(n=>n.remove());
    const hov=el("rect",{x:cell.x*CELL-CELL/2,y:cell.y*CELL-CELL/2,width:CELL,height:CELL,
      fill:"none",stroke:"var(--accent)",["stroke-dasharray"]:"4 4",["stroke-width"]:1.2});
    hov.classList.add("tmp"); layers.over.appendChild(hov);
    return;
  }
  if(!ptr) return;
  const dx=ev.clientX-ptr.sx, dy=ev.clientY-ptr.sy;
  if(Math.hypot(dx,dy)>4&&!ptr.moved){ ptr.moved=true; cancelLongPress(); }

  if(ptr.mode==="pan"&&ptr.moved){
    view.panX=ptr.panX+dx; view.panY=ptr.panY+dy; applyView();
  }
  if(ptr.mode==="room"&&ptr.moved){
    drawDragGhost(state.rooms[ptr.rid],cell);
  }
  if(ptr.mode==="link"){
    drawLinkPreview(state.rooms[ptr.rid],cell);
  }
});

svg.addEventListener("pointerup",ev=>{
  cancelLongPress();
  svg.classList.remove("panning","linking");
  if(!ptr) return;
  if(ptr.mode==="pinch") return;   // untracked in capture handler
  const p=ptr; ptr=null;
  const w=screenToWorld(ev.clientX,ev.clientY), cell=worldToCell(w.x,w.y);
  layers.over.querySelectorAll(".tmp").forEach(n=>n.remove());

  if(p.mode==="paint"){
    if(p.changed) commit();
    else if(p.undoPushed){ undoStack.pop(); syncUndoBtns(); }
    return;
  }

  if(p.mode==="pan"&&!p.moved){ sel=null; render(); return; }

  if(p.mode==="room"){
    const r=state.rooms[p.rid];
    if(!p.moved){ select({kind:"room",id:p.rid}); return; }
    if(cell.x===r.x&&cell.y===r.y){ render(); return; }
    const occ=roomAt(cell.x,cell.y,r.z,r.area);
    if(occ){ toast("That cell is occupied","err"); render(); return; }
    if(isBlocked(cell.x,cell.y,r.z,r.area)){ toast("That cell is blocked out","err"); render(); return; }
    pushUndo();
    coordIdx.delete(key(r.area,r.x,r.y,r.z));
    r.x=cell.x; r.y=cell.y;
    commit(); toast(`Moved to ${r.x}, ${r.y}`);
    liveMoveRoom(r);
    select({kind:"room",id:r.id});
    return;
  }

  if(p.mode==="link"){
    const from=state.rooms[p.rid];
    if(cell.x===from.x&&cell.y===from.y){ render(); return; }
    if(!straightLine(from.x,from.y,cell.x,cell.y)){
      toast("Exits run along the 8 cardinal directions","err"); render(); return; }
    let target=roomAt(cell.x,cell.y,from.z,from.area);
    pushUndo();
    if(target){
      if(exitBetween(from.id,target.id)){ if(p.undoPushed){ undoStack.pop(); syncUndoBtns(); }
        toast("Already connected"); select({kind:"exit",id:exitBetween(from.id,target.id).id}); return; }
      const e=createExit(from.id,target.id);
      commit(); select({kind:"exit",id:e.id}); toast("Rooms connected");
    }else{
      if(isBlocked(cell.x,cell.y,from.z,from.area)){
        toast("That cell is blocked out","err"); render(); return; }
      target=createRoom(cell.x,cell.y,from.z,"",from.area);
      createExit(from.id,target.id);
      commit(); select({kind:"room",id:target.id});
      toast("New room — type its name"); focusName();
    }
  }
});

svg.addEventListener("pointercancel",()=>{
  cancelLongPress();
  if(ptr&&ptr.mode==="paint"&&ptr.changed) commit();
  if(ptr&&ptr.mode!=="pinch"){ ptr=null; layers.over.querySelectorAll(".tmp").forEach(n=>n.remove()); }
  svg.classList.remove("panning","linking");
});

svg.addEventListener("dblclick",ev=>{
  // dblclick on a room is handled on the room group; this is empty-cell creation
  if(blockMode) return;
  const w=screenToWorld(ev.clientX,ev.clientY), cell=worldToCell(w.x,w.y);
  if(roomAt(cell.x,cell.y,view.floor,view.area)) return;
  if(isBlocked(cell.x,cell.y,view.floor,view.area)){ toast("That cell is blocked out — use ▦ Block mode to erase it","err"); return; }
  pushUndo();
  const r=createRoom(cell.x,cell.y,view.floor,"",view.area);
  commit(); select({kind:"room",id:r.id});
  toast("New room — type its name"); focusName();
});

function drawDragGhost(r,cell){
  layers.over.querySelectorAll(".tmp").forEach(n=>n.remove());
  const occ=(roomAt(cell.x,cell.y,r.z,r.area)&&!(cell.x===r.x&&cell.y===r.y))
           ||isBlocked(cell.x,cell.y,r.z,r.area);
  const g=el("rect",{x:cell.x*CELL-ROOM/2,y:cell.y*CELL-ROOM/2,width:ROOM,height:ROOM,rx:8,
    fill:occ?"#e2666622":"#f6b73c22",stroke:occ?"var(--danger)":"var(--accent)",
    ["stroke-dasharray"]:"4 4",["stroke-width"]:1.5});
  g.classList.add("tmp"); layers.over.appendChild(g);
}
function drawLinkPreview(from,cell){
  layers.over.querySelectorAll(".tmp").forEach(n=>n.remove());
  const ok=straightLine(from.x,from.y,cell.x,cell.y)
    &&!(isBlocked(cell.x,cell.y,from.z,from.area)&&!roomAt(cell.x,cell.y,from.z,from.area));
  const w=worldOf(from);
  const ln=el("line",{x1:w.x,y1:w.y,x2:cell.x*CELL,y2:cell.y*CELL,
    stroke:ok?"var(--accent)":"var(--danger)",["stroke-width"]:2,["stroke-dasharray"]:"5 5"});
  ln.classList.add("tmp");
  const tgt=el("rect",{x:cell.x*CELL-ROOM/2,y:cell.y*CELL-ROOM/2,width:ROOM,height:ROOM,rx:8,
    fill:"none",stroke:ok?"var(--accent)":"var(--danger)",["stroke-dasharray"]:"4 4"});
  tgt.classList.add("tmp");
  layers.over.appendChild(ln); layers.over.appendChild(tgt);
}

/* zoom */
svg.addEventListener("wheel",ev=>{
  ev.preventDefault();
  zoomAt(ev.clientX,ev.clientY, ev.deltaY<0?1.12:1/1.12);
},{passive:false});
function zoomAt(cx,cy,f){
  const rect=svg.getBoundingClientRect();
  const nz=Math.min(2.5,Math.max(0.25,view.zoom*f));
  const k=nz/view.zoom;
  view.panX=(cx-rect.left)-k*((cx-rect.left)-view.panX);
  view.panY=(cy-rect.top)-k*((cy-rect.top)-view.panY);
  view.zoom=nz; applyView();
}
$("zoomIn").onclick=()=>{ const r=svg.getBoundingClientRect(); zoomAt(r.left+r.width/2,r.top+r.height/2,1.2); };
$("zoomOut").onclick=()=>{ const r=svg.getBoundingClientRect(); zoomAt(r.left+r.width/2,r.top+r.height/2,1/1.2); };

/* ---------- keyboard ---------- */
const KEYMAP = {
  ArrowUp:"n", ArrowDown:"s", ArrowLeft:"w", ArrowRight:"e",
  Numpad8:"n", Numpad2:"s", Numpad4:"w", Numpad6:"e",
  Numpad7:"nw", Numpad9:"ne", Numpad1:"sw", Numpad3:"se",
};
bind(document,"keydown",ev=>{
  const tag=ev.target.tagName;
  const typing = tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT";
  if($("modalBack").classList.contains("open")){
    if(ev.key==="Escape") closeModal();
    return;
  }
  if((ev.ctrlKey||ev.metaKey)&&!typing){
    if(ev.key==="z"&&!ev.shiftKey){ ev.preventDefault(); undo(); return; }
    if((ev.key==="z"&&ev.shiftKey)||ev.key==="y"){ ev.preventDefault(); redo(); return; }
  }
  if((ev.ctrlKey||ev.metaKey)&&ev.key==="s"){ ev.preventDefault(); flushSave(); return; }
  if(typing){ if(ev.key==="Escape") ev.target.blur(); return; }

  const d=KEYMAP[ev.code]||KEYMAP[ev.key];
  if(d){ ev.preventDefault();
    // Holding U or D turns a direction into a vertical diagonal: U+↑ digs northup (nu), D+← westdown (wd).
    if(heldV&&sel?.kind==="room"){ heldV.used=true; digFromSel(d+(heldV.dir==="up"?"u":"d")); return; }
    moveOrDig(d,ev.shiftKey); return; }
  switch(ev.key){
    case "u": case "U":
      if(ev.shiftKey){ if(sel?.kind==="room"&&state.rooms[sel.id]) shiftRoomFloor(state.rooms[sel.id],-1); }
      else if(!ev.repeat) heldV={dir:"up",used:false}; break;   // digs up on release, unless a direction came with it
    case "d": case "D":
      if(ev.shiftKey){ if(sel?.kind==="room"&&state.rooms[sel.id]) shiftRoomFloor(state.rooms[sel.id],1); }
      else if(!ev.repeat) heldV={dir:"down",used:false}; break;
    case "j": case "J": if(sel?.kind==="room"&&state.rooms[sel.id]) openAddEdge(state.rooms[sel.id]); break;
    case "a": case "A": if(sel?.kind==="room"&&state.rooms[sel.id]) openDigArea(state.rooms[sel.id]); break;
    case "l": case "L": if(sel?.kind==="room"&&state.rooms[sel.id]) openLinkArea(state.rooms[sel.id]); break;
    case "PageUp": ev.preventDefault(); changeFloor(-1); break;
    case "PageDown": ev.preventDefault(); changeFloor(1); break;
    case "Enter": case "F2": if(sel?.kind==="room"){ ev.preventDefault(); focusName(); } break;
    case "Delete": case "Backspace": deleteSelection(); break;
    case "b": case "B": setBlockMode(!blockMode); break;
    case "Escape":
      if(blockMode){ setBlockMode(false); break; }
      sel=null; render(); break;
    case "f": case "F": fitView(); break;
    case "?": openHelp(); break;
  }
});
let heldV=null;   // {dir:"up"|"down", used}: U or D is held down
bind(document,"keyup",ev=>{
  if(!heldV) return;
  const k=ev.key.toLowerCase();
  if((k==="u"&&heldV.dir==="up")||(k==="d"&&heldV.dir==="down")){
    const h=heldV; heldV=null;
    if(!h.used&&!ev.shiftKey) digFromSel(h.dir);
  }
});
bind(window,"blur",()=>{ heldV=null; });
function moveOrDig(d,shiftOnly){
  if(!sel||sel.kind!=="room"){ // no room selected: pan the map instead
    const v=DIRS[d]; view.panX-=v[0]*CELL*0.8; view.panY-=v[1]*CELL*0.8; applyView(); return; }
  const r=state.rooms[sel.id]; if(!r) return;
  // an existing cross-area portal in this direction? walk through it
  const portal=roomExits(r.id).find(e=>{
    const o=otherRoom(e,r); return o&&o.area!==r.area&&exitDirFrom(e,r)===d; });
  if(portal){ const o=otherRoom(portal,r); jumpToRoom(o); toast("⇗ "+areaName(o.area)); return; }
  const v=DIRS[d];
  if(shiftOnly){
    const t=roomAt(r.x+v[0],r.y+v[1],r.z,r.area);
    if(t){ select({kind:"room",id:t.id}); ensureVisible(t); }
    return;
  }
  const existed=roomAt(r.x+v[0],r.y+v[1],r.z,r.area);
  const t=dig(r,d);
  if(!t) return;
  select({kind:"room",id:t.id}); ensureVisible(t);
  if(!existed) toast("Dug "+DIR_LABEL[d]+" — press Enter to name it");
}
function digFromSel(dirName){   // up, down or a vertical diagonal; follows to the new floor
  if(sel?.kind!=="room") return;
  const r=state.rooms[sel.id]; if(r) digVertical(r,dirName);
}
function deleteSelection(){
  if(!sel) return;
  const snapped=pushUndo();
  if(sel.kind==="room"&&state.rooms[sel.id]){ deleteRoom(sel.id); toast("Room deleted"); }
  else if(sel.kind==="exit"&&state.exits[sel.id]){
    const doomed=sel.id; delete state.exits[sel.id]; toast("Exit deleted");
    enqueueLive(async()=>{ await api.deleteExit(canon(doomed)); });
  }
  else if(sel.kind==="elevator"&&state.elevators[sel.id]){ delete state.elevators[sel.id]; toast("Elevator deleted"); }
  else if(sel.kind==="edge"&&state.edges[sel.id]){
    const doomed=sel.id; delete state.edges[sel.id]; toast("Edge deleted");
    enqueueLive(async()=>{ await api.deleteEdge(canon(doomed)); });
  }
  else { if(snapped){ undoStack.pop(); syncUndoBtns(); } return; }
  sel=null; commit();
}
function changeFloor(dz){ view.floor+=dz; sel=null; render(); }
$("floorUp").onclick=()=>changeFloor(-1);
$("floorDown").onclick=()=>changeFloor(1);
$("ghostChk").onchange=e=>{ ghostBelow=e.target.checked; render(); };

/* ---------- toolbar ---------- */
$("mapName").addEventListener("input",e=>{
  state.name=e.target.value; scheduleSave();
  if(!liveEdit || !api) return;
  clearTimeout(mapNameTimer);
  mapNameTimer=setTimeout(()=>{
    const name=state.name;
    enqueueLive(async()=>{ await api.setName(name); });
  }, 450);
});
$("btnUndo").onclick=undo;
$("btnRedo").onclick=redo;
$("btnFit").onclick=fitView;
$("btnBlock").onclick=()=>setBlockMode(!blockMode);
$("btnHelp").onclick=openHelp;
$("btnNew").onclick=()=>{
  if(liveEdit){ toast("New map disabled while live","err"); return; }
  openModal(`<h2>Start a new map?</h2>
    <p class="hint">The current map (${Object.keys(state.rooms).length} rooms) will be replaced. Undo can bring it back during this session, but export it first if you want to keep it.</p>
    <div class="row"><span class="spacer"></span>
      <button id="mCancel">Cancel</button>
      <button id="mOk" class="primary">New map</button></div>`);
  $("mCancel").onclick=closeModal;
  $("mOk").onclick=()=>{ pushUndo(); state=blankState(); viewMem={};
    const ar=createArea("Main");
    const r=createRoom(0,0,0,"Start",ar.id);
    sel={kind:"room",id:r.id}; view.area=ar.id; view.floor=0;
    closeModal(); commit(); fitView(); };
};
const liveChk=$("liveChk");
if(liveChk) liveChk.onchange=e=>setLiveEdit(e.target.checked);

/* ---------- elevators ----------
   An elevator is one carriage room off the grid and its stops, top floor first: a button label and a
   lobby room (any area) whose `in` opens on the carriage. Publishing makes them; see plans/elevators-app.md. */
const LIFT_HEX="#5fd3c6";
function elevatorsAt(rid){ const out=[];
  for(const id in state.elevators){ const v=state.elevators[id]; const st=v.stops.find(x=>x.room===rid); if(st) out.push({v,st}); }
  return out; }
function suggestLabel(r,v){
  const base=r.z===0?"G":r.z<0?String(-r.z):"B"+r.z;
  const used=new Set((v?.stops||[]).map(x=>x.label.toLowerCase()));
  if(!used.has(base.toLowerCase())) return base;
  for(let i=2;i<100;i++){ const c=base+"-"+i; if(!used.has(c.toLowerCase())) return c; }
  return base+"?";
}
/* A stop goes in by its lobby's floor: top (most negative z) first. */
function insertStop(v,room,label){
  const z=state.rooms[room].z;
  const i=v.stops.findIndex(x=>(state.rooms[x.room]?.z??0)>z);
  v.stops.splice(i<0?v.stops.length:i,0,{label,room});
}
function createElevator(name,firstRoom){
  const id="v"+(state.nextId++);
  const v={id,name:name||"Elevator",description:"",door:8,travel:3,stops:[]};
  state.elevators[id]=v;
  if(firstRoom) v.stops.push({label:suggestLabel(state.rooms[firstRoom],v),room:firstRoom});
  return v;
}
function stopLabelOk(v,label,except){
  label=String(label||"").trim();
  if(!label) return "A stop needs a label: the button players press (10, G, B2).";
  if(label.length>16) return "A label is at most 16 characters.";
  if(v.stops.some(x=>x!==except&&x.label.toLowerCase()===label.toLowerCase())) return `Another stop is already labelled "${label}".`;
  return null;
}
function elevatorListSection(){
  const sec=document.createElement("div"); sec.className="section";
  const list=Object.values(state.elevators||{});
  sec.innerHTML=`<h3>Elevators (${list.length})</h3>`+(list.length?"":`<span class="hint">None yet. Select a lobby room and press <b>⇕ New elevator</b>.</span>`);
  list.forEach(v=>{
    const b=document.createElement("button"); b.className="liftRow"; b.style.cssText="display:block;width:100%;text-align:left;margin-top:4px";
    b.innerHTML=`<span style="color:${LIFT_HEX}">⇕</span> ${escapeHTML(v.name)} <span class="hint">· ${v.stops.map(x=>escapeHTML(x.label)).join(" ")||"no stops"}</span>`;
    b.onclick=()=>select({kind:"elevator",id:v.id});
    sec.appendChild(b);
  });
  return sec;
}
function roomElevatorSection(r){
  const sec=document.createElement("div"); sec.className="section";
  const here=elevatorsAt(r.id);
  const others=Object.values(state.elevators).filter(v=>!v.stops.some(x=>x.room===r.id));
  sec.innerHTML=`<h3>Elevators (${here.length})</h3>`+
    (here.length?"":`<span class="hint">A lobby: its <code>in</code> (also <code>e</code>, <code>ele</code>, <code>lift</code>) opens on an elevator's carriage, which lives off the grid. A real east exit keeps <code>e</code>.</span>`);
  here.forEach(({v,st})=>{
    const row=document.createElement("div"); row.className="row tight"; row.style.marginTop="4px";
    row.innerHTML=`<button class="lgo" style="flex:1;text-align:left"><span style="color:${LIFT_HEX}">⇕ ${escapeHTML(st.label)}</span> ${escapeHTML(v.name)} <span class="hint">· ${v.stops.length} stops</span></button><button class="lrm danger" title="Remove this stop">✕</button>`;
    row.querySelector(".lgo").onclick=()=>select({kind:"elevator",id:v.id});
    row.querySelector(".lrm").onclick=()=>{ pushUndo(); v.stops=v.stops.filter(x=>x!==st); commit(); toast(`Stop ${st.label} removed from ${v.name}`); };
    sec.appendChild(row);
  });
  const act=document.createElement("div"); act.className="row"; act.style.marginTop="8px";
  act.innerHTML=`<button id="liftNew" title="Make an elevator with this room as its first stop">⇕ New elevator</button>`;
  sec.appendChild(act);
  if(others.length){ const row=document.createElement("div"); row.className="row tight"; row.style.marginTop="6px";
    row.innerHTML=`<select id="liftPick" style="flex:1;min-width:0">${others.map(v=>`<option value="${v.id}">${escapeHTML(v.name)}</option>`).join("")}</select><button id="liftAdd" title="Make this room a stop of that elevator">＋ Stop here</button>`;
    sec.appendChild(row); }
  act.querySelector("#liftNew").onclick=()=>{ pushUndo(); const v=createElevator("Elevator",r.id); sel={kind:"elevator",id:v.id}; commit(); toast("Elevator made — add its other stops"); };
  const add=sec.querySelector("#liftAdd");
  if(add) add.onclick=()=>{ const v=state.elevators[sec.querySelector("#liftPick").value]; if(!v) return;
    pushUndo(); insertStop(v,r.id,suggestLabel(r,v)); commit(); toast(`${r.name||"Room"} is now a stop of ${v.name}`); };
  return sec;
}
function renderElevatorPanel(side,v){
  const sec=document.createElement("div"); sec.className="section";
  sec.innerHTML=`<h3><button class="sideClose" title="Close panel">✕</button>Elevator <span class="coordChip" style="color:${LIFT_HEX}">⇕ ${v.id} · carriage off the grid</span></h3>
    <label class="fld" for="lvName">Carriage name</label>
    <input type="text" id="lvName" maxlength="200" placeholder="e.g. Tower Lift">
    <label class="fld" for="lvDesc">Carriage description</label>
    <textarea id="lvDesc" placeholder="Brushed steel walls… (the game adds the floor display and the doors)"></textarea>
    <div class="row tight" style="margin-top:6px">
      <label class="fld" style="flex:1">Doors open (s)<input type="number" id="lvDoor" min="1" max="600" style="width:100%"></label>
      <label class="fld" style="flex:1">Travel per floor (s)<input type="number" id="lvTravel" min="1" max="600" style="width:100%"></label>
    </div>
    <div class="row" style="margin-top:10px"><span class="spacer"></span><button id="lvDel" class="danger" title="Delete the elevator (Del): publishing recycles its carriage and lobby exits">Delete elevator</button></div>`;
  side.appendChild(sec);
  sec.querySelector(".sideClose").onclick=()=>{ sel=null; render(); };
  const nm=sec.querySelector("#lvName"); nm.value=v.name;
  nm.addEventListener("focus",()=>pushUndo());
  nm.addEventListener("input",()=>{ v.name=nm.value||"Elevator"; scheduleSave(); });
  nm.addEventListener("change",()=>render());
  const ds=sec.querySelector("#lvDesc"); ds.value=v.description||"";
  ds.addEventListener("focus",()=>pushUndo());
  ds.addEventListener("input",()=>{ v.description=ds.value; scheduleSave(); });
  for(const [idn,k] of [["#lvDoor","door"],["#lvTravel","travel"]]){
    const i=sec.querySelector(idn); i.value=v[k];
    i.addEventListener("focus",()=>pushUndo());
    i.addEventListener("change",()=>{ const n=Math.round(+i.value); if(n>=1&&n<=600){ v[k]=n; scheduleSave(); } else { i.value=v[k]; toast("1 to 600 seconds","err"); } });
  }
  sec.querySelector("#lvDel").onclick=()=>{ pushUndo(); delete state.elevators[v.id]; sel=null; commit(); toast("Elevator deleted"); };

  const st=document.createElement("div"); st.className="section";
  st.innerHTML=`<h3>Stops, top floor first (${v.stops.length})</h3>`+
    (v.stops.length<2?`<span class="hint">An elevator needs two stops or more. Lobbies can be in any area.</span>`:"");
  v.stops.forEach((s,i)=>{
    const r=state.rooms[s.room];
    const row=document.createElement("div"); row.className="row tight"; row.style.marginTop="4px";
    row.innerHTML=`<input type="text" class="lsLabel" maxlength="16" style="width:44px;text-align:center;color:${LIFT_HEX};font-weight:700" title="The button label players press">
      <button class="lsGo" style="flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="Go to this lobby">${escapeHTML(r?.name||"(unnamed)")} <span class="hint">${r?`fl ${r.z} · ${escapeHTML(short(areaName(r.area)))}`:""}</span></button>
      <button class="lsUp" title="Move up the shaft"${i===0?" disabled":""}>↑</button>
      <button class="lsDn" title="Move down the shaft"${i===v.stops.length-1?" disabled":""}>↓</button>
      <button class="lsRm danger" title="Remove this stop">✕</button>`;
    const li=row.querySelector(".lsLabel"); li.value=s.label;
    li.addEventListener("focus",()=>pushUndo());
    li.addEventListener("change",()=>{ const bad=stopLabelOk(v,li.value,s); if(bad){ toast(bad,"err"); li.value=s.label; return; } s.label=li.value.trim(); commit(); });
    row.querySelector(".lsGo").onclick=()=>{ if(r){ jumpToRoom(r); ensureVisible(r); } };
    row.querySelector(".lsUp").onclick=()=>{ pushUndo(); v.stops.splice(i-1,0,v.stops.splice(i,1)[0]); commit(); };
    row.querySelector(".lsDn").onclick=()=>{ pushUndo(); v.stops.splice(i+1,0,v.stops.splice(i,1)[0]); commit(); };
    row.querySelector(".lsRm").onclick=()=>{ pushUndo(); v.stops.splice(i,1); commit(); };
    st.appendChild(row);
  });
  const add=document.createElement("div");
  add.innerHTML=`<label class="fld" style="margin-top:10px">Add a stop</label>
    <div class="row tight"><select id="lsA" style="flex:1"></select><select id="lsR" style="flex:2"></select></div>
    <div class="row tight" style="margin-top:4px"><input type="text" id="lsL" maxlength="16" placeholder="label" style="width:60px"><span class="spacer"></span><button id="lsAdd" class="primary">＋ Add stop</button></div>`;
  st.appendChild(add);
  side.appendChild(st);
  const seed=v.stops.length?state.rooms[v.stops[v.stops.length-1].room]:Object.values(state.rooms).find(r=>r.area===view.area);
  const lsR=add.querySelector("#lsR"), lsL=add.querySelector("#lsL");
  const relabel=()=>{ const r=state.rooms[lsR.value]; if(r) lsL.value=suggestLabel(r,v); };
  // Only rooms that are not stops yet.
  const prune=()=>{ for(const o of [...lsR.options]) if(v.stops.some(x=>x.room===o.value)) o.remove();
    if(!lsR.options.length) lsR.innerHTML=`<option value="">(every room here is a stop)</option>`; };
  wireRoomPicker(add.querySelector("#lsA"),lsR,seed?{area:seed.area,id:null}:null,()=>relabel());
  prune();
  add.querySelector("#lsA").addEventListener("change",()=>{ prune(); relabel(); });
  relabel();
  add.querySelector("#lsAdd").onclick=()=>{
    const r=state.rooms[lsR.value]; if(!r){ toast("Pick a lobby room","err"); return; }
    if(v.stops.some(x=>x.room===r.id)){ toast(`${r.name||"That room"} is already a stop`,"err"); return; }
    const bad=stopLabelOk(v,lsL.value); if(bad){ toast(bad,"err"); return; }
    pushUndo(); insertStop(v,r.id,lsL.value.trim()); commit(); toast(`Stop ${lsL.value.trim()} added`);
  };
}

function openDigSlope(room){
  const used=new Set(roomExits(room.id).map(e=>exitDirFrom(e,room)));
  const first=[...PLANAR.map(p=>p+"u"),...PLANAR.map(p=>p+"d")].find(d=>!used.has(d))||"nu";
  openModal(`<h2>Dig a slope</h2>
    <p class="hint" style="margin-bottom:8px">One floor up or down <i>and</i> one step across from <b style="color:var(--ink)">${escapeHTML(room.name||"this room")}</b>: a ramp, a stair, a scree slope. In the game it is walked as <code>northup</code> / <code>nu</code>, and comes back the opposite way on both axes (<code>southdown</code>). Shortcut: hold U or D and press an arrow.</p>
    ${dirGridHTML(first,false).replace(/^<div class="dirGrid">[\s\S]*?<\/div><div class="vRow">[\s\S]*?<\/div>/,"")}
    <div class="row" style="margin-top:12px"><span class="spacer"></span>
      <button id="dsCancel">Cancel</button>
      <button id="dsOk" class="primary">Dig</button></div>`);
  wireDirGrid();
  $("dsCancel").onclick=closeModal;
  $("dsOk").onclick=()=>{ const d=pickedDir(); closeModal(); if(isVertical(d)) digVertical(room,d); };
}
function openAddEdge(room){
  const seldDir=PLANAR.find(d=>{
    const used=new Set(roomExits(room.id).map(e=>exitDirFrom(e,room)));
    edgesFrom(room.id).forEach(g=>used.add(g.dir));
    return !used.has(d);
  })||"n";
  openModal(`<h2>Add edge (jump)</h2>
    <p class="hint" style="margin-bottom:8px">A jumpable exit from <b style="color:var(--ink)">${escapeHTML(room.name||"this room")}</b>. Success reaches one room; failure always lands in another. It can share a direction with a normal exit.</p>
    <label class="fld">Jump direction</label>
    ${dirGridHTML(seldDir,true)}
    <label class="fld" style="color:${EDGE_HEX}">⤼ Success room</label>
    <div class="row tight"><select id="aeSA" style="flex:1"></select><select id="aeSR" style="flex:2"></select></div>
    <label class="fld" style="color:${EDGE_HEX}">↓ Failure room (fixed landing)</label>
    <div class="row tight"><select id="aeFA" style="flex:1"></select><select id="aeFR" style="flex:2"></select></div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span>
      <button id="aeCancel">Cancel</button>
      <button id="aeOk" class="primary">Add edge ⤼</button></div>`);
  wireDirGrid();
  const seed={area:room.area,id:null};
  wireRoomPicker($("aeSA"),$("aeSR"),seed,null);
  wireRoomPicker($("aeFA"),$("aeFR"),seed,null);
  $("aeCancel").onclick=closeModal;
  $("aeOk").onclick=()=>{
    const suc=state.rooms[$("aeSR").value], fal=state.rooms[$("aeFR").value];
    if(!suc||!fal){ toast("Pick both a success and a failure room","err"); return; }
    pushUndo();
    const g=createEdge(room.id,pickedDir(),suc.id,fal.id);
    closeModal(); select({kind:"edge",id:g.id});
    commit(); toast("Edge added");
  };
}

/* ---------- area modals ---------- */
function dirGridHTML(seld,planarOnly){
  const cells=["nw","n","ne","w",null,"e","sw","s","se"];
  let h='<div class="dirGrid">';
  cells.forEach(c=> h+= c
    ? `<button data-d="${c}" class="${c===seld?"primary":""}">${DIR_LABEL[c]}</button>`
    : `<button class="blank" tabindex="-1"></button>`);
  h+='</div>';
  if(!planarOnly){
    h+='<div class="vRow">'+["up","down"].map(c=>
      `<button data-d="${c}" class="${c===seld?"primary":""}">${DIR_LABEL[c]}</button>`).join("")+"</div>";
    // the vertical diagonals: one floor up or down and one step across
    for(const sfx of ["u","d"]){
      h+=`<div class="hint" style="margin:6px 0 2px">${sfx==="u"?"Up and across":"Down and across"}</div><div class="dirGrid">`;
      cells.forEach(c=> h+= c
        ? `<button data-d="${c+sfx}" class="${c+sfx===seld?"primary":""}">${DIR_LABEL[c+sfx]}</button>`
        : `<button class="blank" tabindex="-1"></button>`);
      h+='</div>';
    }
  }
  return h;
}
function wireDirGrid(){
  root.querySelectorAll("#modal [data-d]").forEach(b=>b.onclick=()=>{
    root.querySelectorAll("#modal [data-d]").forEach(x=>x.classList.remove("primary"));
    b.classList.add("primary");
  });
}
function pickedDir(){
  const b=root.querySelector("#modal [data-d].primary");
  return b?b.dataset.d:"n";
}
function freeDir(room){
  const used=new Set(roomExits(room.id).map(e=>exitDirFrom(e,room)));
  return ["n","e","s","w","ne","se","sw","nw","up","down",...PLANAR.map(p=>p+"u"),...PLANAR.map(p=>p+"d")].find(d=>!used.has(d))||"n";
}

function openDigArea(room){
  openModal(`<h2>Dig into a new area</h2>
    <p class="hint" style="margin-bottom:8px">Creates a fresh area with its own grid, plus an entrance room linked from <b style="color:var(--ink)">${escapeHTML(room.name||"this room")}</b>.</p>
    <label class="fld">Area name</label>
    <input type="text" id="naName" placeholder="e.g. The Sewers" maxlength="40">
    <label class="fld">Exit direction from this room</label>
    ${dirGridHTML(freeDir(room))}
    <label class="fld">Exit type</label><select id="naType">${typeOptions("open")}</select>
    <div class="row"><span class="spacer"></span>
      <button id="naCancel">Cancel</button>
      <button id="naOk" class="primary">Dig ⇗</button></div>`);
  wireDirGrid();
  const nm=$("naName"); nm.focus();
  nm.addEventListener("keydown",e=>{ if(e.key==="Enter") $("naOk").click(); });
  $("naCancel").onclick=closeModal;
  $("naOk").onclick=()=>{
    const d=pickedDir();
    pushUndo();
    const ar=createArea(nm.value.trim()||"New Area");
    const nr=createRoom(0,0,0,"",ar.id);
    createExit(room.id,nr.id,{type:$("naType").value,adir:d,bdir:OPPOSITE[d]});
    closeModal();
    switchArea(ar.id);
    sel={kind:"room",id:nr.id};
    commit(); fitView(); focusName();
    toast(`New area “${ar.name}” — name its entrance room`);
  };
}

function openLinkArea(room){
  const others=Object.values(state.areas).filter(a=>a.id!==room.area);
  if(!others.length){ toast("No other areas yet — digging a new one"); openDigArea(room); return; }
  const areaOpts=others.map(a=>`<option value="${a.id}">${escapeHTML(a.name)}</option>`).join("");
  openModal(`<h2>Link to another area</h2>
    <p class="hint" style="margin-bottom:8px">Connect <b style="color:var(--ink)">${escapeHTML(room.name||"this room")}</b> to a room in an existing area.</p>
    <label class="fld">Area</label><select id="laArea">${areaOpts}</select>
    <label class="fld">Room</label><select id="laRoom"></select>
    <label class="fld">Exit direction from this room</label>
    ${dirGridHTML(freeDir(room))}
    <label class="fld">Exit type</label><select id="laType">${typeOptions("open")}</select>
    <div class="row"><span class="spacer"></span>
      <button id="laCancel">Cancel</button>
      <button id="laOk" class="primary">Link ⛓</button></div>`);
  wireDirGrid();
  const fillRooms=aid=>{
    const rs=Object.values(state.rooms).filter(r=>r.area===aid)
      .sort((a,b)=>(a.name||"~").localeCompare(b.name||"~"));
    $("laRoom").innerHTML=rs.map(r=>
      `<option value="${r.id}">${escapeHTML(r.name||"(unnamed)")} (${r.x},${r.y},${r.z})</option>`).join("")
      || `<option value="">(no rooms in this area)</option>`;
  };
  fillRooms($("laArea").value);
  $("laArea").onchange=e=>fillRooms(e.target.value);
  $("laCancel").onclick=closeModal;
  $("laOk").onclick=()=>{
    const target=state.rooms[$("laRoom").value];
    if(!target){ toast("Pick a target room","err"); return; }
    const existing=exitBetween(room.id,target.id);
    if(existing){ closeModal(); select({kind:"exit",id:existing.id}); toast("Already connected"); return; }
    const d=pickedDir();
    pushUndo();
    const e=createExit(room.id,target.id,{type:$("laType").value,adir:d,bdir:OPPOSITE[d]});
    closeModal(); select({kind:"exit",id:e.id});
    commit(); toast(`Linked to ${areaName(target.area)}`);
  };
}

function openNewArea(){
  openModal(`<h2>New area</h2>
    <label class="fld">Area name</label>
    <input type="text" id="naName" placeholder="e.g. Haon-Dor Forest" maxlength="40">
    <p class="hint" style="margin-top:8px">Tip: to create an area already linked to your map, select a room and press <span class="kbd">A</span> instead.</p>
    <div class="row"><span class="spacer"></span>
      <button id="naCancel">Cancel</button>
      <button id="naOk" class="primary">Create</button></div>`);
  const nm=$("naName"); nm.focus();
  nm.addEventListener("keydown",e=>{ if(e.key==="Enter") $("naOk").click(); });
  $("naCancel").onclick=()=>{ closeModal(); renderAreaSel(); };
  $("naOk").onclick=()=>{
    pushUndo();
    const ar=createArea(nm.value.trim()||"New Area");
    const r=createRoom(0,0,0,"Start",ar.id);
    closeModal(); switchArea(ar.id);
    sel={kind:"room",id:r.id};
    commit(); fitView();
    toast(`Area “${ar.name}” created`);
  };
}

function openManageArea(){
  const a=state.areas[view.area]; if(!a) return;
  const nRooms=Object.values(state.rooms).filter(r=>r.area===a.id).length;
  const canDelete=Object.keys(state.areas).length>1;
  openModal(`<h2>Area settings</h2>
    <label class="fld">Area name</label>
    <input type="text" id="maName" maxlength="40">
    <div class="row" style="margin-top:14px">
      <button id="maDel" class="danger" ${canDelete?"":"disabled"}
        title="${canDelete?"Deletes the area, its "+nRooms+" rooms, and every exit touching them":"Can't delete the only area"}">
        Delete area (${nRooms} rooms)</button>
      <span class="spacer"></span>
      <button id="maCancel">Cancel</button>
      <button id="maOk" class="primary">Save</button></div>`);
  const nm=$("maName"); nm.value=a.name; nm.focus(); nm.select();
  nm.addEventListener("keydown",e=>{ if(e.key==="Enter") $("maOk").click(); });
  $("maCancel").onclick=closeModal;
  $("maOk").onclick=()=>{
    pushUndo(); a.name=nm.value.trim()||a.name; closeModal(); commit();
    enqueueLive(async()=>{ await api.patchArea(canon(a.id),{name:a.name}); });
  };
  $("maDel").onclick=()=>{
    if(!canDelete) return;
    const doomed=a.id, doomedName=a.name;
    pushUndo();
    Object.values(state.rooms).filter(r=>r.area===doomed).forEach(r=>deleteRoom(r.id,{silent:true}));
    for(const k in state.blocks) if(k.startsWith(doomed+":")) delete state.blocks[k];
    delete state.areas[doomed]; delete viewMem[doomed];
    view.area=Object.keys(state.areas)[0]; view.floor=0; sel=null;
    closeModal(); commit(); fitView();
    enqueueLive(async()=>{ await api.deleteArea(canon(doomed)); });
    toast(`Area “${doomedName}” deleted${liveEdit?"":" — Ctrl+Z to undo"}`);
  };
}

$("areaSel").addEventListener("change",e=>{
  const v=e.target.value;
  if(v==="__new"){ openNewArea(); renderAreaSel(); return; }
  const had=switchArea(v); sel=null; render();
  if(!had) fitView();
});
$("btnArea").onclick=openManageArea;

/* ---------- import / export ---------- */
function exportJSON(){
  return JSON.stringify({format:"mudmap",version:4,name:state.name,nextId:state.nextId,
    areas:Object.values(state.areas),
    rooms:Object.values(state.rooms),
    exits:Object.values(state.exits),
    edges:Object.values(state.edges),
    elevators:Object.values(state.elevators||{}),
    blocks:Object.keys(state.blocks).map(k=>parseBlockKey(k)).filter(Boolean)},null,2);
}
function parseImport(text){
  let d; try{ d=JSON.parse(text); }catch(e){ return null; }
  if(!d||typeof d!=="object") return null;
  const s=blankState();
  s.name=typeof d.name==="string"?d.name:"Imported Map";
  let maxN=0;
  // areas (absent in v1 files — a default is created for them below)
  const asArr=v=>Array.isArray(v)?v:(v&&typeof v==="object"?Object.values(v):[]);
  const areaArr=asArr(d.areas);
  for(const a of areaArr){
    if(a==null||typeof a!=="object") continue;
    const id=String(a.id??""); if(!id||s.areas[id]) continue;
    s.areas[id]={id,name:String(a.name??"Area")};
    const m=/^a(\d+)$/.exec(id); if(m) maxN=Math.max(maxN,+m[1]);
  }
  let defaultArea=null;
  const ensureDefault=()=>{
    if(!defaultArea){
      const id="a"+(++maxN);
      s.areas[id]={id,name:"Main"};
      defaultArea=id;
    }
    return defaultArea;
  };
  const rooms=asArr(d.rooms); const ids=new Set();
  for(const r of rooms){
    if(r==null||typeof r!=="object") continue;
    const id=String(r.id??("r"+(++maxN+10000)));
    if(![r.x,r.y,r.z].every(v=>Number.isFinite(Number(v)))) continue;
    if(ids.has(id)) continue; ids.add(id);
    const area=(typeof r.area==="string"&&s.areas[r.area])?r.area:ensureDefault();
    s.rooms[id]={id,area,x:Math.round(+r.x),y:Math.round(+r.y),z:Math.round(+r.z),
      name:String(r.name??""),color:typeof r.color==="string"?r.color:ROOM_COLORS[0],
      description:String(r.description??""),notes:String(r.notes??"")};
    const m=/^r(\d+)$/.exec(id); if(m) maxN=Math.max(maxN,+m[1]);
  }
  const exits=asArr(d.exits);
  for(const e of exits){
    if(e==null||typeof e!=="object") continue;
    const a=String(e.a??""), b=String(e.b??"");
    if(!s.rooms[a]||!s.rooms[b]||a===b) continue;
    const id=String(e.id??("e"+(++maxN)));
    const ex={id,a,b,type:EXIT_TYPES[e.type]?e.type:"open",
      hidden:!!e.hidden,dir:["both","ab","ba"].includes(e.dir)?e.dir:"both"};
    if(s.rooms[a].area!==s.rooms[b].area){
      ex.adir=DIRS[e.adir]?e.adir:"e";
      ex.bdir=DIRS[e.bdir]?e.bdir:OPPOSITE[ex.adir];
    }else{
      if(DIRS[e.adir]) ex.adir=e.adir;
      if(DIRS[e.bdir]) ex.bdir=e.bdir;
    }
    s.exits[id]=ex;
    const m=/^e(\d+)$/.exec(id); if(m) maxN=Math.max(maxN,+m[1]);
  }
  // edges (absent in v1/v2 files — safely skipped)
  const edgeArr=asArr(d.edges);
  for(const g of edgeArr){
    if(g==null||typeof g!=="object") continue;
    const from=String(g.from??""), suc=String(g.success??""), fal=String(g.fail??"");
    if(!s.rooms[from]||!s.rooms[suc]||!s.rooms[fal]) continue;
    const id=String(g.id??("j"+(++maxN)));
    if(s.edges[id]) continue;
    s.edges[id]={id,from,success:suc,fail:fal,
      dir:PLANAR.includes(g.dir)?g.dir:"n", hidden:!!g.hidden};
    const m=/^j(\d+)$/.exec(id); if(m) maxN=Math.max(maxN,+m[1]);
  }
  // blocks (absent in v1–v3 files — safely skipped)
  const blockArr=asArr(d.blocks);
  const roomCoords=new Set(Object.values(s.rooms).map(r=>key(r.area,r.x,r.y,r.z)));
  for(const b of blockArr){
    if(b==null||typeof b!=="object") continue;
    if(![b.x,b.y,b.z].every(v=>Number.isFinite(Number(v)))) continue;
    const area=(typeof b.area==="string"&&s.areas[b.area])?b.area:ensureDefault();
    const k=key(area,Math.round(+b.x),Math.round(+b.y),Math.round(+b.z));
    if(roomCoords.has(k)) continue;               // a room wins over a block
    s.blocks[k]=1;
  }
  // elevators: a carriage off the grid and its stops, top first (absent before elevators — skipped)
  for(const v of asArr(d.elevators)){
    if(v==null||typeof v!=="object") continue;
    const id=String(v.id??""); if(!id||s.elevators[id]) continue;
    const seen=new Set(), labels=new Set(), stops=[];
    for(const st of asArr(v.stops)){
      const room=String(st?.room??""), label=String(st?.label??"").trim().slice(0,16);
      if(!s.rooms[room]||seen.has(room)||!label||labels.has(label.toLowerCase())) continue;
      seen.add(room); labels.add(label.toLowerCase()); stops.push({label,room});
    }
    const secs=(n,dflt)=>Number.isInteger(n)&&n>=1&&n<=600?n:dflt;
    s.elevators[id]={id,name:String(v.name||"Elevator"),description:String(v.description??""),door:secs(v.door,8),travel:secs(v.travel,3),stops};
    const m=/^v(\d+)$/.exec(id); if(m) maxN=Math.max(maxN,+m[1]);
  }
  if(!Object.keys(s.areas).length) ensureDefault();
  s.nextId=Math.max(maxN+1, Number.isInteger(d.nextId)?d.nextId:1);
  return Object.keys(s.rooms).length||rooms.length===0 ? s : null;
}

function openHelp(){
  openModal(`<h2>Shortcuts & legend</h2>
   <div class="cheat" style="margin-bottom:14px">
    <span><span class="kbd">dbl-click</span> empty cell</span><span>create a room there</span>
    <span><span class="kbd">click</span> room / exit line</span><span>select & edit in the side panel</span>
    <span><span class="kbd">dbl-click</span> room</span><span>rename it</span>
    <span><span class="kbd">drag</span> room</span><span>move it to another cell</span>
    <span><span class="kbd">drag</span> amber dot</span><span>draw an exit (drop on empty cell = new room)</span>
    <span><span class="kbd">↑↓←→</span> / numpad <span class="kbd">1–9</span></span><span>dig or walk from the selected room (numpad does diagonals)</span>
    <span><span class="kbd">shift</span> + direction</span><span>move selection without digging</span>
    <span><span class="kbd">U</span> / <span class="kbd">D</span></span><span>dig up / down a floor</span>
    <span>hold <span class="kbd">U</span> / <span class="kbd">D</span> + direction</span><span>dig a slope: up or down a floor <i>and</i> one step across (U+↑ is northup, D+← westdown)</span>
    <span><span class="kbd">Shift</span>+<span class="kbd">U</span> / <span class="kbd">D</span></span><span>shift the selected room a floor up / down — all its exits and edges stay connected</span>
    <span><span class="kbd">J</span></span><span>add a jumpable edge from the selected room (success room + fixed failure landing)</span>
    <span><span class="kbd">A</span></span><span>dig into a brand-new area from the selected room</span>
    <span><span class="kbd">L</span></span><span>link the selected room to a room in another area</span>
    <span><span class="kbd">B</span></span><span>block-out mode — drag to paint solid, impassable cells (drag from a block to erase); rooms can't be placed or dug there</span>
    <span><span class="kbd">PgUp</span> / <span class="kbd">PgDn</span></span><span>view another floor</span>
    <span><span class="kbd">Enter</span></span><span>rename the selected room</span>
    <span><span class="kbd">Del</span></span><span>delete the selection</span>
    <span><span class="kbd">Ctrl</span>+<span class="kbd">Z</span> / <span class="kbd">Shift</span>+<span class="kbd">Z</span></span><span>undo / redo</span>
    <span><span class="kbd">Ctrl</span>+<span class="kbd">S</span></span><span>save now (it saves to Thetis as you edit anyway)</span>
    <span><span class="kbd">F</span></span><span>fit map to view</span>
    <span><span class="kbd">Esc</span></span><span>deselect</span>
   </div>
   <h2>Exit legend</h2><div class="legend" style="margin-bottom:14px">${legendHTML()}</div>
   <p class="hint">▲▼ marks on a room are up/down exits — click one to edit it. A slope (northup, southwestdown …) also has a short dashed arrow pointing the way it goes; double-click it to follow it to the other floor. Exits to <b style="color:var(--ink)">other areas</b> show as a stub ending in a dashed tag with the destination area's name (a dashed ring around ▲▼ means an up/down area portal). Click a tag to edit the link, double-click to travel through it — direction keys also walk straight through portals. Each area has its own grid, floors, and view; switch areas with the dropdown in the toolbar. The fastest way to map while you play: select your starting room and just press direction keys as you walk.</p>
   <div class="row"><span class="spacer"></span><button id="hClose" class="primary">Got it</button></div>`);
  $("hClose").onclick=closeModal;
}

function openModal(html){ $("modal").innerHTML=html; $("modalBack").classList.add("open"); }
function closeModal(){ $("modalBack").classList.remove("open"); }
$("modalBack").addEventListener("click",ev=>{ if(ev.target.id==="modalBack") closeModal(); });

/* ---------- toasts ---------- */
let toastTimers=[];
function toast(msg,kind){
  const t=document.createElement("div"); t.className="toast"+(kind==="err"?" err":"");
  t.textContent=msg; $("toasts").appendChild(t);
  const fade=setTimeout(()=>{ t.style.opacity="0"; t.style.transition="opacity .3s"; },1700);
  const drop=setTimeout(()=>{ t.remove();
    toastTimers=toastTimers.filter(id=>id!==fade&&id!==drop); },2100);
  toastTimers.push(fade,drop);
}

/* ---------- glow filter ---------- */
(function(){
  const defs=el("defs");
  defs.innerHTML=`<filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
    <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#f6b73c" flood-opacity="0.55"/>
  </filter>
  <pattern id="hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="9" stroke="#2b3444" stroke-width="1.6"/>
  </pattern>`;
  svg.insertBefore(defs,vp);
})();

/* ---------- game snapshot ---------- */
/* The map document arrives in the shape parseImport already reads; see
   docs/netsat-mapper-interface.md. */
function stateFromMap(doc){
  if(!doc) return null;
  try{ return parseImport(JSON.stringify(doc)); }catch(e){ return null; }
}
function adoptState(s){
  state=s; sel=null; viewMem={};
  view.area=Object.keys(state.areas)[0];
  view.floor=defaultFloor(view.area);
  commit(); fitView();
}
$("btnReload").onclick=()=>{
  if(typeof options.reload!=="function") return;
  openModal(`<h2>Reload the map?</h2>
    <p class="hint">The map is read again as Thetis has it saved, with whatever the agent or another tab changed. Undo can bring this view back during this session.</p>
    <div class="row"><span class="spacer"></span>
      <button id="rlCancel">Cancel</button>
      <button id="rlOk" class="primary">Reload</button></div>`);
  $("rlCancel").onclick=closeModal;
  $("rlOk").onclick=async()=>{
    const btn=$("rlOk"); btn.disabled=true; btn.textContent="Loading…";
    let doc=null;
    try{ doc=await options.reload(); }catch(e){ doc=null; }
    const s=stateFromMap(doc);
    if(!s){ closeModal(); toast("The map could not be read again — kept as it is","err"); return; }
    pushUndo(); clearDraft(); adoptState(s); closeModal();
    toast(`Reloaded: ${Object.keys(state.rooms).length} rooms`);
  };
};

/* ---------- boot ---------- */
(function boot(){
  const saved=tryLoad();
  const live=saved?null:stateFromMap(options.map);
  if(saved){ state=saved; view.area=Object.keys(state.areas)[0]; toast("Local draft restored — Reload for the live map"); }
  else if(live){ state=live; view.area=Object.keys(state.areas)[0];
    view.floor=defaultFloor(view.area);
  }
  else{
    state=blankState();
    const ar=createArea("Main");
    const r=createRoom(0,0,0,"Start",ar.id);
    view.area=ar.id;
    sel={kind:"room",id:r.id};
  }
  rebuildIdx();
  const rect=svg.getBoundingClientRect();
  view.panX=rect.width/2; view.panY=rect.height/2;
  applyView(); render(); fitView(); syncUndoBtns();
  bind(window,"resize",applyView);
})();

function destroy(){
  clearTimeout(saveTimer);
  clearTimeout(mapNameTimer);
  Object.keys(roomPatchTimers).forEach(k=>clearTimeout(roomPatchTimers[k]));
  cancelLongPress();
  toastTimers.forEach(clearTimeout);
  toastTimers.length=0;
  teardown.forEach(off=>off());
  teardown.length=0;
}

/* The host page hands in the map as it now is on disk (another writer: the agent, another tab). It
   replaces the state, keeps the view and the selection where they still make sense, and is undoable. */
function load(doc,{undoable=true,message}={}){
  const s=stateFromMap(doc); if(!s) return false;
  clearTimeout(saveTimer); saveTimer=null;
  if(undoable) pushUndo();
  else { undoStack.length=0; redoStack.length=0; syncUndoBtns(); } // a snapshot from before would undo the other writer's work too
  state=s;
  if(!state.areas[view.area]){ view.area=Object.keys(state.areas)[0]; view.floor=defaultFloor(view.area); }
  if(sel){ const bag=sel.kind==="room"?state.rooms:sel.kind==="exit"?state.exits:sel.kind==="elevator"?state.elevators:state.edges; if(!bag[sel.id]) sel=null; }
  rebuildIdx(); render();
  if(message) toast(message);
  return true;
}
function selectRoom(id){
  const r=state.rooms[id]; if(!r) return false;
  if(r.area!==view.area) switchArea(r.area);
  view.floor=r.z; sel={kind:"room",id}; render(); ensureVisible(r); return true;
}
  return { destroy, load, flush:flushSave, status:renderStatus, selectRoom, toast, fit:fitView, current:()=>JSON.parse(exportJSON()) };
}

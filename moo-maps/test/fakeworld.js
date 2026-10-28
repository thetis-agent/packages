// An in-memory world that answers snapshot and runs ops the way lib/moo.js's MOO programs do, so publish,
// pull and import are tested end to end without a server. It mirrors the MOO's observable rules: one room
// per cell, a cell blocked out refuses a room, exits are twinned pairs named by long direction, a side
// already used refuses a second exit, a lockless "locked" reads back as door and "special" as open.

const LONG = { n: "north", ne: "northeast", e: "east", se: "southeast", s: "south", sw: "southwest", w: "west", nw: "northwest", up: "up", down: "down" };
const READS = { open: "open", door: "door", locked: "door", climb: "climb", swim: "swim", special: "open" };

export function fakeWorld() {
  let n = 1000;
  const W = { areas: new Map(), rooms: new Map(), exits: new Map(), edges: new Map(), cars: new Map(), elevatorApi: true, calls: [], fail: null };
  const id = () => `#${n++}`;
  const err = (m) => { throw new Error(m); };

  W.addArea = (name) => { const a = id(); W.areas.set(a, { name, rooms: [], blocks: [] }); return a; };
  W.addRoom = (area, x, y, z, name, description = "") => {
    const r = id();
    W.rooms.set(r, { area, x, y, z, name, description, exits: [], edges: [], players: 0 });
    W.areas.get(area).rooms.push(r);
    return r;
  };
  W.join = (a, b, adir, bdir, type = "open") => {
    const e1 = id(), e2 = id();
    W.exits.set(e1, { loc: a, twin: e2, dir: LONG[adir], type: READS[type], hidden: 0 });
    W.exits.set(e2, { loc: b, twin: e1, dir: LONG[bdir], type: READS[type], hidden: 0 });
    W.rooms.get(a).exits.push(e1);
    W.rooms.get(b).exits.push(e2);
    return e1 < e2 ? e1 : e2;
  };
  W.removeRoom = (r) => {
    const room = W.rooms.get(r);
    for (const e of [...room.exits]) W.unjoin(e);
    for (const g of room.edges) W.edges.delete(g);
    for (const c of W.cars.values()) c.stops = c.stops.filter((x) => x.room !== r);
    const a = W.areas.get(room.area);
    a.rooms = a.rooms.filter((x) => x !== r);
    W.rooms.delete(r);
    for (const [g, edge] of W.edges) if (edge.success === r || edge.fail === r) { W.rooms.get(edge.loc).edges = W.rooms.get(edge.loc).edges.filter((x) => x !== g); W.edges.delete(g); }
  };
  W.unjoin = (e) => {
    const x = W.exits.get(e);
    if (!x) return;
    const t = W.exits.get(x.twin);
    W.rooms.get(x.loc).exits = W.rooms.get(x.loc).exits.filter((y) => y !== e);
    if (t) W.rooms.get(t.loc).exits = W.rooms.get(t.loc).exits.filter((y) => y !== x.twin);
    W.exits.delete(e);
    W.exits.delete(x.twin);
  };
  const cellTaken = (area, x, y, z, mover) => {
    for (const r of W.areas.get(area).rooms) { const o = W.rooms.get(r); if (o.x === x && o.y === y && o.z === z && r !== mover) return "Another room already occupies that cell."; }
    if (W.areas.get(area).blocks.some((b) => b[0] === x && b[1] === y && b[2] === z)) return "That cell is blocked out.";
    return null;
  };
  const between = (a, b) => W.rooms.get(a).exits.find((e) => W.exits.get(W.exits.get(e).twin)?.loc === b);
  const room = (r, allowed) => {
    const o = W.rooms.get(r);
    if (!o) err(`room ${r} is gone`);
    if (!allowed.includes(o.area)) err(`room ${r} is not in one of this map's areas, so the map does not touch it.`);
    return o;
  };

  // Elevators per plans/elevators-app.md: a $elevator carriage off the grid, a one-sided `in` ($elevator_lobby_exit,
  // its .carriage the car) in each lobby.
  const carSpec = (c) => ({ name: c.name, description: c.description, door: c.door, travel: c.travel, stops: c.stops.map((x) => [x.label, x.room]) });
  const setCar = (car, op, allowed) => {
    const c = W.cars.get(car);
    for (const x of op.stops) room(x.room, allowed);
    for (const x of c.stops) if (!op.stops.some((y) => y.room === x.room)) { W.rooms.get(x.room).exits = W.rooms.get(x.room).exits.filter((e) => e !== x.exit); W.exits.delete(x.exit); }
    c.stops = op.stops.map((y) => {
      const had = c.stops.find((x) => x.room === y.room);
      if (had) return { ...had, label: y.label };
      const e = id(); W.exits.set(e, { loc: y.room, twin: "#-1", dir: "in", type: "open", hidden: 0, carriage: car }); W.rooms.get(y.room).exits.push(e);
      return { label: y.label, room: y.room, exit: e };
    });
    Object.assign(c, { name: op.name, description: op.description, door: op.door, travel: op.travel });
  };
  const needApi = () => { if (!W.elevatorApi) err("the MOO has no elevator system yet ($elevator:mapper_set)"); };

  W.snapshot = async (_conn, ids, carriages = []) => {
    W.calls.push({ snapshot: ids });
    const cars = new Set(W.elevatorApi ? carriages.filter((c) => W.cars.has(c)) : []);
    for (const a of ids) for (const r of W.areas.get(a)?.rooms ?? []) for (const e of W.rooms.get(r).exits) { const x = W.exits.get(e); if (x.carriage && W.elevatorApi) cars.add(x.carriage); }
    return {
      character: "#9", shaper: 1, elevator_api: W.elevatorApi ? 1 : 0,
      elevators: [...cars].map((c) => ({ id: c, ...carSpec(W.cars.get(c)) })),
      carriages_gone: carriages.filter((c) => !W.cars.has(c)),
      areas: ids.map((a) => {
        const area = W.areas.get(a);
        if (!area) return { id: a, missing: 1 };
        return {
          id: a, name: area.name, blocks: area.blocks.map((b) => [...b]),
          rooms: area.rooms.map((r) => {
            const o = W.rooms.get(r);
            return {
              id: r, x: o.x, y: o.y, z: o.z, name: o.name, description: o.description, players: o.players,
              exits: o.exits.filter((e) => !(W.elevatorApi && W.exits.get(e).carriage)).map((e) => {
                const x = W.exits.get(e), t = W.exits.get(x.twin), d = t ? t.loc : "#-1", dr = W.rooms.get(d);
                return { id: e, twin: x.twin, to: d, to_name: dr?.name ?? "", to_area: dr?.area ?? "#-1", to_area_name: dr ? W.areas.get(dr.area).name : "", dir: x.dir, type: x.type, hidden: x.hidden };
              }),
              edges: o.edges.map((g) => { const x = W.edges.get(g); return { id: g, dir: x.dir, success: x.success, fail: x.fail, hidden: x.hidden }; }),
            };
          }),
        };
      }),
    };
  };

  const OPS = {
    area_create: (op, allowed) => { const a = W.addArea(op.name); allowed.push(a); return a; },
    area_rename: (op, allowed) => { if (!allowed.includes(op.area)) err("that area is not one of this map's"); W.areas.get(op.area).name = op.name; return op.area; },
    room_create: (op, allowed) => {
      if (!allowed.includes(op.area)) err("that area is not one of this map's");
      const c = cellTaken(op.area, op.x, op.y, op.z, null); if (c) err(c);
      return W.addRoom(op.area, op.x, op.y, op.z, op.name, op.description ?? "");
    },
    room_update: (op, allowed) => { const o = room(op.room, allowed); if (op.name !== undefined) o.name = op.name; if (op.description !== undefined) o.description = op.description; return op.room; },
    room_move: (op, allowed) => {
      const o = room(op.room, allowed);
      if (!allowed.includes(op.area)) err("that area is not one of this map's");
      const c = cellTaken(op.area, op.x, op.y, op.z, op.room); if (c) err(c);
      if (op.area !== o.area) { const a = W.areas.get(o.area); a.rooms = a.rooms.filter((x) => x !== op.room); W.areas.get(op.area).rooms.push(op.room); o.area = op.area; }
      Object.assign(o, { x: op.x, y: op.y, z: op.z });
      return op.room;
    },
    room_delete: (op, allowed) => { const o = room(op.room, allowed); if (o.players && !op.force) err(`${o.name} has a player in it`); W.removeRoom(op.room); return op.room; },
    exit_create: (op, allowed) => {
      const a = room(op.a, allowed), b = room(op.b, allowed);
      if (between(op.a, op.b)) err("already joined");
      for (const [r, d] of [[a, op.adir], [b, op.bdir]]) if (r.exits.some((e) => W.exits.get(e).dir === LONG[d])) err(`${r.name} already has a ${LONG[d]} exit`);
      const e = W.join(op.a, op.b, op.adir, op.bdir, op.type);
      if (op.hidden) { W.exits.get(e).hidden = 1; W.exits.get(W.exits.get(e).twin).hidden = 1; }
      return e;
    },
    exit_update: (op, allowed) => {
      const x = W.exits.get(op.exit); if (!x) err(`exit ${op.exit} is gone or has lost its twin`);
      const t = W.exits.get(x.twin); room(x.loc, allowed); room(t.loc, allowed);
      const sa = x.loc === op.a ? x : t, sb = sa === x ? t : x;
      if (op.type !== undefined) { sa.type = READS[op.type]; sb.type = READS[op.type]; }
      if (op.hidden !== undefined) { sa.hidden = op.hidden ? 1 : 0; sb.hidden = sa.hidden; }
      if (op.adir) sa.dir = LONG[op.adir];
      if (op.bdir) sb.dir = LONG[op.bdir];
      return op.exit < x.twin ? op.exit : x.twin;
    },
    exit_delete: (op, allowed) => { const x = W.exits.get(op.exit); if (!x) err(`exit ${op.exit} is gone or has lost its twin`); room(x.loc, allowed); W.unjoin(op.exit); return op.exit; },
    edge_create: (op, allowed) => {
      const f = room(op.from, allowed); room(op.success, allowed); room(op.fail, allowed);
      const g = id(); W.edges.set(g, { loc: op.from, dir: op.dir, success: op.success, fail: op.fail, hidden: op.hidden ? 1 : 0 }); f.edges.push(g); return g;
    },
    edge_update: (op) => { const g = W.edges.get(op.edge); if (!g) err("gone"); for (const k of ["dir", "success", "fail"]) if (op[k] !== undefined) g[k] = op[k]; if (op.hidden !== undefined) g.hidden = op.hidden ? 1 : 0; return op.edge; },
    edge_delete: (op) => { const g = W.edges.get(op.edge); if (!g) err("gone"); const r = W.rooms.get(g.loc); r.edges = r.edges.filter((x) => x !== op.edge); W.edges.delete(op.edge); return op.edge; },
    elevator_create: (op, allowed) => { needApi(); const c = id(); W.cars.set(c, { stops: [] }); setCar(c, op, allowed); return c; },
    elevator_update: (op, allowed) => { needApi(); if (!W.cars.has(op.elevator)) err(`carriage ${op.elevator} is gone`); setCar(op.elevator, op, allowed); return op.elevator; },
    elevator_delete: (op) => { needApi(); const c = W.cars.get(op.elevator); if (c) { for (const x of c.stops) { const r = W.rooms.get(x.room); if (r) r.exits = r.exits.filter((e) => e !== x.exit); W.exits.delete(x.exit); } W.cars.delete(op.elevator); } return op.elevator; },
    block_add: (op, allowed) => { if (!allowed.includes(op.area)) err("not this map's"); const a = W.areas.get(op.area); if (!a.blocks.some((b) => b[0] === op.x && b[1] === op.y && b[2] === op.z)) a.blocks.push([op.x, op.y, op.z]); return 1; },
    block_remove: (op, allowed) => { if (!allowed.includes(op.area)) err("not this map's"); const a = W.areas.get(op.area); a.blocks = a.blocks.filter((b) => !(b[0] === op.x && b[1] === op.y && b[2] === op.z)); return 1; },
  };

  W.runOps = async (_conn, areas, ops) => {
    const allowed = areas.filter((a) => W.areas.has(a));
    W.calls.push({ ops: ops.map((o) => o.op) });
    return ops.map((op) => {
      try {
        if (W.fail && W.fail(op)) err("simulated failure");
        return { ok: 1, value: OPS[op.op](op, allowed) };
      } catch (e) {
        return { ok: 0, error: e.message };
      }
    });
  };
  W.connect = async () => ({ fake: true });
  W.listAreas = async () => ({ character: "#9", character_name: "Zero", shaper: 1, areas: [...W.areas].map(([id, a]) => ({ id, name: a.name, rooms: a.rooms.length, yours: 0 })) });
  W.roomAt = (area, x, y, z) => [...W.rooms].find(([, r]) => r.area === area && r.x === x && r.y === y && r.z === z)?.[0];
  W.exitDirs = (r) => W.rooms.get(r).exits.map((e) => W.exits.get(e).dir).sort();
  return W;
}

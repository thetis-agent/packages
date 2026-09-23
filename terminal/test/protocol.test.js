import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { connect } from "../lib/client.js";
import { startHost, SOCKET } from "../lib/host.js";

async function fragmented(socket, message) {
  const bytes = Buffer.from(JSON.stringify(message) + "\n");
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  socket.write(bytes.subarray(0, split));
  await new Promise((done) => setTimeout(done, 20));
  socket.write(bytes.subarray(split));
}

test("the terminal client preserves a Unicode character split between socket chunks", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "thetis-protocol-"));
  await mkdir(resolve(root, "run"));
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => void fragmented(socket, { i: 1, ok: true, result: { output: "café" } }));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(resolve(root, "run", SOCKET));
  await once(server, "listening");
  const client = await connect(root);
  t.after(() => client.close());
  assert.deepEqual(await client.request("read"), { output: "café" });
});

test("the terminal host preserves Unicode input split between socket chunks", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "thetis-protocol-"));
  const host = await startHost({ root, cwd: root });
  t.after(async () => { await host.stop(); await rm(root, { recursive: true, force: true }); });
  const socket = createConnection(host.socket);
  t.after(() => socket.destroy());
  socket.setEncoding("utf8");
  await once(socket, "connect");
  const reply = once(socket, "data");
  await fragmented(socket, { i: 1, op: "open", name: "café" });
  const [line] = await reply;
  assert.equal(JSON.parse(line).result.name, "café");
});

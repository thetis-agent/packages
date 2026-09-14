// A request/reply server and client over a Unix socket, speaking the frames of `rpc-frames`.
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { callHandler, encodeFrame, PendingCalls, readFrames, type ReplyFrame, type RpcHandler } from "./rpc-frames.js";

/** Serves one handler to every client of a Unix socket. Access is by file permission: the socket is mode 0600. */
export class RpcSocketServer {
  private server?: Server;

  constructor(
    private readonly path: string,
    private readonly handler: RpcHandler,
    private readonly log: (line: string) => void = () => {},
  ) {}

  async listen(): Promise<void> {
    if (existsSync(this.path)) unlinkSync(this.path);
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((done, fail) => server.once("error", fail).listen(this.path, done));
    chmodSync(this.path, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((done) => server.close(() => done()));
    if (existsSync(this.path)) unlinkSync(this.path);
  }

  private serve(socket: Socket): void {
    const write = (msg: unknown) => socket.writable && socket.write(encodeFrame(msg));
    readFrames(socket, (msg) => {
      const id = String(msg.id);
      void callHandler(this.handler, String(msg.method), msg.args, (event) => write({ id, event })).then((outcome) => write({ id, ...outcome }));
    });
    socket.on("error", (err) => this.log(`[socket] ${err.message}`));
  }
}

export interface RpcSocketClient {
  call: RpcHandler;
  close(): void;
}

/** Connects to a server. Resolves undefined when there is none (no socket file, or a stale one). */
export function connectRpcSocket(path: string): Promise<RpcSocketClient | undefined> {
  if (!existsSync(path)) return Promise.resolve(undefined);
  return new Promise((done) => {
    const socket = createConnection(path);
    const pending = new PendingCalls("c");
    socket.once("error", () => done(undefined));
    socket.once("connect", () => {
      readFrames(socket, (msg) => void pending.receive(msg as unknown as ReplyFrame));
      socket.on("close", () => pending.failAll(new Error("the server closed the connection")));
      done({
        call: (method, args, emit) => {
          const { id, result } = pending.open({ onEvent: emit });
          socket.write(encodeFrame({ id, method, args }));
          return result;
        },
        close: () => socket.end(),
      });
    });
  });
}

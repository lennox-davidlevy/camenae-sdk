import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { Bob } from "../../src/sdk/index.js";
import { readBootstrap } from "../../src/client/socket-bootstrap.js";

const directories: string[] = [];

const sockets: Socket[] = [];

const controllers: AbortController[] = [];

const workers: Promise<void>[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();

  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(workers.splice(0));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "gw-socket-"));
  directories.push(path);

  return path;
}

async function worker() {
  const workspace = await directory();
  const socketPath = join(workspace, "s");
  const controller = new AbortController();
  controllers.push(controller);
  const finished = Bob.serveOnce({ socketPath, workspace, signal: controller.signal });
  // Expected rejection remains observable by the test without an unhandled rejection.
  void finished.catch(() => {});
  workers.push(finished);
  await expect.poll(() => stat(socketPath).then(() => true, () => false)).toBe(true);

  return { workspace, socketPath, finished, controller };
}

function socket(path: string) {
  const connection = createConnection(path);
  connection.on("error", () => {});
  sockets.push(connection);

  return connection;
}

describe("isolated SDK transport", () => {
  it("keeps fragmented bootstrap and coalesced ACP bytes separate", async () => {
    const path = join(await directory(), "s");
    const observed = Promise.withResolvers<void>();

    const server = createServer((peer) => {
      sockets.push(peer);
      peer.write('{"ver');
      void observed.promise.then(() => peer.end('sion":1,"status":"ready"}\n{"jsonrpc":"2.0","id":1}\n'));
    });

    await new Promise<void>((resolve) => server.listen(path, resolve));
    const connection = socket(path);
    connection.once("data", () => observed.resolve());

    try {
      expect(JSON.parse((await readBootstrap(connection)).toString())).toEqual({ version: 1, status: "ready" });
      const remainder: Buffer[] = [];

      for await (const chunk of connection) remainder.push(chunk);
      expect(Buffer.concat(remainder).toString()).toBe('{"jsonrpc":"2.0","id":1}\n');
    } finally { server.close(); }
  });

  it("rejects a competing client during bootstrap without taking over the listener", async () => {
    const running = await worker();
    const first = socket(running.socketPath);
    await new Promise<void>((resolve) => first.once("connect", resolve));
    await expect(Bob.connect({ socketPath: running.socketPath, workspace: running.workspace,
      credential: { kind: "apiKey", apiKey: "synthetic-never-used" } })).rejects.toMatchObject({ code: "busy" });
    // A rejected peer may read the reply but never close its sending side.
    // It must not keep the one-connection worker alive after the owner exits.
    const lingering = createConnection({ path: running.socketPath, allowHalfOpen: true });
    lingering.on("error", () => {});
    sockets.push(lingering);
    expect(JSON.parse((await readBootstrap(lingering)).toString())).toEqual({ version: 1, status: "busy" });
    lingering.resume();
    first.destroy();
    await expect(running.finished).rejects.toMatchObject({ code: "startup_failed" });
    await expect(stat(running.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["oversized", "malformed", "wrong-version", "sso-with-key", "unknown-credential", "v1-sso"])("rejects %s bootstrap", async (kind) => {
    const running = await worker();
    const connection = socket(running.socketPath);

    const payload = kind === "oversized" ? "x".repeat(16 * 1024 + 1) : kind === "malformed" ? "{\n" :
      JSON.stringify({ workspace: running.workspace, ...(kind === "sso-with-key" ? { version: 2, credential: { kind: "sso" }, apiKey: "synthetic" }
        : kind === "unknown-credential" ? { version: 2, credential: { kind: "unknown" } }
        : kind === "v1-sso" ? { version: 1, credential: { kind: "sso" }, apiKey: "synthetic" }
        : { version: 3, apiKey: "synthetic" }) }) + "\n";

    connection.write(payload);
    await expect(running.finished).rejects.toMatchObject({ code: "startup_failed" });
  });

  it("never downgrades explicit SSO when a peer answers with the old bootstrap version", async () => {
    const path = join(await directory(), "s");
    const received = Promise.withResolvers<unknown>();
    let initialized = false;

    const server = createServer((peer) => {
      sockets.push(peer);
      peer.on("error", () => {});
      void readBootstrap(peer).then((hello) => {
        received.resolve(JSON.parse(hello.toString()));
        peer.write('{"version":1,"status":"ready"}\n');
        // A fully usable ACP peer would let a missing version guard succeed.
        new AgentSideConnection(() => ({
          initialize: async () => {
            initialized = true;

            return { protocolVersion: 1, agentInfo: { name: "bob-shell", version: "2.0.5" } };
          },
          authenticate: async () => ({}),
          newSession: async () => ({ sessionId: "unexpected" }),
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
        }), ndJsonStream(Writable.toWeb(peer), Readable.toWeb(peer)));
      });
    });

    await new Promise<void>((resolve) => server.listen(path, resolve));

    try {
      await expect(Bob.connect({ socketPath: path, workspace: "/worker", credential: { kind: "sso" } }))
        .rejects.toMatchObject({ code: "startup_failed" });
      expect(await received.promise).toEqual({ version: 2, workspace: "/worker", credential: { kind: "sso" } });
      expect(initialized).toBe(false);
    } finally { server.close(); }
  });

  it("bounds a stalled bootstrap and releases its listener", async () => {
    const running = await worker();
    socket(running.socketPath);
    await expect(running.finished).rejects.toMatchObject({ code: "startup_failed" });
    await expect(stat(running.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 8_000);

  it("does not unlink an occupied socket or require the worker workspace locally", async () => {
    const path = join(await directory(), "s");
    const remoteWorkspace = "/worker-only/not-present-on-the-client";

    const server = createServer((peer) => {
      sockets.push(peer);
      peer.on("error", () => {});
      void (async () => {
        const hello = JSON.parse((await readBootstrap(peer)).toString());
        expect(hello.workspace).toBe(remoteWorkspace);
        expect(hello.apiKey).toBe("synthetic-never-used");
        peer.write('{"version":1,"status":"ready"}\n');
        // Official ACP supplies framing; the peer defines only observable responses.
        new AgentSideConnection(() => ({
          initialize: async () => ({ protocolVersion: 1, agentInfo: { name: "bob-shell", version: "2.0.5" } }),
          authenticate: async () => ({}),
          newSession: async ({ cwd }) => ({ sessionId: cwd === remoteWorkspace ? "native-session" : "wrong-workspace" }),
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
        }), ndJsonStream(Writable.toWeb(peer), Readable.toWeb(peer)));
      })().catch(() => peer.destroy());
    });

    await new Promise<void>((resolve) => server.listen(path, resolve));
    const controller = new AbortController();

    try {
      await expect(Bob.serveOnce({ socketPath: path, workspace: process.cwd(), signal: controller.signal }))
        .rejects.toMatchObject({ code: "startup_failed" });

      const client = await Bob.connect({ socketPath: path, workspace: remoteWorkspace,
        credential: { kind: "apiKey", apiKey: "synthetic-never-used" } });

      expect((await client.newSession()).sessionId).toBe("native-session");
      await client.disconnect();
      expect("close" in client).toBe(false);
    } finally {
      controller.abort();
      server.close();
    }
  });
});

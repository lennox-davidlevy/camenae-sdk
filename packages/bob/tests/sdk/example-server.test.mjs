import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { startBobServer } from "../../examples/interactive-server.mjs";

it("retains capacity and awaits a deleting client during server shutdown", async () => {
  let release;
  const pendingClose = new Promise((resolve) => { release = resolve; });

  const client = {
    newSession: async () => ({ sessionId: "native-session" }),
    subscribe: () => () => {},
    close: vi.fn(() => pendingClose),
  };

  const server = await startBobServer({ workspace: process.cwd(), apiKey: "fixture", token: "fixture", maxClients: 1, createClient: async () => client });
  const headers = { authorization: "Bearer fixture" };
  let deletion;
  let shutdown;

  try {
    expect((await fetch(`${server.url}/sessions`, { method: "POST", headers })).status).toBe(201);
    deletion = fetch(`${server.url}/sessions/native-session`, { method: "DELETE", headers });
    await vi.waitFor(() => expect(client.close).toHaveBeenCalled());
    expect((await fetch(`${server.url}/sessions`, { method: "POST", headers })).status).toBe(503);
    let stopped = false;
    shutdown = server.close().then(() => { stopped = true; });
    await setImmediate();
    expect(stopped).toBe(false);
    release();
    await shutdown;
    expect(stopped).toBe(true);
  } finally {
    release();
    await Promise.allSettled([deletion, shutdown, server.close()]);
  }
});

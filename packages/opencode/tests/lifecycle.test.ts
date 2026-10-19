import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, request as forward } from "node:http";
import { Schema } from "effect";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { OpenCode } from "../src/index.js";

test("native preflight cancellation, streaming, session retention and saved-grant refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "camenae-native-"));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(socket.address());
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  await mkdir(join(root, "workspace"));

  const worker = spawn(process.execPath, [new URL("./native-worker.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), TEST_PORT: String(address.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exit = once(worker, "exit");
  let diagnostics = "";
  worker.stderr.on("data", (chunk) => { diagnostics += String(chunk); });

  try {
    await Promise.race([once(worker.stdout, "data"), exit.then(() => { throw new Error(`Native worker startup failed: ${diagnostics}`); })]);
    const options = { baseUrl: `http://127.0.0.1:${address.port}`, password: "synthetic-only", workspace: join(root, "workspace"), model: { providerID: "fixture", id: "fixture" } };
    let held: (() => void) | undefined;
    let reached: (() => void) | undefined;
    const preflight = new Promise<void>((resolve) => { reached = resolve; });
    let hold = false;

    const proxy = createServer((request, response) => {
      const dispatch = () => {
        const upstream = forward(options.baseUrl + request.url, { method: request.method, headers: request.headers }, (incoming) => {
          response.writeHead(incoming.statusCode ?? 500, incoming.headers);
          incoming.pipe(response);
        });

        request.pipe(upstream);
      };

      if (hold && request.url?.startsWith("/api/permission/saved")) {
        held = dispatch;
        reached?.();
      } else dispatch();
    });

    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(proxy.address());
    const client = await OpenCode.connect({ ...options, baseUrl: `http://127.0.0.1:${proxyAddress.port}` });

    try {
      const sessionID = await client.openSession();
      hold = true;
      const cancelled = client.run(sessionID, "Must never be submitted");
      await preflight;
      await client.cancel(sessionID);
      hold = false;
      held?.();
      expect(await cancelled).toBe("cancelled");
      expect(await client.native.session.context({ sessionID })).toHaveLength(0);
      let text = "";
      client.subscribe((event) => {
        if (event.type === "session.text.delta") text += event.data.delta;
      });
      expect(await client.run(sessionID, "Synthetic input")).toBe("completed");
      expect(text).toBe("fixture answer");
      expect(await client.openSession(sessionID)).toBe(sessionID);
      const request = client.native.permission.create({ sessionID, action: "shell", resources: ["fixture"], save: ["*"] });
      let pending = await client.native.permission.list({ sessionID });

      for (let attempt = 0; !pending.length && attempt < 100; attempt++) {
        await delay(10);
        pending = await client.native.permission.list({ sessionID });
      }

      expect(pending).toHaveLength(1);
      await client.native.permission.reply({ sessionID, requestID: pending[0].id, decision: "always" });
      await request;
      await expect(client.openSession(sessionID)).rejects.toThrow("saved approvals");
      // Refusal must not delete caller-owned approval state.
      const session = await client.native.session.get({ sessionID });
      expect(await client.native.permission.saved.list({ projectID: session.projectID })).toHaveLength(1);
    } finally { await client.close(); proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
  } finally {
    worker.kill("SIGTERM");
    const escalation = setTimeout(() => worker.kill("SIGKILL"), 5000);
    await exit;
    clearTimeout(escalation);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

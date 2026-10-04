// A separate SDK consumer, not a production server or part of the SDK runtime.
// Every Bob operation below uses the public package API.
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function startBobServer({ workspace, apiKey, token, environment, autoApprove = false, maxClients = 4, createClient = startNativeClient }) {
  if (!apiKey?.trim() || !token?.trim() || !Number.isInteger(maxClients) || maxClients < 1) throw new Error("Server configuration is incomplete");
  const sessions = new Map(); // Native Bob IDs, never replacement server session IDs.
  const starting = new Set();
  let closing = false;
  let closePromise;
  const server = createServer((request, response) => { void route(request, response).catch(() => json(response, 500, { error: "operation_failed" })); });

  async function route(request, response) {
    if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" });

    if (closing) return json(response, 503, { error: "closing" });
    const parts = new URL(request.url, "http://127.0.0.1").pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (request.method === "POST" && parts.length === 1 && parts[0] === "sessions") {
      if (sessions.size + starting.size >= maxClients) return json(response, 503, { error: "capacity" });
      const operation = createSession();
      starting.add(operation);

      try { return json(response, 201, { sessionId: await operation }); }
      finally { starting.delete(operation); }
    }

    if (parts[0] !== "sessions") return json(response, 404, { error: "not_found" });
    const session = sessions.get(parts[1]);

    if (!session) return json(response, 404, { error: "not_found" });

    if (session.closing) return json(response, 409, { error: "session_closing" });
    const [, sessionId, action, permissionId] = parts;

    if (request.method === "DELETE" && parts.length === 2) {
      session.closing = true;
      session.stream?.end();
      await session.client.close();
      sessions.delete(sessionId);

      return json(response, 200, { closed: true });
    }

    if (request.method === "GET" && parts.length === 3 && action === "events") {
      if (session.stream) return json(response, 409, { error: "already_subscribed" });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.flushHeaders();
      session.stream = response;
      response.on("close", () => {
        if (session.stream === response) session.stream = undefined;

        // This example cancels a turn on event-stream disconnect; it does not replay.
        if (session.active) void session.client.cancel(sessionId).catch(() => undefined);
      });

      return;
    }

    if (request.method === "POST" && parts.length === 3 && action === "prompt") {
      const body = await readBody(request);

      if (!isString(body.prompt) || !body.prompt.trim()) return json(response, 400, { error: "invalid_prompt" });

      if (!session.stream || session.active) return json(response, 409, { error: "stream_required_or_busy" });
      session.active = true;
      void session.client.prompt(sessionId, [{ type: "text", text: body.prompt }]).then(
        (result) => emit(session, { type: "prompt_complete", result }),
        () => emit(session, { type: "prompt_error", error: "prompt_failed" }),
      ).finally(() => { session.active = false; session.permissions.clear(); });

      return json(response, 202, { accepted: true });
    }

    if (request.method === "POST" && parts.length === 3 && action === "cancel") {
      await session.client.cancel(sessionId);

      return json(response, 200, { cancellationRequested: true });
    }

    if (request.method === "POST" && parts.length === 4 && action === "permissions") {
      const body = await readBody(request);

      if (!session.permissions.has(permissionId) || (body.optionId !== null && !isString(body.optionId))) return json(response, 400, { error: "invalid_permission" });

      try { session.client.respondToPermission(permissionId, body.optionId); }
      catch { return json(response, 400, { error: "invalid_permission" }); }

      session.permissions.delete(permissionId);

      return json(response, 200, { answered: true });
    }

    return json(response, 404, { error: "not_found" });
  }

  async function createSession() {
    const client = await createClient({ credential: { kind: "apiKey", apiKey }, workspace, environment, autoApprove });

    try {
      const created = await client.newSession();

      if (closing || sessions.has(created.sessionId)) throw new Error("Session could not be registered");
      const session = { client, stream: undefined, active: false, closing: false, permissions: new Set() };
      client.subscribe((event) => {
        if (event.type === "permission_request") session.permissions.add(event.permissionId);
        emit(session, event);
      });
      sessions.set(created.sessionId, session);

      return created.sessionId;
    } catch (error) { await client.close(); throw error; }
  }

  function emit(session, event) {
    const stream = session.stream;

    if (!stream || stream.destroyed || stream.writableEnded) return;

    if (stream.writableLength > 1024 * 1024) { stream.destroy();

 return; }

    stream.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() { closePromise ??= closeServer();

 return closePromise; },
  };

  async function closeServer() {
    closing = true;
    await Promise.allSettled(starting);

    for (const session of sessions.values()) { session.closing = true; session.stream?.end(); }

    const results = await Promise.allSettled([...sessions.values()].map((session) => session.client.close()));
    sessions.clear();
    await new Promise((resolve, reject) => {
      // Stop accepting first, then retire connections. Bun also stops the
      // listener in closeAllConnections(), so reversing these calls double-closes it.
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });

    if (results.some((result) => result.status === "rejected")) throw new Error("Some Bob clients could not be closed");
  }
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > 1024 * 1024) throw new Error("Request is too large");
    chunks.push(chunk);
  }

  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  if (Object.prototype.toString.call(value) !== "[object Object]") throw new Error("Invalid body");

  return value;
}

function isString(value) { return Object.prototype.toString.call(value) === "[object String]"; }

// Injecting the public SDK factory also allows lifecycle tests without Bob,
// package assets, or a previous build. No SDK internals are required.
async function startNativeClient(options) {
  const { Bob } = await import("@camenae/bob");

  return Bob.start(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startBobServer({ workspace: resolve(process.env.BOB_GATEWAY_WORKSPACE ?? process.cwd()), apiKey: process.env.BOB_API_KEY, token: process.env.BOB_GATEWAY_SERVER_TOKEN });
  console.log(`Bob SDK example server listening on ${server.url}`);

  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    void server.close().then(() => process.exit(0), () => { process.stderr.write("Bob server cleanup failed.\n"); process.exitCode = 1; });
  });
}

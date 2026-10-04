import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { mcpCleanupPlugin } from "../../scripts/mcp-cleanup.mjs";

let directory;

let sdk;

beforeAll(async () => {
  await mkdir(".tmp", { recursive: true });
  directory = await mkdtemp(join(process.cwd(), ".tmp", "mcp-cleanup-"));
  const outfile = join(directory, "server.mjs");
  await build({
    stdin: { contents: 'export { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server"; export { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";', resolveDir: process.cwd() },
    outfile, bundle: true, platform: "node", format: "esm", target: "node22",
    plugins: [mcpCleanupPlugin],
  });
  sdk = await import(pathToFileURL(outfile).href);
});

afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function open(eventStore) {
  const server = new sdk.Server({ name: "cleanup-contract", version: "1" }, { capabilities: { tools: {} } });
  const transport = new sdk.WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, eventStore });
  const pending = new Map();
  server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  server.setRequestHandler("tools/call", (_request, context) => new Promise((resolve) => {
    pending.set(context.mcpReq.id, { resolve, signal: context.mcpReq.signal });
    context.mcpReq.signal.addEventListener("abort", () => {
      transport.closeSSEStream(context.mcpReq.id);
      resolve({ isError: true, content: [{ type: "text", text: "Cancelled" }] });
    }, { once: true });
  }));
  await server.connect(transport);
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  const send = (body) => transport.handleRequest(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...body }) }));
  const initialized = await send({ id: "initialize", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cleanup-client", version: "1" } } });
  await initialized.text();
  headers.set("mcp-session-id", initialized.headers.get("mcp-session-id"));
  headers.set("mcp-protocol-version", "2025-03-26");
  const call = (id) => send({ id, method: "tools/call", params: { name: "pending", arguments: {} } });

  return { server, transport, pending, headers, send, call };
}

// Deliberate dependency-patch regression: retained map cardinality is the resource
// contract under repair. This is not a production export or a Gateway test hook.
function retained(transport) {
  return { streams: transport._streamMapping.size, requests: transport._requestToStreamMapping.size, responses: transport._requestResponseMap.size };
}

it.each(["cancel", "disconnect", "close"])("releases non-resumable request state on %s without a final response", async (ending) => {
  const owned = await open();

  try {
    expect(retained(owned.transport)).toEqual({ streams: 0, requests: 0, responses: 0 });

    for (let id = 0; id < (ending === "close" ? 1 : 100); id++) {
      const response = await owned.call(id);
      await expect.poll(() => owned.pending.has(id)).toBe(true);
      expect(retained(owned.transport).requests).toBe(1);

      if (ending === "cancel") {
        expect((await owned.send({ method: "notifications/cancelled", params: { requestId: id } })).status).toBe(202);
        await response.text();
        expect(owned.pending.get(id).signal.aborted).toBe(true);
      } else if (ending === "disconnect") {
        await response.body.cancel();
        // Check before the handler produces a response: no final reply can be
        // relied upon to clean up a disconnected or indefinitely pending call.
      } else { await owned.server.close(); await response.text(); }

      expect(retained(owned.transport)).toEqual({ streams: 0, requests: 0, responses: 0 });
      owned.pending.get(id).resolve({ content: [{ type: "text", text: "Late result" }] });
    }

    if (ending !== "close") {
      const control = await owned.send({ id: "control", method: "tools/list", params: {} });
      expect(await control.text()).toContain('"tools":[]');
      expect(retained(owned.transport)).toEqual({ streams: 0, requests: 0, responses: 0 });
    }
  } finally { await owned.server.close(); }
});

it("preserves event-store-backed stream resumption and releases its state on shutdown", async () => {
  const events = new Map();

  const eventStore = {
    async storeEvent(streamId, message) { const id = randomUUID(); events.set(id, { streamId, message });

 return id; },
    async getStreamIdForEventId(id) { return events.get(id)?.streamId; },
    async replayEventsAfter(id, { send }) {
      const streamId = events.get(id).streamId;
      let after = false;

      for (const [key, event] of events) {
        if (after && event.streamId === streamId && event.message) await send(key, event.message);

        if (key === id) after = true;
      }

      return streamId;
    },
  };

  const owned = await open(eventStore);

  try {
    const response = await owned.call(0);
    await expect.poll(() => owned.pending.has(0)).toBe(true);
    await owned.server.notification({ method: "notifications/progress", params: { progressToken: "progress", progress: 1 } }, { relatedRequestId: 0 });
    const lastEventId = [...events.keys()].at(-1);
    owned.transport.closeSSEStream(0);
    await response.text();
    expect(retained(owned.transport).requests).toBe(1);
    const headers = new Headers(owned.headers);
    headers.set("last-event-id", lastEventId);
    const resumed = await owned.transport.handleRequest(new Request("http://localhost/mcp", { headers }));
    expect(resumed.status).toBe(200);
    owned.pending.get(0).resolve({ content: [{ type: "text", text: "Resumed result" }] });
    expect(await resumed.text()).toContain("Resumed result");
    expect(retained(owned.transport)).toEqual({ streams: 0, requests: 0, responses: 0 });
    const pending = await owned.call(1);
    await owned.server.close();
    await pending.text();
    expect(retained(owned.transport)).toEqual({ streams: 0, requests: 0, responses: 0 });
  } finally { await owned.server.close(); }
});

it("fails the build rather than silently accepting changed or absent dependency code", async () => {
  const changed = join(directory, "node_modules/@modelcontextprotocol/server/dist");
  await mkdir(changed, { recursive: true });
  await writeFile(join(changed, "index.mjs"), "export const changed = true;\n");
  await expect(build({ entryPoints: [join(changed, "index.mjs")], bundle: true, write: false,
    plugins: [mcpCleanupPlugin], logLevel: "silent" })).rejects.toThrow("MCP dependency changed");
  await expect(build({ stdin: { contents: "export const missing = true;" }, bundle: true, write: false,
    plugins: [mcpCleanupPlugin], logLevel: "silent" })).rejects.toThrow("MCP stream cleanup patch was not applied");
});

it("retires state through the actual Node HTTP disconnect path used by the gate", async () => {
  const transport = new sdk.NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const server = new sdk.Server({ name: "node-cleanup", version: "1" }, { capabilities: { tools: {} } });
  const context = new AsyncLocalStorage();
  server.setRequestHandler("tools/call", (_request, extra) => new Promise((resolve) => {
    const response = context.getStore();
    extra.mcpReq.signal.addEventListener("abort", () => {
      response.destroy();
      resolve({ isError: true, content: [{ type: "text", text: "Cancelled" }] });
    }, { once: true });
  }));
  await server.connect(transport);
  const http = createServer((req, res) => { void context.run(res, () => transport.handleRequest(req, res)); });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  const send = body => fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });

  try {
    const initialized = await send({ id: "init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "node-probe", version: "1" } } });
    await initialized.text();
    headers.set("mcp-session-id", initialized.headers.get("mcp-session-id"));
    headers.set("mcp-protocol-version", "2025-03-26");

    for (let id = 0; id < 10; id++) {
      const call = await send({ id, method: "tools/call", params: { name: "pending" } });
      const body = call.text().catch(() => "");
      expect((await send({ method: "notifications/cancelled", params: { requestId: id } })).status).toBe(202);
      await body;
      await expect.poll(() => retained(transport._webStandardTransport)).toEqual({ streams: 0, requests: 0, responses: 0 });
    }
  } finally {
    await server.close(); http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  }
});

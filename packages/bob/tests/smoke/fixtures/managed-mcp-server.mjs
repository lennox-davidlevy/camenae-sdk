import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function fixture(root) {
  const server = new Server({ name: "managed-mcp-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let names = ["alpha", "beta"];

    try { names = JSON.parse(readFileSync(join(root, "tools.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }

    return { ttlMs: 60_000, tools: names.map((name) => ({
    name: `write_${name}`, description: `Write the ${name} test marker.`,
    inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
    })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const token = params.arguments?.token;

    if (!["write_alpha", "write_beta"].includes(params.name) || Object.prototype.toString.call(token) !== "[object String]" || !/^[a-z0-9-]{1,80}$/.test(token)) throw new Error("Invalid test call");
    writeFileSync(join(root, `${params.name}-${token}`), "EXECUTED");
    appendFileSync(join(root, "receipts.jsonl"), JSON.stringify({ name: params.name, token }) + "\n");

    return { content: [{ type: "text", text: "Test marker written." }] };
  });

  return server;
}

export async function startHttpFixture(root) {
  const server = createServer((request, response) => {
    if (request.headers["x-mcp-proof"] !== "managed-header") { response.writeHead(403).end();

 return; }

    const agent = fixture(root);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => { void transport.close(); void agent.close(); });
    void agent.connect(transport).then(() => transport.handleRequest(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((resolve) => {
    server.closeAllConnections(); server.close(resolve);
  }) };
}

if (process.argv.includes("--stdio")) {
  if (!process.env.MCP_TEST_ROOT) throw new Error("Missing test environment");
  await fixture(process.env.MCP_TEST_ROOT).connect(new StdioServerTransport());
}

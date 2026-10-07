import { createServer } from "node:http";
import { serve } from "../dist/worker.js";

const provider = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  const event = (delta, finish_reason) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(event({ content: "fixture answer" }, null) + event({}, "stop") + "data: [DONE]\n\n");
});

await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));

const address = provider.address();

const worker = await serve({
  hostname: "127.0.0.1", port: Number(process.env.TEST_PORT), password: "synthetic-only",
  database: `${process.env.HOME}/sessions.db`, configDirectory: `${process.env.HOME}/config`,
  configuration: JSON.stringify({ providers: { fixture: {
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "synthetic-only" },
    models: { fixture: { limit: { context: 32000, output: 1024 } } },
  } } }),
});

console.log("ready");

process.on("SIGTERM", () => {
  void worker.close().then(() => { provider.closeAllConnections(); provider.close(); });
});

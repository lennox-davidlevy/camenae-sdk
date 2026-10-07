import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { Bob } = await import(process.env.BOB_GATEWAY_TEST_PACKAGE
  ? pathToFileURL(process.env.BOB_GATEWAY_TEST_PACKAGE).href : "@camenae/bob");

const root = mkdtempSync(join(process.env.BOB_GATEWAY_SMOKE_ROOT ?? tmpdir(), "bob-code-mode-"));

const home = join(root, "home"), workspace = join(root, "workspace");

mkdirSync(join(home, ".bob", "settings"), { recursive: true });

mkdirSync(workspace);

writeFileSync(join(home, ".bob", "settings", "settings.json"), JSON.stringify({ telemetry: { enabled: false }, bobShell: { autoUpdate: false } }));

let sent = false, offered = false, received = false;

const model = createServer(async (request, response) => {
  if (!request.url.includes("chat/completions")) { response.writeHead(404).end("{}");

    return; }

  const chunks = [];

  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const main = body.tools?.length > 0;
  const call = main && !sent;

  if (call) {
    offered = body.tools.some((tool) => (tool.function?.name ?? tool.name) === "mcp__code__execute");
    sent = true;
  }

  if (body.messages?.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("composed"))) received = true;
  const code = 'const catalog = search({query:"record"}); if (!catalog.items.length) throw new Error("missing"); const values = await Promise.all([tools.record({id:1}),tools.record({id:2})]); try { await tools.record({id:9}); } catch {} return {composed: values}';
  const toolCall = { id: "code-mode-fixture", type: "function", function: { name: "mcp__code__execute", arguments: JSON.stringify({ code }) } };

  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });

    for (const [delta, finish] of [[call ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } : { role: "assistant", content: "Done." }, null], [{}, call ? "tool_calls" : "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    }

    response.end("data: [DONE]\n\n");
  } else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "fixture", choices: [{ index: 0,
    message: call ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "Done." }, finish_reason: call ? "tool_calls" : "stop" }] }));
});

let client;

try {
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${model.address().port}`;
  const environment = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  Object.assign(environment, { PATH: process.env.PATH, HOME: home, TMPDIR: root, TMP: root, TEMP: root,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
    BOB_GATEWAY_URL: url, BOB_WEB_LOGIN_URL: url });
  const env = [{ name: "CODE_MODE_ROOT", value: root }];

  if (process.env.BOB_GATEWAY_TEST_CODE_MODE_PACKAGE) env.push({ name: "BOB_GATEWAY_TEST_CODE_MODE_PACKAGE", value: process.env.BOB_GATEWAY_TEST_CODE_MODE_PACKAGE });
  client = await Bob.start({ workspace, environment, credential: { kind: "apiKey", apiKey: "synthetic-only" }, autoApprove: false,
    disableSubagents: true, managedMcpServers: [{ name: "code", command: process.execPath,
      args: [fileURLToPath(new URL("./code-mode-server.mjs", import.meta.url))], env, alwaysAllow: ["execute"] }] });
  const { sessionId } = await client.newSession();
  await client.prompt(sessionId, [{ type: "text", text: "Use the code tool to compose the fixture operations." }]);
  assert.equal(offered, true);
  assert.equal(received, true, "native Bob must receive the composed result");
  assert.equal(existsSync(join(root, "receipt-1")), true);
  assert.equal(existsSync(join(root, "receipt-2")), true);
  assert.equal(existsSync(join(root, "receipt-9")), false, "nested denial must prevent the effect despite outer alwaysAllow");
  console.log("Native Bob Code Mode: discovery, composition, result delivery and nested denial passed.");
} finally {
  await client?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}

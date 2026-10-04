import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHttpFixture } from "./managed-mcp-server.mjs";

// One behavioral owner, exercised against the local or installed package with
// either deterministic loopback model replies or explicitly authorized inference.
const { Bob } = await import(process.env.BOB_GATEWAY_TEST_PACKAGE
  ? pathToFileURL(process.env.BOB_GATEWAY_TEST_PACKAGE).href : "@camenae/bob");

const { createMcpToolGate } = await import(process.env.BOB_GATEWAY_TEST_MCP_PACKAGE
  ? pathToFileURL(process.env.BOB_GATEWAY_TEST_MCP_PACKAGE).href : "@camenae/bob/mcp");

const live = process.argv.includes("--live");

// Profiling is loopback-only. A filtered profile is not full package acceptance;
// ordinary invocations still exercise both transports and both generations.
const flags = process.argv.slice(2);

const profile = flags.find((flag) => flag.startsWith("--profile="));

if (flags.some((flag) => !["--live", "--profile=native", "--profile=socket", "--profile=all"].includes(flag))
  || flags.filter((flag) => flag.startsWith("--profile=")).length > 1 || (live && profile)) {
  throw new Error("Use --live or --profile=native|socket|all; profiling is loopback-only");
}

const transports = profile === "--profile=native" ? ["native"] : profile === "--profile=socket" ? ["socket"] : ["native", "socket"];

if (live && !process.env.BOB_API_KEY?.trim()) throw new Error("Live MCP approval proof requires BOB_API_KEY authorization");

const temporaryRoot = process.env.BOB_GATEWAY_SMOKE_ROOT ?? join(process.cwd(), ".tmp");

mkdirSync(temporaryRoot, { recursive: true });

const root = mkdtempSync(join(temporaryRoot, "ma-"));

const credential = { kind: "apiKey", apiKey: live ? process.env.BOB_API_KEY : "synthetic-loopback-only" };

const fixture = fileURLToPath(new URL("./managed-mcp-server.mjs", import.meta.url));

const gateToken = "synthetic-isolated-mcp-approval-gate-token";

let selected;

// Fixed counters only: never retain or log URLs, bodies, tool data or errors.
const requests = { modelInfo404: 0, modelInfo500: 0, other404: 0, other500: 0, chat200: 0, chat500: 0 };

const model = live ? undefined : createServer(async (request, response) => {
  const chat = request.url.includes("chat/completions");
  const modelInfo = request.url.endsWith("/model/info");

  try {
    const chunks = [];

    for await (const chunk of request) chunks.push(chunk);

    // Bodyless metadata GETs must reach 404, not JSON parsing and retryable 500s.
    if (!chat) {
      if (modelInfo) requests.modelInfo404++;
      else requests.other404++;
      response.writeHead(404).end("{}");

 return; }

    const body = JSON.parse(Buffer.concat(chunks).toString());

    const mainTurn = Array.isArray(body.tools) && body.tools.length > 0;
    const call = mainTurn && selected && !selected.sent;

    if (call) {
      selected.sent = true;
      selected.offered = body.tools.some((tool) => (tool.function?.name ?? tool.name) === selected.name);
    }

    const toolCall = call ? { id: `fixture-${selected.token}`, type: "function",
      function: { name: selected.name, arguments: JSON.stringify(selected.arguments) } } : undefined;

    requests.chat200++;

    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });

      for (const [delta, finish] of [
        [call ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } : { role: "assistant", content: "Finished." }, null],
        [{}, call ? "tool_calls" : "stop"],
      ]) response.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local",
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "local", model: "local",
      choices: [{ index: 0, message: call ? { role: "assistant", content: null, tool_calls: [toolCall] }
        : { role: "assistant", content: "Finished." }, finish_reason: call ? "tool_calls" : "stop" }] }));
  } catch {
    requests[chat ? "chat500" : modelInfo ? "modelInfo500" : "other500"]++;
    response.writeHead(500).end("{}");
  }
});

try {
  if (model) await listen(model);

  for (const transport of transports) {
    const base = join(root, transport), home = join(base, "home"), workspace = join(base, "workspace");
    mkdirSync(join(home, ".bob", "settings"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(join(home, ".bob", "settings", "settings.json"), JSON.stringify({ telemetry: { enabled: false }, bobShell: { autoUpdate: false } }));

    // Reapply saved preferences to a fresh worker + gate + native session, using
    // the same workspace. Never reuse one gate across independent MCP sessions.
    for (const generation of [0, 1]) {
      async function timed(phase, operation) {
        if (!profile) return operation();
        const started = performance.now();
        const before = { ...requests };
        const labels = { transport, generation, phase };
        console.log(JSON.stringify({ type: "mcp_profile", ...labels, outcome: "started" }));
        let outcome = "failed";

        try {
          const result = await operation();
          outcome = "completed";

          return result;
        } finally {
          console.log(JSON.stringify({ type: "mcp_profile", ...labels, outcome,
            durationMs: Math.round(performance.now() - started),
            requests: Object.fromEntries(Object.entries(requests).map(([key, count]) => [key, count - before[key]])) }));
        }
      }

      const effects = join(base, `effects-${generation}`), otherEffects = join(base, `other-${generation}`);
      mkdirSync(effects); mkdirSync(otherEffects);
      const http = transport === "socket" ? await timed("upstream-start", () => startHttpFixture(effects)) : undefined;
      const decisions = [];
      let asks = 0, nativeRequests = 0, categoryDecisions = 0;

      const gate = await timed("gate-start", () => createMcpToolGate({ bearerToken: gateToken,
        server: http ? { name: "trusted", type: "http", url: http.url, headers: [{ name: "x-mcp-proof", value: "managed-header" }] }
          : { name: "trusted", command: process.execPath, args: [fixture, "--stdio"], env: [{ name: "MCP_TEST_ROOT", value: effects }] },
        policy: { fallback: "allow" },
        onAutoDecision: (event) => { decisions.push(event); },
        onPermissionRequest: async () => { asks++;

 return "allow"; },
      }));

      const listener = createServer((request, response) => { void gate.handleRequest(request, response); });
      await timed("gate-listen", () => listen(listener));
      const environment = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
      Object.assign(environment, { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home,
        XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
        XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: home, TMPDIR: base, TMP: base, TEMP: base });

      if (model) Object.assign(environment, { BOB_GATEWAY_URL: url(model), BOB_WEB_LOGIN_URL: url(model) });

      const startup = { workspace, environment, autoApprove: false, disableSubagents: true, managedMcpServers: [
        { name: "trusted", type: "http", url: `${url(listener)}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${gateToken}` }],
          alwaysAllow: ["write_alpha", "write_beta"] },
        { name: "other", command: process.execPath, args: [fixture, "--stdio"], env: [{ name: "MCP_TEST_ROOT", value: otherEffects }],
          alwaysAllow: ["write_beta"], disabledTools: ["write_beta"] },
      ] };

      const controller = new AbortController();
      let worker, client;

      try {
        if (transport === "native") client = await timed("bob-start", () => Bob.start({ ...startup, credential }));
        else {
          const socketPath = join(root, "s");
          worker = Bob.serveOnce({ ...startup, socketPath, signal: controller.signal });
          void worker.catch(() => {});
          await timed("worker-listen", async () => {
            const deadline = Date.now() + 5000;

            while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
            assert.ok(existsSync(socketPath), "worker listener missing");
          });
          client = await timed("bob-connect", () => Bob.connect({ socketPath, workspace, credential }));
        }

        client.subscribe((event) => {
          if (event.type === "permission_request") {
            nativeRequests++;
            // Fail closed. An unexpected earlier ACP prompt cannot accidentally
            // supply the approval that this test expects the gate to own.
            client.respondToPermission(event.permissionId, event.request.options.find((option) => option.kind === "reject_once")?.optionId ?? null);
          }

          if (event.type === "permission_auto_decision") categoryDecisions++;
        });
        const { sessionId } = await timed("session-new", () => client.newSession());

        async function invoke(phase, name, token, args = { token }, offered = true) {
          selected = { name, token, arguments: args, sent: false, offered: undefined };
          await timed(phase, () => client.prompt(sessionId, [{ type: "text", text:
            `Call exactly the tool ${name} once with these arguments: ${JSON.stringify(args)}. Do not use any other tool. If unavailable or denied, do not retry or work around it. Reply briefly.` }]));

          if (!live) { assert.equal(selected.sent, true, "model fixture did not issue the tool call"); assert.equal(selected.offered, offered); }
        }

        // Neutral marker values keep the desired policy outcome out of the prompt.
        await invoke("turn-allow", "mcp__trusted__write_alpha", `phase-one-${generation}`);
        assert.equal(nativeRequests, 0, "alwaysAllow still prompted through ACP");
        assert.equal(asks, 0);
        assert.ok(existsSync(join(effects, `write_alpha-phase-one-${generation}`)), "allowed call did not execute");
        assert.deepEqual(decisions.map(({ match, decision }) => ({ match, decision })), [{ match: "fallback", decision: "allow" }]);

        if (generation === 0) {
          gate.setPolicy({ tools: { write_alpha: "ask" }, fallback: "allow" });
          await invoke("turn-ask", "mcp__trusted__write_alpha", "phase-two");
          assert.equal(asks, 1, "Ask must produce exactly one gate question");
          assert.equal(nativeRequests, 0, "duplicate native permission question");
          assert.ok(existsSync(join(effects, "write_alpha-phase-two")));
          assert.equal(decisions.length, 1, "Ask was reported as automatic");
          gate.setPolicy({ tools: { write_alpha: "deny" }, fallback: "allow" });
          await invoke("turn-deny", "mcp__trusted__write_alpha", "phase-three");
          assert.equal(existsSync(join(effects, "write_alpha-phase-three")), false);
          assert.equal(asks, 1);
          assert.equal(nativeRequests, 0);
          assert.equal(decisions.length, 2, "Deny phase must produce one new automatic authorization event, not merely no side effect");
          assert.equal(decisions.at(-1).toolName, "write_alpha", "model did not call the requested fixture tool");
          assert.equal(decisions.at(-1).decision, "deny");
          assert.equal(decisions.at(-1).match, "tool");
          await invoke("turn-cross-server", "mcp__other__write_alpha", "phase-four");
          assert.equal(nativeRequests, 1, "same-name tool on another server inherited approval");
          assert.equal(existsSync(join(otherEffects, "write_alpha-phase-four")), false);

          // Live models need not attempt unavailable tools. Deterministic replies
          // deliberately attempt one, proving native Disabled wins over Always.
          if (!live) {
            await invoke("turn-disabled", "mcp__other__write_beta", "disabled", { token: "disabled" }, false);
            assert.equal(nativeRequests, 1);
            assert.equal(existsSync(join(otherEffects, "write_beta-disabled")), false);
            await invoke("turn-unknown", "mcp__missing__write_alpha", "unknown", { token: "unknown" }, false);
            assert.equal(nativeRequests, 1);
          }

          client.setApprovalPolicy({ kinds: { execute: "deny" } });
          await invoke("turn-native-deny", "execute_command", "native", { command: "printf NATIVE_PROOF > native-proof.txt" });
          assert.equal(categoryDecisions, 1, "unrelated native category policy was bypassed");
          assert.equal(nativeRequests, 1);
          assert.equal(existsSync(join(workspace, "native-proof.txt")), false);
          assert.deepEqual(readFileSync(join(effects, "receipts.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [
            { name: "write_alpha", token: "phase-one-0" }, { name: "write_alpha", token: "phase-two" },
          ]);
        }

        await timed("session-close", () => client.closeSession(sessionId));
        console.log(`MCP approval proof passed: ${transport}, generation ${generation}, ${live ? "live" : "loopback model"}.`);
      } finally {
        if (transport === "native") await timed("client-close", () => client?.close());
        else await timed("client-disconnect", () => client?.disconnect());
        controller.abort();

        if (worker) await timed("worker-settle-after-abort", () => worker);
        await timed("gate-close", () => gate.close());
        await timed("gate-listener-close", () => close(listener));

        if (http) await timed("upstream-close", () => http.close());
      }
    }
  }

  if (!live) assert.equal(requests.modelInfo500 + requests.other500 + requests.chat500, 0,
    "Loopback fixture returned HTTP 500 responses and triggered avoidable retries");
} finally { if (model) await close(model); rmSync(root, { recursive: true, force: true }); }

async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }

function url(server) { return `http://127.0.0.1:${server.address().port}`; }

async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

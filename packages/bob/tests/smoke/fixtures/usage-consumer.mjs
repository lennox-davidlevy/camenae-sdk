import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Behavioral owner: actual packaged Bob must translate provider accounting into
// session-scoped SDK events, including persisted totals on replacement workers.
const { Bob } = await import(process.env.BOB_GATEWAY_TEST_PACKAGE
  ? pathToFileURL(process.env.BOB_GATEWAY_TEST_PACKAGE).href : "@camenae/bob");

mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });

const root = mkdtempSync(join(process.cwd(), ".tmp", "usage-"));

let capacity = 131072;

let failTurn = false;

let modelInfoRequests = 0;

let lastSystemPrompt = "";

let lastToolNames = [];

const model = createServer(async (request, response) => {
  const chunks = [];

  for await (const chunk of request) chunks.push(chunk);

  if (request.url.endsWith("/model/info")) {
    modelInfoRequests++;

    if (capacity === undefined) { response.writeHead(404).end("{}");

 return; }

    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [
      { model_name: "premium-ide", model_info: { max_input_tokens: capacity, max_tokens: 8192 } },
    ] }));

    return;
  }

  if (!request.url.includes("chat/completions")) { response.writeHead(404).end("{}");

 return; }

  if (failTurn) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Synthetic usage failure" } }));

 return; }

  const body = JSON.parse(Buffer.concat(chunks).toString());
  lastSystemPrompt = JSON.stringify(body.messages?.filter((message) => message.role === "system"));
  lastToolNames = body.tools?.map((tool) => tool.function?.name) ?? [];
  const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, credits: 1.25 };

  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });

    for (const [delta, finish, stats] of [
      [{ role: "assistant", content: "Finished." }, null, undefined], [{}, "stop", usage],
    ]) response.write(`data: ${JSON.stringify({ id: "usage-fixture", object: "chat.completion.chunk", created: 1,
      model: "premium-ide", choices: [{ index: 0, delta, finish_reason: finish }], usage: stats })}\n\n`);
    response.end("data: [DONE]\n\n");
  } else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "usage-fixture", model: "premium-ide", usage,
    choices: [{ index: 0, message: { role: "assistant", content: "Finished." }, finish_reason: "stop" }],
  }));
});

try {
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${model.address().port}`;

  for (const transport of ["native", "socket"]) {
    const base = join(root, transport), home = join(base, "home"), workspace = join(base, "workspace");
    mkdirSync(join(home, ".bob", "settings"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(join(home, ".bob", "settings", "settings.json"), JSON.stringify({
      telemetry: { enabled: false }, bobShell: { autoUpdate: false }, session: { compactionThresholdPercent: 80 },
    }));
    const environment = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
    Object.assign(environment, { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home,
      XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: home, TMPDIR: base, TMP: base, TEMP: base,
      BOB_GATEWAY_URL: url, BOB_WEB_LOGIN_URL: url });
    const credential = { kind: "apiKey", apiKey: "synthetic-loopback-only" };
    const startup = { workspace, environment, disableMcp: true, disableSubagents: true, autoApprove: false };
    let sessionId;

    for (const generation of [0, 1]) {
      const role = `You are a general-purpose assistant. Managed role ${generation}: “café” — 日本語.`;
      const instructions = `Managed instructions ${generation}: answer general questions directly.`;

      const managedCustomModes = [{ slug: "general-assistant", name: "General Assistant", roleDefinition: role,
        customInstructions: instructions, groups: [] }];

      modelInfoRequests = 0;
      capacity = generation === 0 ? (transport === "native" ? 131072 : 262144) : undefined;
      const controller = new AbortController();
      let client, worker;

      try {
        if (transport === "native") client = await Bob.start({ ...startup, credential, managedCustomModes });
        else {
          const socketPath = join(root, "s");
          worker = Bob.serveOnce({ ...startup, socketPath, signal: controller.signal, managedCustomModes });
          void worker.catch(() => {});
          const deadline = Date.now() + 5000;

          while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
          assert.ok(existsSync(socketPath), "worker listener missing");
          client = await Bob.connect({ socketPath, workspace, credential });
        }

        const events = [];
        let wake;
        client.subscribe((event) => {
          if (event.type !== "session_update") return;
          const usage = event.notification.update._meta?.["bob-gateway/usage"];

          if (usage) { events.push({ ...event.notification, usage }); wake?.(); }
        });

        if (generation === 0) {
          const session = await client.newSession();
          assert.ok(session.modes?.availableModes.some((mode) => mode.id === "general-assistant"), "managed mode not discovered by Bob");
          sessionId = session.sessionId;
        }
        else await client.resumeSession(sessionId);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Bob did not emit session usage metadata")), 10000);
          wake = () => { if (events.some((event) => event.sessionId === sessionId)) { clearTimeout(timer); resolve(); } };

          wake();
        });
        const initial = events.at(-1).usage;
        assert.equal(initial.version, 1);
        assert.equal(initial.bobcoins, generation === 0 ? 0 : 2.5, "resume lost or duplicated native spending");
        assert.equal(initial.contextTokens, generation === 0 ? 0 : 150);

        // Native execution may already have resolved limits; reporting itself
        // must not initiate a lookup merely to fill an otherwise unknown value.
        if (initial.contextWindow !== null) assert.equal(initial.contextWindow, capacity ?? null);
        assert.equal(initial.compactionThreshold, 0.8);
        assert.equal(initial.maxOutputTokens, initial.contextWindow === null ? null : 8192);
        assert.equal(initial.autoCompact, true);
        assert.equal(events.at(-1).update.sessionUpdate, initial.contextWindow === null ? "session_info_update" : "usage_update");
        const queriesBeforeMode = modelInfoRequests;
        await client.setMode(sessionId, "general-assistant");
        assert.equal(modelInfoRequests, queriesBeforeMode, "usage reporting must not initiate model-info requests");

        if (generation === 0) {
          for (const expected of [1.25, 2.5]) {
            const before = events.length;
            await client.prompt(sessionId, [{ type: "text", text: "Reply briefly without using tools." }]);
            assertManagedPrompt(role, instructions);
            assert.ok(events.length > before, "prompt completed without a fresh usage snapshot");
            const last = events.at(-1);
            assert.equal(last.sessionId, sessionId);
            assert.equal(last.usage.bobcoins, expected, "provider credits must accumulate, not be converted or summed twice");
            assert.equal(last.usage.contextTokens, 150, "context occupancy is not cumulative token usage");
            assert.equal(last.update.used, 150);
            assert.equal(last.update.size, capacity);
            assert.equal(last.usage.maxOutputTokens, 8192);
            assert.equal(last.update.cost, undefined, "Bobcoins must not masquerade as currency");
          }

          const other = await client.newSession();
          await client.prompt(other.sessionId, [{ type: "text", text: "Reply briefly." }]);
          assert.equal(events.at(-1).sessionId, other.sessionId);
          assert.equal(events.at(-1).usage.bobcoins, 1.25, "session spending leaked across sessions");
          await client.closeSession(other.sessionId);
          const beforeMode = events.length;
          await client.setMode(sessionId, "ask");
          assert.ok(events.length > beforeMode, "mode change did not refresh usage");
          assert.equal(events.at(-1).sessionId, sessionId);
          assert.equal(events.at(-1).usage.bobcoins, 2.5);
          const beforeFailure = events.length;
          failTurn = true;

          try {
            await assert.rejects(client.prompt(sessionId, [{ type: "text", text: "Reply briefly." }]));
          } finally { failTurn = false; }

          assert.ok(events.length > beforeFailure, "failed turn did not refresh native usage");
          assert.equal(events.at(-1).usage.bobcoins, 2.5);
        } else {
          await client.prompt(sessionId, [{ type: "text", text: "Reply briefly." }]);
          assertManagedPrompt(role, instructions);
          assert.ok(!lastSystemPrompt.includes("Managed role 0:"), "replacement retained old mode instructions");
          assert.equal(events.at(-1).usage.bobcoins, 3.75);
          assert.equal(events.at(-1).usage.contextWindow, null);
          assert.equal(events.at(-1).usage.maxOutputTokens, null);
          assert.equal(events.at(-1).update.sessionUpdate, "session_info_update");
        }

        await client.closeSession(sessionId);
      } finally {
        if (transport === "native") await client?.close(); else await client?.disconnect();
        controller.abort();

 if (worker) await worker;
      }
    }

    console.log(`Usage and managed modes passed: ${transport}, accounting, session isolation, replacement/resume, native role/instructions and tool groups.`);
  }
} finally {
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}

function assertManagedPrompt(role, instructions) {
  assert.ok(lastSystemPrompt.includes(role), "native system prompt lost the managed role or its Unicode text");
  assert.ok(lastSystemPrompt.includes(instructions), "native system prompt lost custom instructions");
  assert.ok(!lastToolNames.includes("execute_command") && !lastToolNames.includes("read_file"), "empty mode groups exposed grouped tools");
}

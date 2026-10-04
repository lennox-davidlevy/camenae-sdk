import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Bob } from "@camenae/bob";
import { startHttpFixture } from "./managed-mcp-server.mjs";

const root = process.env.BOB_GATEWAY_APPROVAL_SMOKE_ROOT;

const credential = { kind: "apiKey", apiKey: process.env.BOB_API_KEY };

for (const sdkTransport of ["native", "socket"]) for (const mcpTransport of ["stdio", "http"]) {
  const label = `${sdkTransport}-${mcpTransport}`;
  const workspace = join(root, label);
  const home = join(root, `${label}-home`);
  const receipts = join(root, `${label}-effects`);

  for (const directory of [workspace, home, receipts]) mkdirSync(directory);
  const http = mcpTransport === "http" ? await startHttpFixture(receipts) : undefined;

  const definition = http ? { name: "managed", type: "http", url: http.url, headers: [{ name: "X-Mcp-Proof", value: "managed-header" }] }
    : { name: "managed", command: process.execPath, args: [fileURLToPath(new URL("./managed-mcp-server.mjs", import.meta.url)), "--stdio"], env: [{ name: "MCP_TEST_ROOT", value: receipts }] };

  let sessionId;

  try {
    for (const phase of ["baseline", "disabled", "restored"]) {
      const environment = { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
        XDG_DATA_HOME: join(home, "data"), XDG_RUNTIME_DIR: home, NODE_ENV: "production", TMPDIR: root, TMP: root, TEMP: root };

      const startup = { workspace, environment, autoApprove: false, disableSubagents: true,
        managedMcpServers: [{ ...definition, disabledTools: phase === "disabled" ? ["write_alpha"] : [] }] };

      const controller = new AbortController();
      let worker;
      let client;

      try {
        if (sdkTransport === "native") client = await Bob.start({ ...startup, credential });
        else {
          const socketPath = join(root, "s");
          worker = Bob.serveOnce({ ...startup, socketPath, signal: controller.signal });
          void worker.catch(() => {});
          const deadline = Date.now() + 5000;

          while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
          assert.ok(existsSync(socketPath), "worker listener missing");
          client = await Bob.connect({ socketPath, workspace, credential });
        }

        if (sessionId) await client.resumeSession(sessionId);
        else sessionId = (await client.newSession()).sessionId;
        const token = `${label}-${phase}`;
        const requested = phase === "restored" ? ["write_alpha"] : ["write_alpha", "write_beta"];

        const notice = phase === "restored"
          ? "The worker was replaced and write_alpha has now been re-enabled. Use the tool list supplied for this turn, not the earlier turn's unavailable-tool result."
          : "Use the tool list supplied for this turn.";

        let permissions = 0;
        client.subscribe((event) => {
          if (event.type !== "permission_request") return;
          const allow = event.request.toolCall.rawInput?.token === token;

          if (allow) permissions++;
          const option = event.request.options.find((item) => item.kind === (allow ? "allow_once" : "reject_once"));
          client.respondToPermission(event.permissionId, option?.optionId ?? null);
        });

        const result = await bounded(client.prompt(sessionId, [{ type: "text", text:
          `${notice} Call each of these exact MCP tools once: ${requested.map((name) => `mcp__managed__${name}`).join(", ")}, each with {"token":"${token}"}. If a tool is unavailable, continue with the next listed tool. Do not use shell commands, file tools, or any workaround. Reply briefly.` }]));

        await client.closeSession(sessionId);
        // Read-only evidence from the pinned runtime: not a production discovery API.
        // This distinguishes genuine removal from a model merely declining a request.
        const db = new DatabaseSync(join(home, ".bob/db/bob.db"), { readOnly: true });

        try {
          const messages = db.prepare("SELECT data FROM messages WHERE task_id = ? AND role = 'user'").all(sessionId).map((row) => JSON.parse(row.data));
          const offered = messages.findLast((message) => message.content?.includes(token))?.availableTools;
          assert.ok(Array.isArray(offered), "missing native offered-tool evidence");
          assert.equal(offered.includes("mcp__managed__write_alpha"), phase !== "disabled");
          assert.ok(offered.includes("mcp__managed__write_beta"));
        } finally { db.close(); }

        assert.equal(result.stopReason, "end_turn");
        const actual = readFileSync(join(receipts, "receipts.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((entry) => entry.token === token).map((entry) => entry.name).sort();
        const expected = phase === "disabled" ? ["write_beta"] : requested;
        assert.deepEqual(actual, expected, `unexpected native MCP execution after offered-tool verification (${label}/${phase}, permissions=${permissions})`);
        assert.equal(permissions, expected.length, "availability was not distinguished from permission rejection");

        for (const name of requested) assert.equal(existsSync(join(receipts, `${name}-${token}`)), expected.includes(name));
      } finally {
        if (sdkTransport === "native") await client?.close();
        else await client?.disconnect();
        controller.abort();

        if (worker) await worker;
      }
    }

    console.log(`Installed managed MCP proof passed (${label}): offered tools, execution receipts, disable, replacement/resume, restore.`);
  } finally { await http?.close(); }
}

async function bounded(operation) {
  let timer;

  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Managed MCP smoke timed out")), 120_000); })]); }
  finally { clearTimeout(timer); }
}

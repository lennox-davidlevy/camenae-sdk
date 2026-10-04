import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Bob } from "@camenae/bob";

const root = process.env.BOB_GATEWAY_APPROVAL_SMOKE_ROOT;

const credential = { kind: "apiKey", apiKey: process.env.BOB_API_KEY };

for (const transport of ["native", "socket"]) {
  const workspace = join(root, transport);
  const home = join(root, `${transport}-home`);
  mkdirSync(workspace); mkdirSync(home);

  const environment = { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"), XDG_RUNTIME_DIR: home, TMPDIR: root, TMP: root, TEMP: root };

  const startup = { workspace, environment, autoApprove: false, disableMcp: true, disableSubagents: true };
  const approvalPolicy = { kinds: { execute: "allow", edit: "allow" }, fallback: "deny" };
  const controller = new AbortController();
  let worker;
  let client;

  try {
    if (transport === "native") client = await Bob.start({ ...startup, credential, approvalPolicy });
    else {
      const socketPath = join(root, "s");
      worker = Bob.serveOnce({ ...startup, socketPath, signal: controller.signal });
      void worker.catch(() => {});
      const deadline = Date.now() + 5000;

      while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(existsSync(socketPath), "worker listener missing");
      client = await Bob.connect({ socketPath, workspace, credential, approvalPolicy });
    }

    let manual = 0;
    let failedTools = 0;
    let toolCalls = 0;
    client.subscribe((event) => {
      if (event.type === "permission_request") {
        manual++;
        client.respondToPermission(event.permissionId, null);
      }

      if (event.type === "session_update") {
        if (event.notification.update.sessionUpdate === "tool_call") toolCalls++;

        if (event.notification.update.sessionUpdate === "tool_call_update" && event.notification.update.status === "failed") failedTools++;
      }
    });
    const { sessionId } = await client.newSession();

    const write = async (file) => {
      const result = await bounded(client.prompt(sessionId, [{ type: "text", text:
        `Use your command execution tool to run exactly: printf APPROVAL_PROOF > ${file}. Do not use any other tool. If rejected, do not retry or use alternatives; just report the rejection. Otherwise reply briefly.` }]));

      assert.equal(result.stopReason, "end_turn");
    };

    // Neutral filenames keep the expected policy outcome out of the model's prompt.
    await write("phase-one.txt");
    assert.equal(readFileSync(join(workspace, "phase-one.txt"), "utf8"), "APPROVAL_PROOF");
    assert.equal(manual, 0, "allow unexpectedly deferred");
    const callsBefore = toolCalls;
    const failuresBefore = failedTools;
    client.setApprovalPolicy({ fallback: "deny" });
    await write("phase-two.txt");
    assert.ok(toolCalls > callsBefore && failedTools > failuresBefore,
      `no rejected tool attempt observed (calls=${toolCalls - callsBefore}, failures=${failedTools - failuresBefore}, manual=${manual})`);
    assert.equal(existsSync(join(workspace, "phase-two.txt")), false, "denied tool produced a side effect");
    assert.equal(manual, 0, "deny unexpectedly deferred");
    client.setApprovalPolicy(approvalPolicy);
    await write("phase-three.txt");
    assert.equal(readFileSync(join(workspace, "phase-three.txt"), "utf8"), "APPROVAL_PROOF");
    assert.equal(manual, 0);
    await client.closeSession(sessionId);
    await client.resumeSession(sessionId);
    client.setApprovalPolicy({ fallback: "deny" });
    const resumedCallsBefore = toolCalls;
    const resumedFailuresBefore = failedTools;
    await write("phase-four.txt");
    assert.ok(toolCalls > resumedCallsBefore && failedTools > resumedFailuresBefore, "no resumed rejected tool attempt observed");
    assert.equal(manual, 0, "resumed deny unexpectedly deferred");
    assert.equal(existsSync(join(workspace, "phase-four.txt")), false);
    await client.closeSession(sessionId);
    console.log(`Installed Bob approval proof passed (${transport}): allow side effect, deny without side effect, live updates, resume.`);
  } finally {
    if (transport === "native") await client?.close();
    else await client?.disconnect();
    controller.abort();

    if (worker) await worker;
  }
}

async function bounded(operation) {
  let timer;

  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Approval smoke timed out")), 120_000); })]); }
  finally { clearTimeout(timer); }
}

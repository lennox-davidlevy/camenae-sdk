import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startBobServer } from "../../examples/interactive-server.mjs";

if (!process.env.BOB_API_KEY?.trim()) throw new Error("BOB_API_KEY is required");

mkdirSync(".tmp", { recursive: true });

const root = mkdtempSync(join(process.cwd(), ".tmp", "server-live-"));

writeFileSync(join(root, "source.txt"), "UNCHANGED\n");

// Keep runtime temporary directories outside the source being copied.
const source = join(root, "source");

mkdirSync(source);

writeFileSync(join(source, "source.txt"), "UNCHANGED\n");

writeFileSync(join(source, "denied.txt"), "PRESERVE\n");

const token = "local-sdk-server-smoke";

const home = join(root, "home");

mkdirSync(home);

const server = await startBobServer({ workspace: source, apiKey: process.env.BOB_API_KEY, token, environment: {
  HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
  XDG_DATA_HOME: join(home, "data"), XDG_RUNTIME_DIR: home, TMPDIR: root, TMP: root, TEMP: root,
} });

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const streams = [];

const post = (path, body = {}) => fetch(`${server.url}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });

try {
  assert.equal((await fetch(`${server.url}/sessions`, { method: "POST" })).status, 401);

  const sessions = await Promise.all([0, 1].map(async () => {
    const response = await post("/sessions");
    assert.equal(response.status, 201);

    return (await response.json()).sessionId;
  }));

  const events = await Promise.all(sessions.map(async (sessionId) => {
    const response = await fetch(`${server.url}/sessions/${sessionId}/events`, { headers, signal: AbortSignal.timeout(180_000) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    streams.push(reader);
    let pending = "";
    const decoder = new TextDecoder();

    return async function next() {
      while (!pending.includes("\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        pending += decoder.decode(chunk.value, { stream: true });
      }

      const end = pending.indexOf("\n\n");
      const record = pending.slice(0, end);
      pending = pending.slice(end + 2);

      return JSON.parse(record.slice(6));
    };
  }));

  async function turn(index, prompt, { cancel = false, reject = false } = {}) {
    assert.equal((await post(`/sessions/${sessions[index]}/prompt`, { prompt })).status, 202);
    let text = "";
    let permissions = 0;
    let cancelled = false;

    for (;;) {
      const event = await events[index]();
      assert.notEqual(event.type, "prompt_error");

      if (event.type === "permission_request") {
        permissions++;
        const option = event.request.options.find((option) => option.kind === (reject ? "reject_once" : "allow_once"));
        assert.ok(option);
        assert.equal((await post(`/sessions/${sessions[index]}/permissions/${event.permissionId}`, { optionId: option.optionId })).status, 200);
      }

      if (event.type === "session_update" && event.notification.update.sessionUpdate === "agent_message_chunk") {
        const content = event.notification.update.content;

        if (content.type === "text") text += content.text;

        if (cancel && !cancelled) {
          cancelled = true;
          assert.equal((await post(`/sessions/${sessions[index]}/cancel`)).status, 200);
        }
      }

      if (event.type === "prompt_complete") return { text, permissions, stopReason: event.result.stopReason, cancelled };
    }
  }

  await Promise.all([turn(0, "Remember SERVER_NATIVE_823 for my next question. Reply ACK."), turn(1, "Reply PARALLEL_OK and nothing else.")]);
  assert.ok((await turn(0, "What token did I ask you to remember?")).text.includes("SERVER_NATIVE_823"));
  const edit = await turn(0, "Replace source.txt in the current directory with EDITED. Use your file editing tool, then reply briefly.");
  assert.ok(edit.permissions > 0, "Bob did not ask the server for permission");
  assert.equal(edit.stopReason, "end_turn");
  assert.equal(readFileSync(join(source, "source.txt"), "utf8").trim(), "EDITED");
  const denied = await turn(0, "Replace denied.txt with CHANGED using a file editing tool. If permission is rejected, stop without trying another tool.", { reject: true });
  assert.ok(denied.permissions > 0, "Bob did not request permission for the rejected edit");
  assert.equal(readFileSync(join(source, "denied.txt"), "utf8"), "PRESERVE\n");
  const cancelled = await turn(0, "Write a long numbered explanation of 500 programming concepts without tools.", { cancel: true });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.stopReason, "cancelled");
  console.log("Separate Bob SDK server live smoke passed: HTTP/SSE, parallel clients, continuation, permission approval/rejection, cancellation.");
} finally {
  await Promise.all(streams.map((reader) => reader.cancel()));
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

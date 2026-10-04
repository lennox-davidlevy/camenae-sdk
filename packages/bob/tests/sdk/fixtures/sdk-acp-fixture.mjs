import { createInterface } from "node:readline";

let nextSession = 1;

const sessions = new Set();

const pendingPrompts = new Map();

const pendingPermissions = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (process.argv.includes("--ignore-term")) process.on("SIGTERM", () => {});

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);

  if (request.method === undefined && pendingPermissions.has(request.id)) {
    const { promptId, sessionId } = pendingPermissions.get(request.id);
    pendingPermissions.delete(request.id);
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(request.result) },
    } } });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: request.result?.outcome?.outcome === "selected" ? "end_turn" : "cancelled" } });

    return;
  }

  if (request.method === "initialize") {
    const initialize = () => send({ jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: 1,
		agentInfo: { name: "native-fixture", version: "2.0.2", title: process.env.BOB_GATEWAY_AUTO_APPROVE ?? "unset" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} } },
        authMethods: [{ id: "sso", name: "Synthetic SSO" }, { id: "pending", name: "Stalled login" }],
      } });

    if (process.argv.includes("--delay-initialize")) setTimeout(initialize, 1_000);
    else initialize();

    return;
  }

  if (request.method === "authenticate") {
    if (request.params.methodId === "pending") return;

    if (request.params.methodId !== "sso") send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unknown auth method" } });
    else setTimeout(() => send({ jsonrpc: "2.0", id: request.id, result: { _meta: { authenticatedBy: "fixture" } } }), 750);

    return;
  }

  if (request.method === "session/new") {
    const sessionId = process.argv.includes("--stop-reading") || process.argv.includes("--ignore-term") ? String(process.pid) : `session-${nextSession++}`;
    sessions.add(sessionId);
    send({ jsonrpc: "2.0", id: request.id, result: {
      sessionId,
      modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "findings", name: "Findings" }] },
    } });

    if (process.argv.includes("--stop-reading")) process.kill(process.pid, "SIGSTOP");

    return;
  }

  if (request.method === "session/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { sessions: [...sessions].map((sessionId) => ({ sessionId, cwd: request.params.cwd ?? process.cwd(), title: `Title ${sessionId}` })) } });

    return;
  }

  if (request.method === "session/load" || request.method === "session/resume") {
    if (request.params.sessionId === "missing") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "unknown session" } });

      return;
    }

    sessions.add(request.params.sessionId);

    if (request.method === "session/load") send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: request.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "saved-history" } },
    } });
    send({ jsonrpc: "2.0", id: request.id, result: {} });

    return;
  }

  if (request.method === "session/delete") {
    sessions.delete(request.params.sessionId);
    send({ jsonrpc: "2.0", id: request.id, result: {} });

    return;
  }

  if (request.method === "session/close") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });

    return;
  }

  if (request.method === "session/set_mode") {
    if (request.params.modeId === "unresponsive") return;

    if (request.params.modeId === "missing") send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "private mode detail" } });
    else send({ jsonrpc: "2.0", id: request.id, result: {} });

    return;
  }

  if (request.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: request.id, result: { configOptions: [] } });

    return;
  }

  if (request.method === "session/prompt") {
    const text = request.params.prompt.find((block) => block.type === "text")?.text;

    if (text === "malformed") send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "private-malformed-notification-marker", update: null } });

    if (text === "overflow") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: request.params.sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(2_048) },
      } } });

      return;
    }

    if (text === "invalid") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "private prompt detail" } });

      return;
    }

    if (text === "delay") {
      pendingPrompts.set(request.params.sessionId, request.id);
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: request.params.sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "prompt-started" },
      } } });

      return;
    }

    if (text === "permission") {
      const permissionId = `permission-${request.id}`;
      pendingPermissions.set(permissionId, { promptId: request.id, sessionId: request.params.sessionId });
      send({ jsonrpc: "2.0", id: permissionId, method: "session/request_permission", params: {
        sessionId: request.params.sessionId,
        toolCall: { toolCallId: "tool-1", title: "Write output" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
      } });

      return;
    }

    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: request.params.sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: `received:${request.params.prompt.map((block) => block.type).join(",")}` },
    } } });
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } } });

    return;
  }

  if (request.method === "session/cancel") {
    const promptId = pendingPrompts.get(request.params.sessionId);

    if (promptId !== undefined) {
      pendingPrompts.delete(request.params.sessionId);
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: request.params.sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cancel-received" },
      } } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
    }

    return;
  }

  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "not found" } });
});

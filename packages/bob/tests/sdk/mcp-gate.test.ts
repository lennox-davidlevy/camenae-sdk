import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createMcpToolGate, type McpToolGateOptions, type McpToolPermissionRequest } from "../../src/sdk/mcp-gate.js";
import { startHttpFixture } from "../smoke/fixtures/managed-mcp-server.mjs";
import { hasStringCode, isString } from "../../src/utils/type-guards.js";
import type { McpToolAutoDecisionEvent, McpToolPolicy } from "../../src/sdk/mcp-gate.js";

const token = "synthetic-gate-token-not-an-upstream-secret";

const factory: typeof createMcpToolGate = process.env.BOB_GATEWAY_TEST_MCP_PACKAGE
  ? (await import(pathToFileURL(process.env.BOB_GATEWAY_TEST_MCP_PACKAGE).href)).createMcpToolGate : createMcpToolGate;

async function open(transport: string, options: Partial<Omit<McpToolGateOptions, "server" | "bearerToken">> = {}, disabledTools: string[] = [], raw = false) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".tmp", "mcp-gate-"));
  const upstream = transport === "http" ? await startHttpFixture(root) : undefined;

  const gate = await factory({ ...options, bearerToken: token, server: upstream
    ? { name: "documents", type: "http", url: upstream.url, headers: [{ name: "x-mcp-proof", value: "managed-header" }], disabledTools }
    : { name: "documents", command: process.execPath, args: [fileURLToPath(new URL("../smoke/fixtures/managed-mcp-server.mjs", import.meta.url)), "--stdio"], env: [{ name: "MCP_TEST_ROOT", value: root }], disabledTools },
  });

  const listener = createServer((request, response) => { void gate.handleRequest(request, response); });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();

  if (!address || isString(address)) throw new Error("No HTTP address");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "gate-consumer", version: "1" });

  if (!raw) await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

  return { gate, client, url,
    setListedTools: (names: string[]) => writeFile(join(root, "tools.json"), JSON.stringify(names)),
    receipts: async () => { try { return (await readFile(join(root, "receipts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); } catch (error) { if (hasStringCode(error) && error.code === "ENOENT") return []; throw error; } },
    close: async () => {
      await client.close(); await gate.close();
      listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve()));
      await upstream?.close(); await rm(root, { recursive: true, force: true });
    },
  };
}

describe.each(["stdio", "http"])("MCP tool gate over %s upstream", (transport) => {
  it("refreshes discovery on explicit listing even when the upstream advertises a positive cache TTL", async () => {
    const owned = await open(transport);

    try {
      expect((await owned.client.listTools()).tools.map((tool) => tool.name)).toEqual(["write_alpha", "write_beta"]);
      await owned.setListedTools(["beta"]);
      expect((await owned.client.listTools()).tools.map((tool) => tool.name)).toEqual(["write_beta"]);
    } finally { await owned.close(); }
  });
  it("keeps denied tools discoverable but never forwards denied/disabled calls, using exact immutable rules", async () => {
    const events: McpToolAutoDecisionEvent[] = [];
    const rules = { tools: { write_alpha: "deny" as const, write_beta: "allow" as const } };
    const owned = await open(transport, { policy: rules, onAutoDecision: (event) => { events.push(event); } });

    try {
      expect((await owned.client.listTools()).tools.map((tool) => tool.name)).toEqual(["write_alpha", "write_beta"]);
      expect((await owned.client.callTool({ name: "write_alpha", arguments: { token: "denied" } })).isError).toBe(true);
      expect(await owned.receipts()).toEqual([]);
      expect((await owned.client.callTool({ name: "write_beta", arguments: { token: "allowed" } })).isError).not.toBe(true);
      expect(await owned.receipts()).toEqual([{ name: "write_beta", token: "allowed" }]);
      owned.gate.setPolicy({ tools: { "write_*": "allow", WRITE_ALPHA: "allow", constructor: "allow" } });
      expect((await owned.client.callTool({ name: "write_alpha", arguments: { token: "not-pattern-matched" } })).isError).toBe(true);
      const replacement: Required<Pick<McpToolPolicy, "tools">> = { tools: { write_alpha: "allow" } };
      owned.gate.setPolicy(replacement);
      replacement.tools.write_alpha = "deny";
      expect((await owned.client.callTool({ name: "write_alpha", arguments: { token: "snapshot" } })).isError).not.toBe(true);
      // SAFETY: JavaScript consumer input must not replace a valid installed policy.
      expect(() => owned.gate.setPolicy({ fallback: "typo" } as never)).toThrow();
      expect((await owned.client.callTool({ name: "write_alpha", arguments: { token: "still-allowed" } })).isError).not.toBe(true);
      expect(await owned.receipts()).toEqual([{ name: "write_beta", token: "allowed" }, { name: "write_alpha", token: "snapshot" }, { name: "write_alpha", token: "still-allowed" }]);
      expect(events.map(({ toolName, decision, match }) => ({ toolName, decision, match }))).toEqual([
        { toolName: "write_alpha", decision: "deny", match: "tool" },
        { toolName: "write_beta", decision: "allow", match: "tool" },
        { toolName: "write_alpha", decision: "deny", match: "fallback" },
        { toolName: "write_alpha", decision: "allow", match: "tool" },
        { toolName: "write_alpha", decision: "allow", match: "tool" },
      ]);
      expect(new Set(events.map((event) => event.decisionId)).size).toBe(events.length);

      for (const event of events) {
        expect(event.type).toBe("mcp_tool_auto_decision");
        expect(event.serverName).toBe("documents");
        expect(Object.isFrozen(event)).toBe(true);
        expect(Object.keys(event).sort()).toEqual(["decision", "decisionId", "match", "serverName", "toolName", "type"]);
      }
    } finally { await owned.close(); }

    events.length = 0;
    const disabled = await open(transport, { policy: { fallback: "allow" }, onAutoDecision: (event) => { events.push(event); } }, ["write_alpha"]);

    try {
      expect((await disabled.client.listTools()).tools.map((tool) => tool.name)).toEqual(["write_beta"]);
      expect((await disabled.client.callTool({ name: "write_alpha", arguments: { token: "direct-disabled-call" } })).isError).toBe(true);
      expect(await disabled.receipts()).toEqual([]);
      expect((await disabled.client.callTool({ name: "write_beta", arguments: { token: "enabled-control" } })).isError).not.toBe(true);
      expect(await disabled.receipts()).toEqual([{ name: "write_beta", token: "enabled-control" }]);
      expect(events.map(({ match, decision }) => ({ match, decision }))).toEqual([
        { match: "disabled", decision: "deny" }, { match: "fallback", decision: "allow" },
      ]);
    } finally { await disabled.close(); }
  });

  it("asks per invocation without changing arguments, isolating gates and preserving pending approvals across policy updates", async () => {
    const events: McpToolAutoDecisionEvent[] = [];
    const pending: Array<{ request: McpToolPermissionRequest; resolve: (value: "allow" | "deny") => void }> = [];
    const owned = await open(transport, { policy: { fallback: "ask" }, onAutoDecision: (event) => { events.push(event); }, onPermissionRequest: (request) => new Promise((resolve) => pending.push({ request, resolve })) });
    const other = await open(transport); // Same configured server/tool names, independent policy and upstream.

    try {
      const first = owned.client.callTool({ name: "write_alpha", arguments: { token: "first" } });
      const second = owned.client.callTool({ name: "write_alpha", arguments: { token: "second" } });
      await expect.poll(() => pending.length).toBe(2);
      expect(pending[0].request.serverName).toBe("documents");
      expect(pending[0].request.toolName).toBe("write_alpha");
      expect(pending[0].request.permissionId).not.toBe(pending[1].request.permissionId);
      expect(await owned.receipts()).toEqual([]);
      expect((await other.client.callTool({ name: "write_alpha", arguments: { token: "other-scope" } })).isError).toBe(true);
      expect(await other.receipts()).toEqual([]);
      owned.gate.setPolicy({ fallback: "deny" });
      const allow = pending.find((entry) => entry.request.arguments.token === "first")!;
      const deny = pending.find((entry) => entry.request.arguments.token === "second")!;
      Reflect.set(allow.request.arguments, "token", "tampered");
      allow.resolve("allow"); deny.resolve("deny");
      expect((await first).isError).not.toBe(true);
      expect((await second).isError).toBe(true);
      expect(await owned.receipts()).toEqual([{ name: "write_alpha", token: "first" }]);
      expect(events).toEqual([]); // Ask settlements must not masquerade as automatic policy matches.
      expect((await owned.client.callTool({ name: "write_alpha", arguments: { token: "new-policy" } })).isError).toBe(true);
      expect(pending).toHaveLength(2);
      expect(events).toMatchObject([{ toolName: "write_alpha", match: "fallback", decision: "deny" }]);
    } finally { await owned.close(); await other.close(); }
  });

  it("fails closed on missing, throwing, timed-out, or invalid approval handlers", async () => {
    for (const mode of ["missing", "throw", "timeout", "invalid"]) {
      let request: McpToolPermissionRequest | undefined;
      let late: ((value: "allow") => void) | undefined;
      const events: McpToolAutoDecisionEvent[] = [];

      const owned = await open(transport, { policy: { fallback: "ask" }, approvalTimeoutMs: 30,
        onAutoDecision: (event) => { events.push(event); },
        onPermissionRequest: mode === "missing" ? undefined : async (value) => {
          request = value;

          if (mode === "throw") throw new Error("synthetic-private-error");

          if (mode === "invalid") {
            // SAFETY: emulate an invalid JavaScript callback return.
            return "yes" as "allow";
          }

          return new Promise((resolve) => { late = resolve; });
        },
      });

      try {
        const result = await owned.client.callTool({ name: "write_alpha", arguments: { token: mode } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("synthetic-private-error");

        if (mode === "timeout") expect(request?.signal.aborted).toBe(true);
        late?.("allow");
        expect(events).toEqual([]);
        // A later successful request is the processing barrier for the rejected request.
        owned.gate.setPolicy({ fallback: "allow" });
        await owned.client.callTool({ name: "write_beta", arguments: { token: "control" } });
        expect(await owned.receipts()).toEqual([{ name: "write_beta", token: "control" }]);
      } finally { await owned.close(); }
    }
  });

  it.each(["cancel", "disconnect", "close"])("aborts pending Ask on %s without forwarding late approval", async (ending) => {
       const events: McpToolAutoDecisionEvent[] = [];
      let permission: McpToolPermissionRequest | undefined;
      let approve!: (value: "allow") => void;

       const owned = await open(transport, { maxConcurrentRequests: 1, policy: { fallback: "ask" }, onAutoDecision: (event) => { events.push(event); }, onPermissionRequest: (request) => {
        permission = request;

 return new Promise((resolve) => { approve = resolve; });
      } });

      try {
        const cancellation = new AbortController();
        const result = owned.client.callTool({ name: "write_alpha", arguments: { token: ending } }, undefined, { signal: cancellation.signal }).catch(() => undefined);
        await expect.poll(() => permission !== undefined).toBe(true);

        if (ending === "cancel") cancellation.abort();
        else if (ending === "disconnect") await owned.client.close();
        else await owned.gate.close();
        await expect.poll(() => permission?.signal.aborted).toBe(true);
        approve("allow");
         await result;
         expect(events).toEqual([]);

        if (ending === "cancel") {
          // Cancelling at full capacity must free admission, not just hide a pending call.
          owned.gate.setPolicy({ fallback: "allow" });
          await owned.client.callTool({ name: "write_beta", arguments: { token: "after-cancel" } });
          expect(await owned.receipts()).toEqual([{ name: "write_beta", token: "after-cancel" }]);
        } else {
        expect(await owned.receipts()).toEqual([]);
        }
      } finally { await owned.close(); }
  });

  it("isolates observer failures and policy reentrancy, and reports authorization rather than delivery on close", async () => {
    const events: McpToolAutoDecisionEvent[] = [];

    const owned = await open(transport, { policy: { fallback: "allow" }, onAutoDecision: (event) => {
      events.push(event);

      if (events.length === 1) { owned.gate.setPolicy({ fallback: "deny" }); throw new Error("private observer failure"); }

      if (events.length === 2) { owned.gate.setPolicy({ fallback: "allow" });

 return Promise.reject(new Error("private async failure")); }

      void owned.gate.close();
    } });

    try {
      expect((await owned.client.callTool({ name: "write_alpha", arguments: { token: "first" } })).isError).not.toBe(true);
      expect((await owned.client.callTool({ name: "write_alpha", arguments: { token: "second" } })).isError).toBe(true);
      await owned.client.callTool({ name: "write_alpha", arguments: { token: "closed" } }).catch(() => undefined);
      expect(events.map(({ match, decision }) => ({ match, decision }))).toEqual([
        { match: "fallback", decision: "allow" }, { match: "fallback", decision: "deny" }, { match: "fallback", decision: "allow" },
      ]);
      expect(await owned.receipts()).toEqual([{ name: "write_alpha", token: "first" }]);
    } finally { await owned.close(); }
  });

  it("requires gate credentials, rejects browser origins, and bounds concurrent approvals", async () => {
    let approve!: (value: "deny") => void;
    let waiting = false;

    const owned = await open(transport, { maxConcurrentRequests: 1, policy: { fallback: "ask" }, onPermissionRequest: () => {
      waiting = true;

 return new Promise((resolve) => { approve = resolve; });
    } });

    try {
      for (const authorization of [undefined, "Bearer upstream-secret", `bearer ${token}`]) {
        expect((await fetch(owned.url, { method: "POST", headers: authorization ? { authorization } : {} })).status).toBe(401);
      }

      expect((await fetch(owned.url, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://untrusted.example" } })).status).toBe(403);
      const result = owned.client.callTool({ name: "write_alpha", arguments: { token: "waiting" } });
      await expect.poll(() => waiting).toBe(true);
      expect((await fetch(owned.url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(429);
      approve("deny");
      expect((await result).isError).toBe(true);
      expect(await owned.receipts()).toEqual([]);
    } finally { await owned.close(); }
  });

  it("does not forward task extensions or non-tool methods and bounds malformed HTTP input", async () => {
    const owned = await open(transport, { policy: { fallback: "allow" } });

    try {
      // The upstream supports a real executable tool: denial is not a missing-tool artifact.
      await owned.client.callTool({ name: "write_alpha", arguments: { token: "control" } });
      await expect(owned.client.listResources()).rejects.toThrow();
      expect((await owned.client.callTool({ name: "write_alpha", arguments: { token: "task" }, task: { ttl: 10_000 } })).isError).toBe(true);
      expect(await owned.receipts()).toEqual([{ name: "write_alpha", token: "control" }]);
      expect((await fetch(owned.url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{" })).status).toBe(400);
      expect((await fetch(owned.url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: " ".repeat(1024 * 1024 + 1) })).status).toBe(413);
    } finally { await owned.close(); }
  });

  it("cancels numeric request ID zero and permits repeated cancellation without losing admission", async () => {
    const pending: Array<{ request: McpToolPermissionRequest; approve: (value: "allow") => void }> = [];

    const owned = await open(transport, { maxConcurrentRequests: 1, policy: { fallback: "ask" },
      onPermissionRequest: (request) => new Promise((approve) => pending.push({ request, approve })),
    }, [], true);

    const headers = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" });

    try {
      const initialized = await fetch(owned.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "initialize", method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw-boundary", version: "1" } } }) });

      expect(initialized.status).toBe(200);
      await initialized.text();
      headers.set("mcp-session-id", initialized.headers.get("mcp-session-id")!);
      headers.set("mcp-protocol-version", "2025-03-26");

      for (let id = 0; id < 20; id++) {
        const response = await fetch(owned.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "write_alpha", arguments: { token: `cancel-${id}` } } }) });
        const body = response.text().catch(() => "");
        await expect.poll(() => pending.length).toBe(id + 1);
        expect((await fetch(owned.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }) })).status).toBe(202);
        await expect.poll(() => pending[id].request.signal.aborted).toBe(true);
        pending[id].approve("allow");
        await body;
      }

      owned.gate.setPolicy({ fallback: "allow" });
      const control = await fetch(owned.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "control", method: "tools/call", params: { name: "write_beta", arguments: { token: "after-cancellations" } } }) });
      expect(control.status).toBe(200);
      await control.text();
      expect(await owned.receipts()).toEqual([{ name: "write_beta", token: "after-cancellations" }]);
    } finally { await owned.close(); }
  });
});

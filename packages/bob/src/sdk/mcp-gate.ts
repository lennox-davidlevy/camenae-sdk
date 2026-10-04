import { randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client, StreamableHTTPClientTransport, type CallToolRequest } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Server } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { CancelledNotificationSchema } from "@modelcontextprotocol/core";
import { serializeManagedMcp } from "../runtime/managed-mcp.js";
import { isFunction, isRecord, isString } from "../utils/type-guards.js";
import { PRODUCT_VERSION } from "../version.js";
import { BobError } from "./errors.js";
import type { BobManagedMcpServer } from "./types.js";

export interface McpToolPolicy {
  /** Exact tool names within this gate's configured server. No patterns. */
  tools?: Record<string, "allow" | "ask" | "deny">;
  /** Default deny. Applies to tools without an explicit rule, including new tools. */
  fallback?: "allow" | "ask" | "deny";
}

export interface McpToolPermissionRequest {
  readonly permissionId: string;
  readonly serverName: string;
  readonly toolName: string;
  /** Private data. A detached copy; callback mutation cannot change the forwarded call. */
  readonly arguments: Readonly<NonNullable<CallToolRequest["params"]["arguments"]>>;
  /** Aborts on disconnect, gate close, or approval deadline. */
  readonly signal: AbortSignal;
}

type AutoAttribution =
  | { match: "tool" | "fallback"; decision: "allow" | "deny" }
  | { match: "disabled"; decision: "deny" };

/** Local automatic authorization, not upstream delivery/execution or durable history.
 * Ask outcomes and requests rejected before authorization do not emit this event. */
export type McpToolAutoDecisionEvent = Readonly<{
  type: "mcp_tool_auto_decision";
  /** Unique per evaluated automatic call; not an ACP or MCP protocol request ID. */
  decisionId: string;
  serverName: string;
  toolName: string;
} & AutoAttribution>;

export interface McpToolGateOptions {
  /** Trusted configuration. Stdio runs in the application's environment, not Bob's worker. */
  server: BobManagedMcpServer;
  /** Application-generated secret for this gate only; never an upstream credential. */
  bearerToken: string;
  policy?: McpToolPolicy;
  onPermissionRequest?: (request: McpToolPermissionRequest) => Promise<"allow" | "deny">;
  /** Non-blocking observer. Exceptions/rejections are isolated. No arguments/results.
   * Reentrant policy changes affect later calls; close can still prevent forwarding. */
  onAutoDecision?: (event: McpToolAutoDecisionEvent) => void | Promise<void>;
  /** Default 60 seconds; bounded to 30 minutes. */
  approvalTimeoutMs?: number;
  /** Maximum concurrent HTTP requests, including pending approvals. Default 32. */
  maxConcurrentRequests?: number;
}

export interface McpToolGate {
  /** Mount at an application-owned HTTP route. Pass the original, unconsumed request.
   * Application owns TLS, listener/body deadlines, routing, and deployment isolation. */
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Replaces policy for future calls; pending approvals keep their original decision path. */
  setPolicy(policy: McpToolPolicy): void;
  /** Denies outstanding approvals, cancels forwarding, and closes the owned upstream client. */
  close(): Promise<void>;
}

/** One application/worker scope and one upstream server per gate. Tools only:
 * no resources, prompts, sampling, elicitation, tasks, replay, or ACP extensions. */
export async function createMcpToolGate(options: McpToolGateOptions): Promise<McpToolGate> {
  let definition: BobManagedMcpServer;
  let policy: ReturnType<typeof snapshotPolicy>;
  let timeout: number;
  let capacity: number;

  try {
    definition = structuredClone(options.server);
    serializeManagedMcp([definition]);

    if (!isString(options.bearerToken) || options.bearerToken.length < 32
      || !/^[\x21-\x7e]+$/.test(options.bearerToken)) throw new Error();

    if (options.onPermissionRequest !== undefined && !isFunction(options.onPermissionRequest)) throw new Error();

    if (options.onAutoDecision !== undefined && !isFunction(options.onAutoDecision)) throw new Error();
    policy = snapshotPolicy(options.policy ?? {});
    timeout = boundedInteger(options.approvalTimeoutMs ?? 60_000, 1_800_000);
    capacity = boundedInteger(options.maxConcurrentRequests ?? 32, 1024);
  } catch { throw new BobError("configuration_invalid"); }

  const expectedAuthorization = Buffer.from(`Bearer ${options.bearerToken}`);
  const ask = options.onPermissionRequest;
  const observe = options.onAutoDecision;
  const disabled = new Set(definition.disabledTools ?? []);
  const upstream = new Client({ name: "bob-gateway-mcp-gate", version: PRODUCT_VERSION });

  const transport = "type" in definition
    ? new StreamableHTTPClientTransport(new URL(definition.url), { requestInit: { headers: Object.fromEntries(definition.headers.map(({ name, value }) => [name, value])) } })
    : new StdioClientTransport({ command: definition.command, args: definition.args,
      env: Object.fromEntries(definition.env.map(({ name, value }) => [name, value])), stderr: "ignore" });

  const lifetime = new AbortController();
  const active = new Set<{ response: ServerResponse; controller: AbortController; completed: Promise<void> }>();
  let workRequests = 0;
  // The SDK owns MCP request IDs/cancellation; this context only binds an HTTP
  // disconnect to its handler, without interpreting or rewriting MCP messages.
  const context = new AsyncLocalStorage<{ response: ServerResponse; controller: AbortController }>();
  const server = new Server({ name: "bob-gateway-mcp-gate", version: PRODUCT_VERSION }, { capabilities: { tools: {} } });
  const downstream = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  let closing: Promise<void> | undefined;
  upstream.onclose = () => lifetime.abort();
  // Errors may include credentials or tool arguments; never log them here.
  upstream.onerror = () => {};

  try { await upstream.connect(transport, { timeout: 30_000 }); }
  catch { await upstream.close().catch(() => {}); throw new BobError("startup_failed"); }

  server.onerror = () => {};

  server.onclose = () => lifetime.abort();

  function report(toolName: string, attribution: AutoAttribution) {
    if (!observe) return;

    const event = Object.freeze({ type: "mcp_tool_auto_decision" as const, decisionId: randomUUID(),
      serverName: definition.name, toolName, ...attribution });

    try { void Promise.resolve(observe(event)).catch(() => {}); }
    catch { /* observer failures must not change authorization or expose private errors */ }
  }

  async function withRequest<T>(cancellation: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const requestContext = context.getStore();
    const signal = AbortSignal.any([requestContext?.controller.signal ?? lifetime.signal, lifetime.signal, cancellation]);
    // The SDK suppresses responses to cancelled requests. End their HTTP response
    // too, so cancellation does not consume admission indefinitely.
    const cancelled = () => requestContext?.response.destroy();
    cancellation.addEventListener("abort", cancelled, { once: true });

    try { return await operation(signal); }
    finally { cancellation.removeEventListener("abort", cancelled); }
  }

  server.setRequestHandler("tools/list", ({ params }, context) => withRequest(context.mcpReq.signal, async (signal) => {
    const result = await upstream.listTools(params, { signal, cacheMode: "refresh" });

    return { ...result, tools: result.tools.filter((tool) => !disabled.has(tool.name)) };
  }));
  server.setRequestHandler("tools/call", ({ params }, context) => withRequest(context.mcpReq.signal, async (signal) => {
    const denied = () => ({ isError: true, content: [{ type: "text" as const, text: "Tool call denied by Gateway MCP policy." }] });

    // Unknown extensions (notably task execution) must not escape synchronous authorization.
    if (Object.keys(params).some((key) => key !== "name" && key !== "arguments" && key !== "_meta") || signal.aborted) return denied();

    if (disabled.has(params.name)) {
      report(params.name, { match: "disabled", decision: "deny" });

      return denied();
    }

    const rule = policy.tools.get(params.name);
    const decision = rule ?? policy.fallback;

    if (decision !== "ask") report(params.name, { match: rule === undefined ? "fallback" : "tool", decision });

    if (decision === "deny") return denied();

    if (decision === "ask") {
      if (!ask) return denied();
      const deadline = new AbortController();
      const approvalSignal = AbortSignal.any([signal, deadline.signal]);
      const timer = setTimeout(() => deadline.abort(), timeout);
      let abort!: () => void;

      const interrupted = new Promise<"deny">((resolve) => {
        abort = () => resolve("deny");
        approvalSignal.addEventListener("abort", abort, { once: true });

        if (approvalSignal.aborted) abort();
      });

      try {
        const request = Object.freeze({ permissionId: randomUUID(), serverName: definition.name,
          toolName: params.name, arguments: structuredClone(params.arguments ?? {}), signal: approvalSignal });

        const answer = await Promise.race([Promise.resolve().then(() => approvalSignal.aborted ? "deny" : ask(request)).catch(() => "deny"), interrupted]);

        if (answer !== "allow" || approvalSignal.aborted) return denied();
      } finally {
        clearTimeout(timer);
        approvalSignal.removeEventListener("abort", abort);
      }
    }

    if (signal.aborted) return denied();

    // Forward only the actual call, never Bob-supplied metadata or task extensions.
    // Once forwarded, cancellation/revocation cannot undo upstream side effects.
    return upstream.callTool({ name: params.name, arguments: params.arguments }, { signal });
  }));
  await server.connect(downstream);

  function close(): Promise<void> {
    closing ??= (async () => {
      lifetime.abort();

      // Let active SDK handlers send their denial/cancellation response before
      // transport teardown. Requests still uploading a body have no handler.
      for (const { response } of active) if (!response.headersSent) response.destroy();
      const deadline = setTimeout(() => { for (const { response } of active) response.destroy(); }, 2_000);

      try { await Promise.all([...active].map(({ completed }) => completed)); }
      finally { clearTimeout(deadline); }

      try { await server.close(); } finally { await upstream.close(); }
    })();

    return closing;
  }

  return {
    setPolicy(next) {
      if (lifetime.signal.aborted) throw new BobError("closed");
      policy = snapshotPolicy(next);
    },
    async handleRequest(request, response) {
      const reject = (status: number) => { response.writeHead(status); response.end(); };

      const authorization = Buffer.from(request.headers.authorization ?? "");

      if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) { reject(401);

 return; }

      if (request.headers.origin !== undefined) { reject(403);

 return; }

      if (lifetime.signal.aborted) { reject(503);

 return; }

      if (request.method !== "POST" && request.method !== "DELETE") { reject(405);

 return; }

      // Reserve bounded admission for cancellation/DELETE even when approvals fill capacity.
      if (active.size >= capacity + 8) { reject(429);

 return; }

      const controller = new AbortController();
      let admitted = false;
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => { finish = resolve; });
      const entry = { response, controller, completed };
      active.add(entry);
      const disconnected = () => { controller.abort(); finish(); };

      response.once("close", disconnected);

      if (response.destroyed) disconnected();

      try {
        let body: unknown;

        if (request.method === "POST") {
          const chunks: Buffer[] = [];
          let size = 0;
          const timer = setTimeout(() => request.destroy(), 10_000);

          try {
            for await (const chunk of request) {
              size += chunk.length;

              if (size > 1024 * 1024) { reject(413);

 return; }

              chunks.push(chunk);
            }

            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
            catch { reject(400);

 return; }
          } finally { clearTimeout(timer); }
        }

        if (request.method !== "DELETE" && !CancelledNotificationSchema.safeParse(body).success) {
          if (workRequests >= capacity) { reject(429);

 return; }

          workRequests++;
          admitted = true;
        }

        await context.run(entry, () => downstream.handleRequest(request, response, body));
        // Streamable HTTP returns after opening an SSE response. Keep ownership
        // until its actual completion/disconnect, not merely until headers exist.
        await completed;
      } catch {
        if (!response.headersSent) reject(500);
        else response.destroy();
      } finally {
        if (admitted) workRequests--;
        controller.abort();
        response.removeListener("close", disconnected);
        active.delete(entry);

        if (lifetime.signal.aborted) await close();
      }
    },
    close,
  };
}

function snapshotPolicy(input: McpToolPolicy) {
  try {
    if (!isRecord(input)) throw new Error();
    const value = { ...input };

    if (Object.keys(value).some((key) => key !== "tools" && key !== "fallback")
      || (value.tools !== undefined && !isRecord(value.tools))) throw new Error();
    const fallback = value.fallback ?? "deny";
    const tools = new Map(Object.entries(value.tools ?? {}));

    if (![fallback, ...tools.values()].every((decision) => decision === "allow" || decision === "ask" || decision === "deny")
      || [...tools.keys()].some((name) => !name || name.includes("\0"))) throw new Error();

    return { tools, fallback };
  } catch { throw new BobError("configuration_invalid"); }
}

function boundedInteger(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error();

  return value;
}

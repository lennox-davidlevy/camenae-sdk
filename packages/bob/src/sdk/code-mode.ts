import { randomUUID } from "node:crypto";
import { Server, fromJsonSchema, type Transport, type JSONValue } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { JSONValueSchema } from "@modelcontextprotocol/core";
import { CodeMode, Tool, searchSignature } from "@opencode/codemode";
import { Effect, Schema } from "effect";
import { PRODUCT_VERSION } from "../version.js";
import { BobError } from "./errors.js";

export interface BobCodeModeCall {
  readonly executionId: string;
  readonly callId: string;
  readonly toolName: string;
  /** Detached JSON copy, not a reference to the executable arguments. */
  readonly input: JSONValue;
  readonly signal: AbortSignal;
}

/** JSON Schema subset accepted by both the validator and interpreter's catalog renderer. */
export interface BobCodeModeSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, BobCodeModeSchema>;
  required?: string[];
  additionalProperties?: boolean | BobCodeModeSchema;
  items?: BobCodeModeSchema;
  enum?: JSONValue[];
  anyOf?: BobCodeModeSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

export interface BobCodeModeTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: BobCodeModeSchema;
  readonly outputSchema: BobCodeModeSchema;
  /** Trusted host code. Must honor signal; runs outside the interpreter. */
  readonly execute: (input: JSONValue, context: BobCodeModeCall) => Promise<JSONValue>;
}

export interface BobCodeModeOptions {
  readonly tools: readonly BobCodeModeTool[];
  /** Required for EVERY nested call. Throws, absent callbacks and non-allow replies deny. */
  readonly authorize: (call: BobCodeModeCall) => Promise<"allow" | "deny">;
  readonly limits?: {
    /** Defaults: 30 seconds, 32 calls, 64 KiB retained output, 16 KiB source. */
    readonly timeoutMs?: number;
    readonly maxToolCalls?: number;
    readonly maxOutputBytes?: number;
    readonly maxCodeBytes?: number;
  };
}

export interface BobCodeMode {
  /** One transport per instance. HTTP authentication/listener ownership remains with the caller. */
  connect(transport: Transport): Promise<void>;
  /** Run in a dedicated MCP process; stdout is reserved for the official MCP transport. */
  connectStdio(): Promise<void>;
  /** Cancels observation and cooperative callbacks; not proof of external side-effect cleanup. */
  close(): Promise<void>;
}

/** Optional Bob tool composition over MCP. No Bob internals, fetch, imports or host globals. */
export function createBobCodeMode(options: BobCodeModeOptions): BobCodeMode {
  const limits = {
    timeoutMs: bounded(options.limits?.timeoutMs ?? 30_000, 300_000),
    maxToolCalls: bounded(options.limits?.maxToolCalls ?? 32, 256),
    maxOutputBytes: bounded(options.limits?.maxOutputBytes ?? 65_536, 1_048_576),
  };

  const maxCodeBytes = bounded(options.limits?.maxCodeBytes ?? 16_384, 65_536);
  const authorize = options.authorize;

  if (limits.maxOutputBytes < 512) throw new BobError("configuration_invalid");

  if (!authorize || options.tools.length > 128) throw new BobError("configuration_invalid");
  const names = new Set<string>();

  const definitions = options.tools.map((tool) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) || names.has(tool.name)) throw new BobError("configuration_invalid");
    names.add(tool.name);
    const inputSchema = structuredClone(tool.inputSchema), outputSchema = structuredClone(tool.outputSchema);

    return { name: tool.name, description: tool.description, execute: tool.execute, inputSchema, outputSchema,
      input: fromJsonSchema(inputSchema), output: fromJsonSchema(outputSchema) };
  });

  const lifetime = new AbortController();
  const server = new Server({ name: "camenae-bob-code-mode", version: PRODUCT_VERSION }, { capabilities: { tools: {} } });
  let connected = false;
  let busy = false;
  let closing: Promise<void> | undefined;
  // Keep admission closed while host callbacks ignore cancellation; never stack detached work.
  const callbacks = new Set<Promise<JSONValue>>();
  server.onerror = () => {};

  server.onclose = () => { lifetime.abort(); };

  server.setRequestHandler("tools/list", async () => ({ tools: [{
    name: "execute", description: `Compose application tools with a restricted JavaScript subset. No fetch, imports, filesystem, process or timers. Discover exact tool paths first with ${searchSignature}. Await calls; return only relevant JSON. Each nested call requires application authorization. Completed side effects are not rolled back on error or cancellation.`,
    inputSchema: { type: "object", properties: { code: { type: "string", maxLength: maxCodeBytes } }, required: ["code"], additionalProperties: false },
  }] }));
  server.setRequestHandler("tools/call", async ({ params }, context) => {
    const error = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

    if (lifetime.signal.aborted) return error("Code Mode closed.");

    if (busy || callbacks.size) return error("Code Mode busy; previous host work may still be running.");

    if (params.name !== "execute" || Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key))) return error("Unsupported Code Mode request.");
    const parsed = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(params.arguments);

    if (parsed._tag === "None" || Object.keys(params.arguments ?? {}).some((key) => key !== "code") || Buffer.byteLength(parsed.value.code) > maxCodeBytes) return error("Invalid Code Mode source.");
    busy = true;

    const executionId = randomUUID();
    const signal = AbortSignal.any([lifetime.signal, context.mcpReq.signal]);

    const tools = Object.fromEntries(definitions.map((definition) => [definition.name, Tool.make({
      description: definition.description, input: definition.inputSchema, output: definition.outputSchema,
      execute: (input) => Effect.tryPromise({
        try: async (interrupted) => {
          const callSignal = AbortSignal.any([signal, interrupted]);

          const operation = (async () => {
            callSignal.throwIfAborted();
            const checked = await definition.input["~standard"].validate(input);

            if (checked.issues) throw new Error("Invalid tool input.");

            const value = JSONValueSchema.parse(checked.value);

            const call = Object.freeze({ executionId, callId: randomUUID(), toolName: definition.name,
              input: structuredClone(value), signal: callSignal });

            const decision = await authorize(call);
            callSignal.throwIfAborted();

            if (decision !== "allow") throw new Error("Tool call denied.");
            const result = await definition.execute(value, call);
            callSignal.throwIfAborted();
            const checkedOutput = await definition.output["~standard"].validate(result);

            if (checkedOutput.issues) throw new Error("Invalid tool output.");

            return JSONValueSchema.parse(checkedOutput.value);
          })();

          callbacks.add(operation);

          try { return await operation; }
          finally { callbacks.delete(operation); }
        },
        // Application exceptions may contain credentials or private tool data.
        catch: () => new Error("Tool call failed or was denied."),
      }),
    })]));

    try {
      const runtime = CodeMode.make({ tools, limits });
      const result = await Effect.runPromise(runtime.execute(parsed.value.code), { signal });
      const text = JSON.stringify(result);

      // Upstream bounds retained values, but not thrown diagnostic messages.
      // Bound the complete wire result, including diagnostics and call records.
      if (Buffer.byteLength(text) > limits.maxOutputBytes) return error(JSON.stringify({ ok: false, truncated: true,
        error: { kind: "Truncated", message: "Execution result exceeded the output limit. Actions may have completed; do not replay automatically." }, toolCalls: [] }));

      return { isError: !result.ok, content: [{ type: "text" as const, text }] };
    } catch { return error("Code Mode interrupted or unavailable; completed actions are not rolled back."); }
    finally { busy = false; }
  });

  async function connect(transport: Transport) {
    if (connected || lifetime.signal.aborted) throw new BobError("closed");
    connected = true;

    try { await server.connect(transport); }
    catch { lifetime.abort(); await server.close(); throw new BobError("startup_failed"); }
  }

  return {
    connect,
    connectStdio: () => connect(new StdioServerTransport()),
    close() {
      lifetime.abort();
      closing ??= server.close();

      return closing;
    },
  };
}

function bounded(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new BobError("configuration_invalid");

  return value;
}

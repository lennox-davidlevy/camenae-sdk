import { isAbsolute } from "node:path";
import { type AuthenticateRequest, type ContentBlock, type McpServer } from "@agentclientprotocol/sdk";
import { NativeAcpClient, type NativeAcpEvent } from "../client/native-acp-client.js";
import { isFunction, isNumber, isRecord, isString } from "../utils/type-guards.js";
import { BobError, withCleanupFailure } from "./errors.js";
import { approvalDecision, copyApprovalPolicy } from "./approval-policy.js";
import type {
  BobAuthenticateOptions,
  BobApprovalPolicy,
  BobClient,
  BobEvent,
  BobHost,
  BobRunRequest,
  BobRunResult,
  BobStartOptions,
} from "./types.js";

const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;

const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 16 * 60_000;

const DEFAULT_MAX_TEXT_BYTES = 8 * 1024 * 1024;

const MAXIMUM_PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

const MAXIMUM_MODE_BYTES = 256;

export interface SessionOptions {
  workspace: string;
  promptTimeoutMs: number;
  maxTextBytes: number;
  host?: BobHost;
  approvalPolicy?: BobApprovalPolicy;
}

/** Shared session owner for native local and private-socket SDK clients. */
export class GatewaySession implements Omit<BobClient, "close"> {
  private state: "active" | "closing" | "closed" | "failed" = "active";
  private readonly listeners = new Set<(event: BobEvent) => void>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly activeSessions = new Set<string>();
  private readonly unsubscribeTransport: () => void;
  private terminalError: BobError | undefined;
  private closePromise: Promise<void> | undefined;
  private promptActive = false;
  private authenticationActive = false;
  private approvalPolicy: BobApprovalPolicy | undefined;

  constructor(
    private readonly options: SessionOptions,
    private readonly client: NativeAcpClient,
  ) {
    this.approvalPolicy = copyApprovalPolicy(options.approvalPolicy);
    this.unsubscribeTransport = client.subscribe((event) => this.onTransportEvent(event));
  }

  get initializeResult() { return this.client.initializeResult; }
  get workspace() { return this.options.workspace; }

  async authenticate(params: AuthenticateRequest, options: BobAuthenticateOptions = {}) {
    this.assertActive();

    if (this.authenticationActive || this.promptActive) throw new BobError("busy");
    let timeout: number;

    try {
      if (!isRecord(params) || !isString(params.methodId) || !params.methodId.trim() || !isRecord(options)) throw new Error();

      if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error();
      timeout = optionalPositiveInteger(options.timeoutMs, DEFAULT_AUTHENTICATION_TIMEOUT_MS);

      if (timeout > MAXIMUM_PROMPT_TIMEOUT_MS) throw new Error();
    } catch { throw new BobError("configuration_invalid"); }

    if (options.signal?.aborted) throw new BobError("cancelled");
    this.authenticationActive = true;
    let interruption: BobError | undefined;
    let interrupt!: (code: "cancelled" | "timeout") => void;

    const stopped = new Promise<never>((_, reject) => {
      interrupt = (code) => {
        interruption ??= new BobError(code);
        reject(interruption);
      };
    });

    const abort = () => interrupt("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => interrupt("timeout"), timeout);

    try {
      const result = await Promise.race([this.client.authenticate(params), stopped]);

      if (interruption) throw interruption;

      return result;
    } catch (error) {
      if (interruption) {
        // ACP has no login cancellation. Do not leave a callback listener running
        // after merely abandoning the wait. Remote close is only disconnection.
        try { await this.closeConnection(); } catch { throw withCleanupFailure(interruption); }

        throw interruption;
      }

      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      this.authenticationActive = false;
    }
  }

  async newSession(options: { mcpServers?: McpServer[] } = {}) {
    this.assertActive();
    const result = await this.client.newSession({ cwd: this.options.workspace, mcpServers: options.mcpServers });
    this.activeSessions.add(result.sessionId);

    return result;
  }

  listSessions(options = {}) {
    this.assertActive();

    return this.client.listSessions(options);
  }

  async loadSession(sessionId: string, options: { mcpServers?: McpServer[] } = {}) {
    this.assertActive();
    const result = await this.client.loadSession({ sessionId, cwd: this.options.workspace, mcpServers: options.mcpServers ?? [] });
    this.activeSessions.add(sessionId);

    return result;
  }

  async resumeSession(sessionId: string, options: { mcpServers?: McpServer[] } = {}) {
    this.assertActive();
    const result = await this.client.resumeSession({ sessionId, cwd: this.options.workspace, mcpServers: options.mcpServers ?? [] });
    this.activeSessions.add(sessionId);

    return result;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertActive();
    await this.client.deleteSession(sessionId);
    this.activeSessions.delete(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.assertActive();
    await this.client.closeSession(sessionId);
    this.activeSessions.delete(sessionId);
  }

  setMode(sessionId: string, modeId: string) {
    this.assertActive();
    validateMode(modeId);

    return this.client.setMode(sessionId, modeId);
  }

  setConfigOption(params: Parameters<BobClient["setConfigOption"]>[0]) {
    this.assertActive();

    return this.client.setConfigOption(params);
  }

  async prompt(sessionId: string, content: ContentBlock[]) {
    this.assertActive();

    if (!Array.isArray(content) || content.length === 0) throw new BobError("configuration_invalid");

    if (this.promptActive || this.authenticationActive) throw new BobError("busy");
    this.promptActive = true;

    try {
      return await this.client.prompt(sessionId, content);
    } finally {
      this.promptActive = false;
    }
  }

  cancel(sessionId: string) {
    this.assertActive();

    return this.client.cancel(sessionId);
  }

  respondToPermission(permissionId: string, optionId: string | null): void {
    this.assertActive();
    this.client.respondToPermission(permissionId, optionId);
  }

  setApprovalPolicy(policy: BobApprovalPolicy | undefined): void {
    this.assertActive();
    this.approvalPolicy = copyApprovalPolicy(policy);
  }

  subscribe(listener: (event: BobEvent) => void): () => void {
    this.assertActive();

    if (!isFunction(listener)) throw new BobError("configuration_invalid");
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  run(request: BobRunRequest): Promise<BobRunResult> {
    try {
      this.assertActive();
      validateRunRequest(request);
    } catch (error) {
      return Promise.reject(sdkError(error, "configuration_invalid"));
    }

    const operation = this.runImplementation(request);
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);

    return operation;
  }

  protected closeConnection(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeImplementation();

    return this.closePromise;
  }

  private async runImplementation(request: BobRunRequest): Promise<BobRunResult> {
    let sessionId: string | undefined;
    let text = "";
    let textBytes = 0;
    const abortController = new AbortController();
    let primaryError: BobError | undefined;
    let result: BobRunResult | undefined;

    const unsubscribe = this.subscribe((event) => {
      try { request.onEvent?.(event); } catch { /* application callbacks cannot break ACP */ }

      if (event.type !== "session_update" || event.notification.sessionId !== sessionId) return;
      const update = event.notification.update;

      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
      const bytes = Buffer.byteLength(update.content.text);

      if (textBytes + bytes > this.options.maxTextBytes) {
        abortController.abort(new BobError("output_limit"));

        return;
      }

      textBytes += bytes;
      text += update.content.text;
    });

    const abort = () => abortController.abort(new BobError("cancelled"));

    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => abortController.abort(new BobError("timeout")), this.options.promptTimeoutMs);

    try {
      if (abortController.signal.aborted) throw sdkError(abortController.signal.reason, "cancelled");
      const session = await this.newSession();
      sessionId = session.sessionId;

      if (request.mode) await this.setMode(sessionId, request.mode);
      const content = isString(request.prompt) ? [{ type: "text", text: request.prompt } satisfies ContentBlock] : request.prompt;

      if (abortController.signal.aborted) throw sdkError(abortController.signal.reason, "cancelled");
      const pendingPrompt = this.prompt(sessionId, content);

      const cancellation = new Promise<never>((_, reject) => {
        const cancel = () => {
          void this.client.cancel(sessionId!).catch(() => undefined);
          reject(sdkError(abortController.signal.reason, "cancelled"));
        };

        if (abortController.signal.aborted) cancel();
        else abortController.signal.addEventListener("abort", cancel, { once: true });
      });

      const response = await Promise.race([pendingPrompt, cancellation]);
      result = { text, stopReason: response.stopReason, response };
    } catch (error) {
      primaryError = sdkError(error, this.terminalError?.code ?? "protocol_failed");
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      unsubscribe();
    }

    const cleanupFailed = sessionId ? !(await this.tryCloseSession(sessionId)) : false;

    if (primaryError) throw cleanupFailed ? withCleanupFailure(primaryError) : primaryError;

    if (cleanupFailed) throw new BobError("cleanup_failed");

    if (!result) throw new BobError("protocol_failed");

    return result;
  }

  private onTransportEvent(event: NativeAcpEvent): void {
    let mapped: BobEvent = event.type === "diagnostic"
      ? { type: "diagnostic", byteCount: event.byteCount }
      : event;

    if (event.type === "permission_request") {
      const selection = approvalDecision(this.approvalPolicy, event.request);

      if (selection !== undefined) {
        const decision = Object.freeze({
          type: "permission_auto_decision" as const,
          permissionId: event.permissionId,
          sessionId: event.request.sessionId,
          toolCallId: event.request.toolCall.toolCallId,
          ...selection.attribution,
        });

        // This fulfills the local ACP response promise, not a transport acknowledgement.
        // A stale/failed settlement throws before any automatic event is dispatched.
        this.client.respondToPermission(event.permissionId, selection.optionId);
        mapped = decision;
      }
    }

    for (const listener of this.listeners) {
      try { listener(mapped); } catch { /* application callbacks cannot break ACP */ }
    }

    if ((event.type === "connection_error" || event.type === "exit") && !this.terminalError) {
      this.terminalError = new BobError(event.type === "exit" ? "child_exited" : "protocol_failed");
      this.state = "failed";
    }
  }

  private async tryCloseSession(sessionId: string): Promise<boolean> {
    try { await this.client.closeSession(sessionId);

 return true; } catch { return false; } finally { this.activeSessions.delete(sessionId); }
  }

  private async closeImplementation(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closing";

    // Cancellation is best effort: a peer that no longer reads stdin must not
    // prevent the transport owner from reaching bounded process termination.
    for (const sessionId of this.activeSessions) void this.client.cancel(sessionId).catch(() => undefined);

    try {
      await this.client.close();
      await Promise.allSettled(this.operations);
    } catch {
      throw new BobError("cleanup_failed");
    } finally {
      this.unsubscribeTransport();
      this.listeners.clear();
      this.activeSessions.clear();
      this.state = "closed";
    }
  }

  protected assertActive(): void {
    if (this.state !== "active") throw this.terminalError ?? new BobError("closed");
  }
}

export class BobSession extends GatewaySession implements BobClient {
  close(): Promise<void> { return this.closeConnection(); }
}

export function validateSessionOptions(options: Pick<BobStartOptions, "workspace" | "host" | "limits" | "approvalPolicy">): SessionOptions {
  try {
    if (!isRecord(options)) throw new Error();

    if (!isString(options.workspace) || !isAbsolute(options.workspace)) throw new Error();
    const promptTimeoutMs = optionalPositiveInteger(options.limits?.promptTimeoutMs, DEFAULT_PROMPT_TIMEOUT_MS);
    const maxTextBytes = optionalPositiveInteger(options.limits?.maxTextBytes, DEFAULT_MAX_TEXT_BYTES);
    validateHost(options.host);

    if (promptTimeoutMs > MAXIMUM_PROMPT_TIMEOUT_MS) throw new Error();

    return {
      workspace: options.workspace,
      promptTimeoutMs,
      maxTextBytes,
      host: options.host,
      approvalPolicy: copyApprovalPolicy(options.approvalPolicy),
    };
  } catch (error) {
    if (error instanceof BobError) throw error;
    throw new BobError("configuration_invalid");
  }
}

function validateHost(host: BobHost | undefined): void {
  if (host === undefined) return;

  if (!isRecord(host)) throw new Error();
  const terminalMethods = ["createTerminal", "terminalOutput", "waitForTerminalExit", "killTerminal", "releaseTerminal"] as const;

  for (const key of ["readTextFile", "writeTextFile", ...terminalMethods] as const) {
    if (host[key] !== undefined && !isFunction(host[key])) throw new Error();
  }

  const terminals = terminalMethods.filter((key) => host[key] !== undefined);

  if (terminals.length !== 0 && terminals.length !== terminalMethods.length) throw new Error();
}

function validateRunRequest(request: BobRunRequest): void {
  if (!isRecord(request) || !(isString(request.prompt) || Array.isArray(request.prompt))) throw new Error();

  if (request.mode !== undefined) validateMode(request.mode);

  if (request.onEvent !== undefined && !isFunction(request.onEvent)) throw new Error();

  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) throw new Error();
}

function validateMode(mode: string): void {
  if (!isString(mode) || !mode.trim() || Buffer.byteLength(mode) > MAXIMUM_MODE_BYTES) throw new BobError("configuration_invalid");
}

function optionalPositiveInteger<T>(value: T, fallback: number): number {
  if (value === undefined) return fallback;

  if (!isNumber(value) || !Number.isSafeInteger(value) || value <= 0) throw new Error();

  return value;
}

function sdkError<T>(error: T, fallback: ConstructorParameters<typeof BobError>[0]): BobError {
  return error instanceof BobError ? error : new BobError(fallback);
}

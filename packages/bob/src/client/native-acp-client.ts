import { Readable, Writable, type Duplex } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type Client,
  type CloseSessionResponse,
  type ContentBlock,
  type DeleteSessionResponse,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { PRODUCT_VERSION } from "../version.js";
import { BobError } from "../sdk/errors.js";
import { OwnedAcpProcess, type OwnedAcpProcessOptions } from "./owned-acp-process.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type NativeAcpClientOptions = (OwnedAcpProcessOptions | { transport: Duplex }) & {
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  host?: Pick<Client, "readTextFile" | "writeTextFile" | "createTerminal" | "terminalOutput" | "waitForTerminalExit" | "killTerminal" | "releaseTerminal">;
};

export type NativeAcpEvent =
  | { type: "session_update"; notification: SessionNotification }
  | { type: "permission_request"; permissionId: string; request: RequestPermissionRequest }
  | { type: "diagnostic"; source: "stderr"; byteCount: number }
  | { type: "connection_error" }
  | { type: "exit"; code: number | null; signal: string | null };

interface PendingPermission {
  request: RequestPermissionRequest;
  resolve(response: RequestPermissionResponse): void;
}

/** Owns one ACP subprocess while delegating all protocol framing to the official SDK. */
export class NativeAcpClient {
  private process: OwnedAcpProcess | undefined;
  private connection: ClientSideConnection | undefined;
  private initializeResultValue: InitializeResponse | undefined;
  private readonly listeners = new Set<(event: NativeAcpEvent) => void>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly cancelledTurns = new Set<string>();
  private nextPermissionId = 1;
  private state: "idle" | "starting" | "active" | "closing" | "closed" | "failed" = "idle";
  private startPromise: Promise<InitializeResponse> | undefined;
  private closePromise: Promise<void> | undefined;
  private terminationPromise: Promise<void> | undefined;

  constructor(private readonly options: NativeAcpClientOptions) {}

  get initializeResult(): InitializeResponse {
    if (!this.initializeResultValue) throw new Error("ACP client has not initialized");

    return this.initializeResultValue;
  }

  start(): Promise<InitializeResponse> {
    if (this.state === "active") return Promise.resolve(this.initializeResult);

    if (this.startPromise) return this.startPromise;

    if (this.state !== "idle") throw new Error(`ACP client cannot be started (${this.state})`);
    this.state = "starting";
    this.startPromise = this.spawnAndInitialize();

    return this.startPromise;
  }

  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // Interactive authentication has its own lifecycle in the session owner.
    return this.activeConnection().authenticate(params);
  }

  newSession(params: { cwd: string; mcpServers?: McpServer[] }): Promise<NewSessionResponse> {
    return this.withTimeout(this.activeConnection().newSession({
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    }));
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.withTimeout(this.activeConnection().loadSession(params));
  }

  listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    return this.withTimeout(this.activeConnection().listSessions(params));
  }

  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.withTimeout(this.activeConnection().resumeSession(params));
  }

  deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    return this.withTimeout(this.activeConnection().deleteSession({ sessionId }));
  }

  closeSession(sessionId: string): Promise<CloseSessionResponse> {
    return this.withTimeout(this.activeConnection().closeSession({ sessionId }));
  }

  setMode(sessionId: string, modeId: string): Promise<SetSessionModeResponse> {
    return this.withTimeout(this.activeConnection().setSessionMode({ sessionId, modeId }));
  }

  setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    return this.withTimeout(this.activeConnection().setSessionConfigOption(params));
  }

  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    const connection = this.activeConnection();
    this.cancelledTurns.delete(sessionId);

    return connection.prompt({ sessionId, prompt }).finally(() => this.cancelledTurns.delete(sessionId));
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelledTurns.add(sessionId);
    this.cancelPermissions(sessionId);
    await this.activeConnection().cancel({ sessionId });
  }

  respondToPermission(permissionId: string, optionId: string | null): void {
    const pending = this.permissions.get(permissionId);

    if (!pending) throw new BobError("configuration_invalid");

    if (optionId !== null && !pending.request.options.some((option) => option.optionId === optionId)) {
      throw new BobError("configuration_invalid");
    }

    this.permissions.delete(permissionId);
    pending.resolve({ outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } });
  }

  subscribe(listener: (event: NativeAcpEvent) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeImplementation();

    return this.closePromise;
  }

  private async spawnAndInitialize(): Promise<InitializeResponse> {
    try {
      let input: Writable;
      let output: Readable;

      if ("transport" in this.options) {
        input = this.options.transport;
        output = this.options.transport;
        this.options.transport.once("error", () => { void this.fail().catch(() => undefined); });
      } else {
        this.process = new OwnedAcpProcess(this.options);
        const child = this.process.child;
        input = child.stdin;
        output = child.stdout;
        child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
        child.once("error", () => { void this.fail().catch(() => undefined); });
        child.once("exit", (code, signal) => {
          this.emit({ type: "exit", code, signal });

          if (this.state !== "closing" && this.state !== "closed") void this.fail().catch(() => undefined);
        });
      }

      // SAFETY: Node's adapters wrap these byte-oriented child-process streams with the matching web stream contracts.
      const stream = ndJsonStream(
        Writable.toWeb(input) as WritableStream<Uint8Array>,
        Readable.toWeb(output) as ReadableStream<Uint8Array>,
      );

      const host = this.options.host;

      const client: Client = {
        readTextFile: host?.readTextFile?.bind(host),
        writeTextFile: host?.writeTextFile?.bind(host),
        createTerminal: host?.createTerminal?.bind(host),
        terminalOutput: host?.terminalOutput?.bind(host),
        waitForTerminalExit: host?.waitForTerminalExit?.bind(host),
        killTerminal: host?.killTerminal?.bind(host),
        releaseTerminal: host?.releaseTerminal?.bind(host),
        sessionUpdate: (notification) => { this.emit({ type: "session_update", notification }); },
        requestPermission: (request) => this.requestPermission(request),
      };

      const connection = new ClientSideConnection(() => client, stream);
      this.connection = connection;
      connection.closed.then(() => {
        if (this.state !== "closing" && this.state !== "closed") void this.fail().catch(() => undefined);
      }).catch(() => { void this.fail().catch(() => undefined); });

      const result = await this.withTimeout(connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: Boolean(client.readTextFile),
            writeTextFile: Boolean(client.writeTextFile),
          },
          terminal: Boolean(client.createTerminal),
        },
        clientInfo: { name: "bob-gateway", title: "Bob Gateway", version: PRODUCT_VERSION },
      }));

      if (this.state !== "starting") {
        await this.terminateChild();
        throw new Error("ACP client closed during initialization");
      }

      this.initializeResultValue = result;
      this.state = "active";

      return result;
    } catch (error) {
      await this.fail();
      throw error;
    }
  }

  private requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // Requests already in flight can arrive after the cancellation notification.
    if (this.cancelledTurns.has(request.sessionId) || this.state === "closing" || this.state === "closed" || this.state === "failed") {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }

    const permissionId = String(this.nextPermissionId++);

    return new Promise((resolve) => {
      this.permissions.set(permissionId, { request, resolve });
      this.emit({ type: "permission_request", permissionId, request });
    });
  }

  private withTimeout<T>(operation: Promise<T>): Promise<T> {
    const timeout = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new BobError("timeout")), timeout);
      operation.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  private activeConnection(): ClientSideConnection {
    if (this.state !== "active" || !this.connection) throw new Error(`ACP client is not active (${this.state})`);

    return this.connection;
  }

  private cancelPermissions(sessionId?: string): void {
    for (const [id, pending] of this.permissions) {
      if (sessionId !== undefined && pending.request.sessionId !== sessionId) continue;
      this.permissions.delete(id);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  private onStderr(chunk: Buffer): void {
    this.emit({ type: "diagnostic", source: "stderr", byteCount: chunk.length });
  }

  private async fail(): Promise<void> {
    if (this.state === "closed" || this.state === "closing" || this.state === "failed") return;
    this.state = "failed";
    this.emit({ type: "connection_error" });
    this.cancelPermissions();
    await this.terminateChild();
  }

  private async closeImplementation(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closing";
    this.cancelPermissions();
    this.cancelledTurns.clear();
    await this.terminateChild();
    this.state = "closed";
  }

  private terminateChild(): Promise<void> {
    this.terminationPromise ??= this.terminateChildImplementation();

    return this.terminationPromise;
  }

  private async terminateChildImplementation(): Promise<void> {
    if ("transport" in this.options) this.options.transport.destroy();
    await this.process?.close();
  }

  private emit(event: NativeAcpEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* subscribers cannot break the connection */ }
    }
  }
}

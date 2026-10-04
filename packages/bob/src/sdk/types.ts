import type {
  AuthenticateRequest,
  AuthenticateResponse,
  Client,
  ContentBlock,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  ResumeSessionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeResponse,
  StopReason,
} from "@agentclientprotocol/sdk";

export type BobCredential =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "sso" }
  | { kind: "gatewayUserConfig" };

/** Bob-reported presentation categories, not tool identities or a sandbox. */
export type BobApprovalKind = "edit" | "delete" | "execute" | "search" | "fetch";

export type BobApprovalDecision = "allow" | "deny" | "ask";

export interface BobApprovalPolicy {
  /** Exact category takes precedence, including an explicit ask. */
  kinds?: Partial<Record<BobApprovalKind, BobApprovalDecision>>;
  /** Missing/unknown/other categories never receive an implicit allow. Default: ask. */
  fallback?: "ask" | "deny";
}

/** Complete native MCP definitions managed at worker startup. */
export type BobManagedMcpServer = (
  | Pick<Extract<McpServer, { command: string }>, "name" | "command" | "args" | "env">
  | Pick<Extract<McpServer, { type: "http" }>, "name" | "type" | "url" | "headers">
) & {
  disabledTools?: string[];
  /** Exact native MCP tool names exempted from ACP permission requests.
   * Category policies do not intercept these calls. Disabled tools stay disabled.
   * For gated tools this delegates authorization to the trusted gate. */
  alwaysAllow?: string[];
};

export type BobToolGroup = "read" | "edit" | "execute" | "browser" | "mcp" | "skill" | "todo" | "artifact" | "subtask" | "subagent" | "mode" | "workflow";

export type BobModeGroup = BobToolGroup | [BobToolGroup, { fileRegex: string }];

/** Native Bob persona and tool availability, not an approval policy or sandbox. */
export interface BobCustomMode {
  slug: string;
  name: string;
  roleDefinition: string;
  description?: string;
  whenToUse?: string;
  customInstructions?: string;
  /** Omitted or empty means no grouped tools. */
  groups?: BobModeGroup[];
}

export interface BobStartOptions {
  credential: BobCredential;
  workspace: string;
  /** Overrides for the inherited process environment. Undefined removes a variable. */
  environment?: Record<string, string | undefined>;
  /** Application-owned host operations. Omitted capabilities are not advertised. */
  host?: BobHost;
  /** Per-client override; otherwise honors BOB_GATEWAY_AUTO_APPROVE (default true). */
  autoApprove?: boolean;
  /** Client-wide policy for newly received requests. Requires native autoApprove: false. */
  approvalPolicy?: BobApprovalPolicy;
  disableMcp?: boolean;
  /** Opt in to ownership of workspace/.bob/mcp.json. Requires exclusive workspace
   * configuration ownership; replace the old worker before applying changes.
   * Omitted leaves files untouched; [] writes an empty managed server set. */
  managedMcpServers?: BobManagedMcpServer[];
  /** Own workspace/.bob/custom_modes.yaml at startup. Omitted leaves it untouched;
   * [] writes an empty managed set. Requires exclusive ownership and old-worker
   * teardown; refuses unmanaged or edited files and persists after close. */
  managedCustomModes?: BobCustomMode[];
  disableSubagents?: boolean;
  limits?: {
    promptTimeoutMs?: number;
    maxTextBytes?: number;
  };
}

export interface BobConnectOptions extends Pick<BobStartOptions, "workspace" | "host" | "limits" | "approvalPolicy"> {
  socketPath: string;
  credential: Exclude<BobCredential, { kind: "gatewayUserConfig" }>;
}

export interface BobServeOptions extends Pick<BobStartOptions, "workspace" | "environment" | "autoApprove" | "disableMcp" | "disableSubagents" | "managedMcpServers" | "managedCustomModes"> {
  socketPath: string;
  signal: AbortSignal;
}

/** Remote disconnection does not confirm worker/process cleanup. */
export interface BobRemoteClient extends Omit<BobClient, "close"> {
  disconnect(): Promise<void>;
}

/** Terminal support requires all five operations. The application owns these resources. */
export type BobHost = Pick<Client, "readTextFile" | "writeTextFile"> & (
  | Required<Pick<Client, "createTerminal" | "terminalOutput" | "waitForTerminalExit" | "killTerminal" | "releaseTerminal">>
  | { createTerminal?: never; terminalOutput?: never; waitForTerminalExit?: never; killTerminal?: never; releaseTerminal?: never }
);

/** Frozen local permission settlement, not Bob receipt, execution, or durable delivery.
 * Correlation IDs can contain sensitive tool arguments; never log the full event. */
export type BobPermissionAutoDecisionEvent = Readonly<{
  type: "permission_auto_decision";
  permissionId: string;
  sessionId: string;
  toolCallId: string;
} & (
  | { match: "category"; kind: BobApprovalKind; decision: "allow" | "deny" }
  | { match: "fallback"; kind: string | null; decision: "deny" }
)>;

/** Bob-owned root-session accounting in update._meta["bob-gateway/usage"].
 * Snapshot, not a delta or billing receipt. Null means unavailable. */
export interface BobSessionUsage {
  version: 1;
  contextTokens: number | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** Fraction (0–1) at which Bob considers compaction, not another token limit. */
  compactionThreshold: number | null;
  autoCompact: boolean;
  /** Native cumulative credits; missing provider charges cannot be reconstructed. */
  bobcoins: number | null;
}

export type BobEvent =
  | BobPermissionAutoDecisionEvent
  | { type: "session_update"; notification: SessionNotification }
  | { type: "permission_request"; permissionId: string; request: RequestPermissionRequest }
  | { type: "diagnostic"; byteCount: number }
  | { type: "connection_error" }
  | { type: "exit"; code: number | null; signal: string | null };

export interface BobRunRequest {
  mode?: string;
  prompt: string | ContentBlock[];
  signal?: AbortSignal;
  onEvent?: (event: BobEvent) => void;
}

export interface BobRunResult {
  text: string;
  stopReason: StopReason;
  response: PromptResponse;
}

export interface BobAuthenticateOptions {
  /** Aborting an in-flight login closes this client; remote cleanup is not confirmed. */
  signal?: AbortSignal;
  /** Defaults to 16 minutes (Bob's callback wait is 15 minutes). Timeout closes this client. */
  timeoutMs?: number;
}

export interface BobClient {
  /** Caller-owned working directory, resolved to its real path. Never copied or deleted. */
  readonly workspace: string;
  readonly initializeResult: InitializeResponse;
  authenticate(params: AuthenticateRequest, options?: BobAuthenticateOptions): Promise<AuthenticateResponse>;
  newSession(options?: { mcpServers?: McpServer[] }): Promise<NewSessionResponse>;
  listSessions(options?: ListSessionsRequest): Promise<ListSessionsResponse>;
  loadSession(sessionId: string, options?: { mcpServers?: McpServer[] }): Promise<LoadSessionResponse>;
  resumeSession(sessionId: string, options?: { mcpServers?: McpServer[] }): Promise<ResumeSessionResponse>;
  deleteSession(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<SetSessionModeResponse>;
  setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
  prompt(sessionId: string, content: ContentBlock[]): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  respondToPermission(permissionId: string, optionId: string | null): void;
  /** Atomically replaces the client-wide policy; undefined restores manual handling.
   * Does not re-evaluate pending requests or clear Bob's native Always memory. */
  setApprovalPolicy(policy: BobApprovalPolicy | undefined): void;
  subscribe(listener: (event: BobEvent) => void): () => void;
  run(request: BobRunRequest): Promise<BobRunResult>;
  close(): Promise<void>;
}

export type {
  AuthenticateRequest,
  AuthenticateResponse,
  ContentBlock,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  ResumeSessionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeResponse,
  StopReason,
};

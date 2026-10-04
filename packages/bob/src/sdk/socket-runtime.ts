import { chmodSync, realpathSync, statSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import compatibility from "../../runtime/compatibility.json";
import { NativeAcpClient } from "../client/native-acp-client.js";
import { OwnedAcpProcess } from "../client/owned-acp-process.js";
import { readBootstrap } from "../client/socket-bootstrap.js";
import { preparePackageRuntime } from "../runtime/package-runtime.js";
import { serializeManagedMcp, writeManagedMcp } from "../runtime/managed-mcp.js";
import { serializeCustomModes, writeCustomModes } from "../runtime/managed-custom-modes.js";
import { isBoolean, isRecord, isString } from "../utils/type-guards.js";
import { BobError } from "./errors.js";
import { GatewaySession, validateSessionOptions } from "./session-client.js";
import type { BobConnectOptions, BobRemoteClient, BobServeOptions } from "./types.js";

class RemoteSession extends GatewaySession implements BobRemoteClient {
  disconnect(): Promise<void> { return this.closeConnection(); }
}

export async function connectSocket(options: BobConnectOptions): Promise<BobRemoteClient> {
  const validated = validateSessionOptions(options);

  if ("managedMcpServers" in options || "managedCustomModes" in options) throw new BobError("configuration_invalid");
  validateSocketPath(options.socketPath);

  if (options.credential?.kind !== "sso" && (options.credential?.kind !== "apiKey" || !isString(options.credential.apiKey) || !validKey(options.credential.apiKey))) throw new BobError("configuration_invalid");
  const socket = createConnection({ path: options.socketPath });
  // Bootstrap and ACP readers own error reporting; never let a late socket error escape.
  socket.on("error", () => {});
  let client: NativeAcpClient | undefined;

  try {
    const greeting = readBootstrap(socket);
    // Preserve v1 interoperability for keys; SSO must never fall back to a key.
    const version = options.credential.kind === "sso" ? 2 : 1;
    const credential = options.credential.kind === "sso" ? { credential: { kind: "sso" } } : { apiKey: options.credential.apiKey };
    socket.write(JSON.stringify({ version, ...credential, workspace: validated.workspace }) + "\n");
    const response: unknown = JSON.parse((await greeting).toString("utf8"));

    if (isRecord(response) && response.status === "busy") throw new BobError("busy");

    if (!isRecord(response) || response.version !== version || response.status !== "ready") throw new Error();
    client = new NativeAcpClient({ transport: socket, host: validated.host });
    const initialized = await client.start();

    if (initialized.agentInfo?.name !== "bob-shell" || initialized.agentInfo.version !== compatibility.bob.version) throw new Error();

    return new RemoteSession(validated, client);
  } catch (error) {
    socket.destroy();
    await client?.close();
    throw error instanceof BobError ? error : new BobError("startup_failed");
  }
}

/** Returns after one connection or abort. The owning worker entrypoint must then exit. */
export async function serveSocketOnce(options: BobServeOptions): Promise<void> {
  validateSocketPath(options.socketPath);
  const managedMcp = serializeManagedMcp(options.managedMcpServers, options.disableMcp);
  const customModes = serializeCustomModes(options.managedCustomModes);
  let workspace: string;
  let environment: NodeJS.ProcessEnv;

  try {
    if (!isAbsolute(options.workspace) || !statSync(options.workspace).isDirectory()) throw new Error();
    workspace = realpathSync(options.workspace);
    const parent = statSync(dirname(options.socketPath));

    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) throw new Error();

    for (const flag of [options.autoApprove, options.disableMcp, options.disableSubagents]) {
      if (flag !== undefined && !isBoolean(flag)) throw new Error();
    }

    if (options.environment !== undefined && (!isRecord(options.environment) || Object.entries(options.environment).some(([key, value]) =>
      !key || key.includes("=") || key.includes("\0") || (value !== undefined && (!isString(value) || value.includes("\0")))))) throw new Error();
    environment = { ...process.env, ...options.environment };

    if (!(options.signal instanceof AbortSignal)) throw new Error();
  } catch { throw new BobError("configuration_invalid"); }

  if (options.signal.aborted) return;

  await new Promise<void>((resolve, reject) => {
    let claimed = false;
    let stopping = false;
    let activeSocket: Socket | undefined;

    const server = createServer((socket) => {
      socket.on("error", () => {});

      if (claimed || stopping) {
        // Let FIN flush the reply before teardown; Bun's end callback may run
        // before the peer receives buffered bytes. Bound peers that never close.
        const deadline = setTimeout(() => socket.destroy(), 1_000);
        socket.once("close", () => clearTimeout(deadline));
        socket.end('{"version":1,"status":"busy"}\n');

        return;
      }

      claimed = true;
      activeSocket = socket;
      void runConnection(socket).then(() => finish(), (error) => finish(error instanceof BobError ? error : new BobError("startup_failed")));
    });

    const finish = (error?: BobError) => {
      if (stopping) return;
      stopping = true;
      options.signal.removeEventListener("abort", abort);
      activeSocket?.destroy();
      server.close(() => {
        if (error instanceof BobError && error.code === "cleanup_failed") reject(error);
        else if (error && !options.signal.aborted) reject(error.code === "configuration_invalid" ? error : new BobError("startup_failed"));
        else resolve();
      });
    };

    const abort = () => {
      if (activeSocket) activeSocket.destroy();
      else finish();
    };

    const runConnection = async (socket: Socket) => {
      let owned: OwnedAcpProcess | undefined;
      let failure: BobError | undefined;

      try {
        const request: unknown = JSON.parse((await readBootstrap(socket)).toString("utf8"));

        if (!isRecord(request) || request.workspace !== workspace) throw new Error();
        let authentication: "sso" | undefined;
        let childEnvironment: NodeJS.ProcessEnv;

        if (request.version === 2 && isRecord(request.credential) && request.credential.kind === "sso") {
          if ("apiKey" in request || Object.keys(request.credential).some((key) => key !== "kind")) throw new Error();
          authentication = "sso";
          childEnvironment = environment;
        } else {
          if (request.version !== 1 || "credential" in request || !isString(request.apiKey) || !validKey(request.apiKey)) throw new Error();
          childEnvironment = { ...environment, BOB_API_KEY: request.apiKey };
        }

        const runtime = await preparePackageRuntime({
          ...options, autoApprove: options.autoApprove ?? false,
          authentication, childEnvironment,
        });

        if (socket.destroyed || options.signal.aborted) throw new Error();
        owned = new OwnedAcpProcess({ command: process.execPath, args: runtime.args, cwd: workspace, env: runtime.environment, inheritProcessEnv: false });
        const child = owned.child;
        child.stderr.resume();
        await new Promise<void>((done, failed) => {
          socket.once("close", done);
          child.once("exit", () => done());
          child.once("error", failed);
          child.stdin.once("error", failed);
          child.stdout.once("error", failed);
          socket.write(JSON.stringify({ version: request.version, status: "ready" }) + "\n");
          socket.pipe(child.stdin);
          child.stdout.pipe(socket);
        });
      } catch {
        failure = new BobError("startup_failed");
      } finally {
        socket.unpipe();
        owned?.child.stdout.unpipe();

        try { await owned?.close(); } catch { failure = new BobError("cleanup_failed"); }
        finally { socket.destroy(); }
      }

      if (failure) throw failure;
    };

    server.once("error", () => finish(new BobError("startup_failed")));
    options.signal.addEventListener("abort", abort, { once: true });
    server.listen(options.socketPath, () => {
      try {
        chmodSync(options.socketPath, 0o600);
        writeManagedMcp(workspace, managedMcp);
        writeCustomModes(workspace, customModes);
      } catch (error) { finish(error instanceof BobError ? error : new BobError("startup_failed")); }
    });
  });
}

function validateSocketPath(path: string): void {
  if (!isString(path) || !isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path) > 100 || process.platform === "win32") {
    throw new BobError("configuration_invalid");
  }
}

function validKey(key: string): boolean {
  return key.trim().length > 0 && Buffer.byteLength(key) <= 4096 && !key.includes("\0");
}

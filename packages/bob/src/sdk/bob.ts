import { realpathSync, statSync } from "node:fs";
import { NativeAcpClient } from "../client/native-acp-client.js";
import { preparePackageRuntime } from "../runtime/package-runtime.js";
import { serializeManagedMcp, writeManagedMcp } from "../runtime/managed-mcp.js";
import { serializeCustomModes, writeCustomModes } from "../runtime/managed-custom-modes.js";
import compatibility from "../../runtime/compatibility.json";
import { isBoolean, isRecord, isString } from "../utils/type-guards.js";
import { BobError } from "./errors.js";
import { BobSession, validateSessionOptions } from "./session-client.js";
import type { BobClient, BobConnectOptions, BobRemoteClient, BobServeOptions, BobStartOptions } from "./types.js";
import { connectSocket, serveSocketOnce } from "./socket-runtime.js";

export class Bob {
  static connect(options: BobConnectOptions): Promise<BobRemoteClient> {
    return connectSocket(options);
  }

  static serveOnce(options: BobServeOptions): Promise<void> {
    return serveSocketOnce(options);
  }

  static async start(options: BobStartOptions): Promise<BobClient> {
    const validated = validateSessionOptions(options);
    const managedMcp = serializeManagedMcp(options.managedMcpServers, options.disableMcp);
    const customModes = serializeCustomModes(options.managedCustomModes);

    if (validated.approvalPolicy && options.autoApprove !== false) throw new BobError("configuration_invalid");
    let environment: NodeJS.ProcessEnv;

    try {
      // Reject removed policy options rather than silently editing a caller's source tree.
      if ("execution" in options || "launcherEntrypoint" in options || "taskProfile" in options) throw new Error();

      if (!statSync(options.workspace).isDirectory()) throw new Error();
      validated.workspace = realpathSync(options.workspace);

      for (const flag of [options.autoApprove, options.disableMcp, options.disableSubagents]) {
        if (flag !== undefined && !isBoolean(flag)) throw new Error();
      }

      if (options.environment !== undefined && (!isRecord(options.environment) || Object.entries(options.environment).some(([key, value]) => !key || key.includes("=") || key.includes("\0") || (value !== undefined && (!isString(value) || value.includes("\0")))))) throw new Error();
      environment = { ...process.env, ...options.environment };

      if (options.credential?.kind === "apiKey") {
        if (!isString(options.credential.apiKey) || !options.credential.apiKey.trim()) throw new Error();
        environment.BOB_API_KEY = options.credential.apiKey;
      } else if (options.credential?.kind !== "gatewayUserConfig" && options.credential?.kind !== "sso") throw new Error();
    } catch { throw new BobError("configuration_invalid"); }

    let client: NativeAcpClient | undefined;

    try {
      const runtime = await preparePackageRuntime({ ...options, childEnvironment: environment,
        authentication: options.credential.kind === "sso" ? "sso" : undefined });

      writeManagedMcp(validated.workspace, managedMcp);
      writeCustomModes(validated.workspace, customModes);
      client = new NativeAcpClient({
        command: process.execPath,
        args: runtime.args,
        cwd: validated.workspace,
        env: runtime.environment,
        inheritProcessEnv: false,
        host: validated.host,
      });
      const initialized = await client.start();

      if (initialized.agentInfo?.name !== "bob-shell" || initialized.agentInfo.version !== compatibility.bob.version) throw new Error("Bob identity mismatch");

      return new BobSession(validated, client);
    } catch (error) {
      let cleanupFailed = false;

      try { await client?.close(); } catch { cleanupFailed = true; }

      if (error instanceof BobError && error.code === "configuration_invalid" && !cleanupFailed) throw error;
      throw new BobError("startup_failed", cleanupFailed);
    }
  }
}

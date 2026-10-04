import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ownedProcessTree, signalOwnedProcesses } from "./process-tree.js";

export interface OwnedAcpProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inheritProcessEnv?: boolean;
  shutdownTimeoutMs?: number;
}

/** One process owner shared by local ACP clients and isolated-runtime listeners. */
export class OwnedAcpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: OwnedAcpProcessOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.inheritProcessEnv === false ? options.env : { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeImplementation();

    return this.closePromise;
  }

  private async closeImplementation(): Promise<void> {
    const child = this.child;

    if (!child.pid) return;

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await new Promise<void>((resolve) => killer.once("close", () => resolve()));

      return;
    }

    let discoveryFailed = false;
    let descendants = new Map<number, string>();

    try { descendants = ownedProcessTree(child.pid); } catch { discoveryFailed = true; }

    try { signalOwnedProcesses(descendants, "SIGTERM"); } catch { discoveryFailed = true; }

    try { process.kill(-child.pid, "SIGTERM"); } catch { /* leader may already have exited */ }

    await waitForExit(child, this.options.shutdownTimeoutMs ?? 15_000);

    // The leader can exit before descendants; always target its owned group.
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group exited */ }

    try { descendants = ownedProcessTree(child.pid, descendants); } catch { discoveryFailed = true; }

    try { signalOwnedProcesses(descendants, "SIGKILL"); } catch { discoveryFailed = true; }

    await waitForExit(child, this.options.shutdownTimeoutMs ?? 15_000);

    if (child.exitCode === null && child.signalCode === null) throw new Error("Owned child did not exit");

    if (discoveryFailed) throw new Error("Could not verify descendant cleanup");
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(); };

    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as processTree from "../../src/client/process-tree.js";
import { NativeAcpClient } from "../../src/client/native-acp-client.js";

const fixture = fileURLToPath(new URL("../sdk/fixtures/sdk-acp-fixture.mjs", import.meta.url));

describe("NativeAcpClient lifecycle", () => {
  it.each(["initial", "escalation"])("still terminates the group when %s process discovery fails", async (phase) => {
    const client = new NativeAcpClient({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/process-tree-agent.mjs", import.meta.url))], shutdownTimeoutMs: 500 });
    const initialized = await client.start();
    const descendant = Number(initialized.agentInfo?.title);
    const original = processTree.ownedProcessTree;
    const discovery = vi.spyOn(processTree, "ownedProcessTree");

    if (phase === "escalation") discovery.mockImplementationOnce(original);
    discovery.mockImplementationOnce(() => { throw new Error("snapshot unavailable"); });

    try {
      await expect(client.close()).rejects.toThrow("Could not verify descendant cleanup");
      await expect.poll(() => alive(descendant), { timeout: 2_000 }).toBe(false);
    } finally {
      discovery.mockRestore();
      await client.close().catch(() => undefined);

      try { process.kill(descendant, "SIGKILL"); } catch { /* already exited */ }
    }
  });
  it.each([false, true])("kills a TERM-resistant descendant on close (detached=%s)", async (detached) => {
    const client = new NativeAcpClient({
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/process-tree-agent.mjs", import.meta.url)), ...(detached ? ["--detached-child"] : [])],
      shutdownTimeoutMs: 500,
    });

    const initialized = await client.start();
    const descendant = Number(initialized.agentInfo?.title);

    try {
      await client.close();
      await expect.poll(() => alive(descendant), { timeout: 2_000 }).toBe(false);
    } finally {
      await client.close();

      try { process.kill(descendant, "SIGKILL"); } catch { /* already exited */ }
    }
  });

  it.each([false, true])("kills surviving group members when the leader exits first (discovery failure=%s)", async (discoveryFailure) => {
    const client = new NativeAcpClient({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/process-tree-agent.mjs", import.meta.url))], shutdownTimeoutMs: 500 });
    const initialized = await client.start();
    const descendant = Number(initialized.agentInfo?.title);
    const discovery = discoveryFailure ? vi.spyOn(processTree, "ownedProcessTree").mockImplementationOnce(() => { throw new Error("snapshot unavailable"); }) : undefined;
    const exited = new Promise<void>((resolve) => client.subscribe((event) => { if (event.type === "exit") resolve(); }));

    try {
      await client.prompt("tree-session", [{ type: "text", text: "exit" }]);
      await exited;

      if (discoveryFailure) await expect(client.close()).rejects.toThrow("Could not verify descendant cleanup");
      else await client.close();
      await expect.poll(() => alive(descendant), { timeout: 2_000 }).toBe(false);
    } finally {
      discovery?.mockRestore();
      await client.close().catch(() => undefined);

      try { process.kill(descendant, "SIGKILL"); } catch { /* already exited */ }
    }
  });
  it("cannot become active after close interrupts initialization", async () => {
    const client = new NativeAcpClient({
      command: process.execPath,
      args: [fixture, "--delay-initialize"],
      shutdownTimeoutMs: 1_000,
    });

    const starting = expect(client.start()).rejects.toThrow();
    await client.close();
    await starting;
    expect(() => client.newSession({ cwd: "/tmp" })).toThrow("ACP client is not active (closed)");
  });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0);

 return true; } catch { return false; }
}

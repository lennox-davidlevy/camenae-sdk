import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, link } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bob, type BobManagedMcpServer, type BobStartOptions } from "../../src/sdk/index.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function directory() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".tmp", "mc-"));
  roots.push(root);

  return root;
}

const server = (): BobManagedMcpServer => ({ name: "local", command: process.execPath, args: ["unused-before-session"], env: [], disabledTools: ["alpha"] });

async function start(root: string, managedMcpServers?: BobManagedMcpServer[], options: Partial<BobStartOptions> = {}) {
  await mkdir(join(root, "home"), { recursive: true });

  return Bob.start({ ...options, workspace: root, credential: { kind: "apiKey", apiKey: "initialize-only" }, managedMcpServers,
    environment: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home/config"), XDG_DATA_HOME: join(root, "home/data"), XDG_CACHE_HOME: join(root, "home/cache") } });
}

describe("managed MCP startup configuration", () => {
  it("opts in explicitly, persists intact ownership across direct startups, and leaves edits alone", async () => {
    const root = await directory();
    const file = join(root, ".bob/mcp.json");
    await (await start(root)).close();
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await (await start(root, [server()])).close();
    expect(JSON.parse(await readFile(file, "utf8")).mcpServers).toEqual({ local: { command: process.execPath, args: ["unused-before-session"], env: {}, disabledTools: ["alpha"] } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await (await start(root, [{ ...server(), disabledTools: [], alwaysAllow: ["alpha"] }])).close();
    const enabled = await readFile(file, "utf8");
    expect(JSON.parse(enabled).mcpServers.local.disabledTools).toEqual([]);
    expect(JSON.parse(enabled).mcpServers.local.alwaysAllow).toEqual(["alpha"]);
    await (await start(root)).close();
    expect(await readFile(file, "utf8")).toBe(enabled);
    await (await start(root, [])).close();
    expect(JSON.parse(await readFile(file, "utf8")).mcpServers).toEqual({});
    const edited = (await readFile(file, "utf8")).replace('"mcpServers": {}', '"mcpServers": {"user": {}}');
    await writeFile(file, edited);
    await expect(start(root, [server()])).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(await readFile(file, "utf8")).toBe(edited);
  }, 20_000);

  it.each(["mcp.json", "custom_modes.yaml"].flatMap((filename) =>
    ["unmanaged", "malformed", "directory-link", "file-link", "hard-link"].map((kind) => ({ filename, kind }))))("refuses $kind $filename without overwriting its contents", async ({ filename, kind }) => {
    const root = await directory();
    const outside = join(root, "caller");
    await mkdir(outside);
    await writeFile(join(outside, filename), "CALLER");
    const bob = join(root, ".bob");

    if (kind === "directory-link") await symlink(outside, bob);
    else {
      await mkdir(bob);

      if (kind === "file-link") await symlink(join(outside, filename), join(bob, filename));
      else if (kind === "hard-link") await link(join(outside, filename), join(bob, filename));
      else await writeFile(join(bob, filename), kind === "malformed" ? "{" : filename === "mcp.json" ? '{"mcpServers":{}}' : 'customModes: []\n');
    }

    const before = await readFile(join(bob, filename), "utf8");
    await expect(start(root, filename === "mcp.json" ? [server()] : undefined,
      filename === "custom_modes.yaml" ? { managedCustomModes: [] } : {})).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(await readFile(join(bob, filename), "utf8")).toBe(before);
    expect(await readFile(join(outside, filename), "utf8")).toBe("CALLER");
  });

  it("snapshots worker configuration before listening and never rewrites it on an occupied socket", async () => {
    const root = await directory();
    const socketPath = join(root, "s");
    const controller = new AbortController();
    const managedMcpServers: BobManagedMcpServer[] = [{ name: "remote", type: "http", url: "http://127.0.0.1:1/mcp", headers: [{ name: "X-Test", value: "original" }], disabledTools: ["alpha"], alwaysAllow: ["alpha"] }];
    const worker = Bob.serveOnce({ workspace: root, socketPath, signal: controller.signal, managedMcpServers });
    managedMcpServers[0].disabledTools!.push("beta");
    managedMcpServers[0].alwaysAllow!.push("beta");

    try {
      const file = join(root, ".bob/mcp.json");
      await expect.poll(() => readFile(file, "utf8").catch(() => "")).not.toBe("");
      const before = await readFile(file, "utf8");
      expect(JSON.parse(before).mcpServers.remote).toEqual({ url: "http://127.0.0.1:1/mcp", headers: { "X-Test": "original" }, disabledTools: ["alpha"], alwaysAllow: ["alpha"] });
      await expect(Bob.serveOnce({ workspace: root, socketPath, signal: new AbortController().signal, managedMcpServers: [] })).rejects.toMatchObject({ code: "startup_failed" });
      expect(await readFile(file, "utf8")).toBe(before);
    } finally { controller.abort(); await worker; }
  });

  it("rejects invalid definitions and contradictory options before touching the workspace", async () => {
    const root = await directory();
    const remote = { name: "remote", type: "http", url: "https://example.invalid/mcp", headers: [] };

    for (const value of [null, {}, [server(), server()], [{ ...server(), command: "node" }], [{ ...server(), disabledTools: ["alpha", "alpha"] }],
      [{ ...server(), alwaysAllow: ["alpha", "alpha"] }], [{ ...server(), alwaysAllow: "*" }], [{ ...server(), alwaysAllow: [null] }],
      [{ ...remote, type: "sse" }], [{ ...remote, url: "file:///secret" }],
      [{ ...remote, headers: [{ name: "X-Test", value: "a" }, { name: "x-test", value: "b" }] }]]) {
      // SAFETY: intentionally malformed JavaScript input tests the public validation boundary.
      await expect(start(root, value as BobManagedMcpServer[])).rejects.toMatchObject({ code: "configuration_invalid" });
    }

    await expect(Bob.serveOnce({ workspace: root, socketPath: join(root, "s"), signal: new AbortController().signal, disableMcp: true, managedMcpServers: [server()] })).rejects.toMatchObject({ code: "configuration_invalid" });
    await expect(stat(join(root, ".bob"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

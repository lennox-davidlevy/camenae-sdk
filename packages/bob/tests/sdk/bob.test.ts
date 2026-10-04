import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bob, BobError, type BobClient, type BobStartOptions } from "../../src/sdk/index.js";
import { NativeAcpClient } from "../../src/client/native-acp-client.js";
import { BobSession, validateSessionOptions } from "../../src/sdk/session-client.js";
import { preparePackageRuntime } from "../../src/runtime/package-runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/sdk-acp-fixture.mjs", import.meta.url));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Exercise the actual session owner over official ACP with a deterministic peer.
// Installed-package smoke owns public native startup; no legacy launcher is needed.
describe("Bob shared ACP session client", () => {
  it("forwards native authentication beyond the ordinary request deadline and rejects overlapping login/prompt", async () => {
    const transport = new NativeAcpClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 500 });
    await transport.start();
    const gateway = new BobSession({ workspace: process.cwd(), promptTimeoutMs: 5_000, maxTextBytes: 1_024 }, transport);

    try {
      const session = await gateway.newSession();
      await expect(gateway.authenticate({ methodId: "unknown" })).rejects.toMatchObject({ code: -32602 });
      const auth = gateway.authenticate({ methodId: "sso" });
      await expectCode(gateway.authenticate({ methodId: "sso" }), "busy");
      await expectCode(gateway.prompt(session.sessionId, [{ type: "text", text: "hello" }]), "busy");
      await expect(auth).resolves.toEqual({ _meta: { authenticatedBy: "fixture" } });
      const prompt = gateway.prompt(session.sessionId, [{ type: "text", text: "delay" }]);
      await expectCode(gateway.authenticate({ methodId: "sso" }), "busy");
      await gateway.cancel(session.sessionId);
      await prompt;
    } finally { await gateway.close(); }
  });

  it.each(["abort", "timeout", "close"])("settles pending authentication on %s and makes the client unusable", async (ending) => {
    const transport = new NativeAcpClient({ command: process.execPath, args: [fixture, "--ignore-term"], shutdownTimeoutMs: 100 });
    await transport.start();
    const gateway = new BobSession({ workspace: process.cwd(), promptTimeoutMs: 5_000, maxTextBytes: 1_024 }, transport);
    const controller = new AbortController();

    try {
      const pid = Number((await gateway.newSession()).sessionId);
      const auth = gateway.authenticate({ methodId: "pending" }, { signal: controller.signal, timeoutMs: ending === "timeout" ? 50 : 5_000 });

      const outcome = ending === "close" ? expect(auth).rejects.toBeDefined()
        : expectCode(auth, ending === "abort" ? "cancelled" : "timeout");

      if (ending === "abort") controller.abort();

      if (ending === "close") await gateway.close();
      await outcome;
      // A SIGTERM-resistant peer makes cleanup-before-rejection observable.
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(gateway.newSession()).rejects.toBeDefined();
    } finally { await gateway.close(); }
  });

  it("rejects invalid auth limits and an already-aborted login without closing a usable client", async () => {
    const gateway = await startGateway();

    try {
      for (const timeoutMs of [0, -1, Infinity, 24 * 60 * 60_000 + 1]) {
        await expectCode(gateway.authenticate({ methodId: "sso" }, { timeoutMs }), "configuration_invalid");
      }

      await expectCode(gateway.authenticate({ methodId: "sso" }, { signal: AbortSignal.abort() }), "cancelled");
      await expect(gateway.newSession()).resolves.toHaveProperty("sessionId");
    } finally { await gateway.close(); }
  });

  it("terminates a stopped peer even when cancellation is behind a blocked prompt write", async () => {
    const transport = new NativeAcpClient({ command: process.execPath, args: [fixture, "--stop-reading"], shutdownTimeoutMs: 100 });
    await transport.start();
    const gateway = new BobSession({ workspace: process.cwd(), promptTimeoutMs: 5_000, maxTextBytes: 1_024 }, transport);
    const { sessionId } = await gateway.newSession();
    const pid = Number(sessionId);
    const prompt = gateway.prompt(sessionId, [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }]).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([gateway.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("close blocked on ACP write")), 2_000); })]);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      clearTimeout(timer);

      try { process.kill(-pid, "SIGKILL"); } catch { /* already terminated */ }

      await transport.close();
      await prompt;
      await gateway.close();
    }
  });

  it("classifies invalid permission decisions and lifecycle timeouts without changing native errors", async () => {
    const transport = new NativeAcpClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 100 });
    await transport.start();
    const gateway = new BobSession({ workspace: process.cwd(), promptTimeoutMs: 5_000, maxTextBytes: 1_024 }, transport);

    try {
      const { sessionId } = await gateway.newSession();
      expect(() => gateway.respondToPermission("expired", null)).toThrow(BobError);
      await expectCode(gateway.setMode(sessionId, "unresponsive"), "timeout");
      await expect(gateway.setMode(sessionId, "missing")).rejects.toMatchObject({ code: -32602 });
    } finally { await gateway.close(); }
  });

  it("rejects output overflow without waiting for the peer to complete cancellation", async () => {
    const gateway = await startGateway({ limits: { maxTextBytes: 1_024, promptTimeoutMs: 300 } });

    try {
      await expectCode(gateway.run({ prompt: "overflow" }), "output_limit");
    } finally { await gateway.close(); }
  });
  it("preserves prototype host callbacks and their receiver", async () => {
    class Host {
      readonly content = "class-owned content";
      written = false;
      readTextFile() { return { content: this.content }; }
      writeTextFile(request: { content: string }) {
        expect(request.content).toBe(this.content);
        this.written = true;

        return {};
      }
    }

    const host = new Host();

    const gateway = await startGateway({
      peerEntrypoint: fileURLToPath(new URL("./fixtures/host-acp-fixture.mjs", import.meta.url)),
      host,
    });

    try {
      const { sessionId } = await gateway.newSession();
      const output: string[] = [];
      gateway.subscribe((event) => {
        if (event.type === "session_update" && event.notification.update.sessionUpdate === "agent_message_chunk" && event.notification.update.content.type === "text") output.push(event.notification.update.content.text);
      });
      await gateway.prompt(sessionId, [{ type: "text", text: "capabilities" }]);
      expect(JSON.parse(output[0])).toMatchObject({ fs: { readTextFile: true, writeTextFile: true }, terminal: false });
      await gateway.prompt(sessionId, [{ type: "text", text: "filesystem" }]);
      expect(output[1]).toBe(host.content);
      expect(host.written).toBe(true);
    } finally { await gateway.close(); }
  });

  it("does not advertise omitted host callbacks", async () => {
    const gateway = await startGateway({
      peerEntrypoint: fileURLToPath(new URL("./fixtures/host-acp-fixture.mjs", import.meta.url)),
    });

    try {
      const { sessionId } = await gateway.newSession();
      let text = "";
      gateway.subscribe((event) => {
        if (event.type === "session_update" && event.notification.update.sessionUpdate === "agent_message_chunk" && event.notification.update.content.type === "text") text += event.notification.update.content.text;
      });
      await gateway.prompt(sessionId, [{ type: "text", text: "capabilities" }]);
      expect(JSON.parse(text)).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    } finally { await gateway.close(); }
  });

  it("rejects partial terminal implementations before startup", async () => {
    await expect(startGateway({
      // @ts-expect-error Exercise the JavaScript caller boundary as well as the type contract.
      host: { createTerminal: () => ({ terminalId: "incomplete" }) },
    })).rejects.toMatchObject({ code: "configuration_invalid" });
  });

  it("rejects overlapping prompts across sessions until native cancellation finishes", async () => {
    const gateway = await startGateway();

    try {
      const first = await gateway.newSession();
      const second = await gateway.newSession();
      const pending = gateway.prompt(first.sessionId, [{ type: "text", text: "delay" }]);
      await expectCode(gateway.prompt(second.sessionId, [{ type: "text", text: "hello" }]), "busy");
      await gateway.cancel(first.sessionId);
      await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
      await expect(gateway.prompt(second.sessionId, [{ type: "text", text: "hello" }])).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally { await gateway.close(); }
  });

  it.each([
    { autoApprove: false, inherited: "true", approved: false },
    { autoApprove: true, inherited: "false", approved: true },
    { autoApprove: undefined, inherited: "false", approved: false },
    { autoApprove: undefined, inherited: "0", approved: false },
    { autoApprove: undefined, inherited: undefined, approved: true },
  ])("prepares native approval flags for $autoApprove with environment $inherited", async ({ autoApprove, inherited, approved }) => {
    const runtime = await preparePackageRuntime({ autoApprove,
      childEnvironment: { BOB_API_KEY: "initialize-only", BOB_GATEWAY_AUTO_APPROVE: inherited } });

    expect(runtime.args.includes("--auto-approve")).toBe(approved);
  });

  it("forwards host filesystem and full terminal callbacks across ACP", async () => {
    const calls: string[] = [];

    const gateway = await startGateway({
      peerEntrypoint: fileURLToPath(new URL("./fixtures/host-acp-fixture.mjs", import.meta.url)),
      host: {
        readTextFile(request) {
          expect(request).toMatchObject({ sessionId: "host-session", path: "/project/input.txt", line: 2, limit: 3 });
          calls.push("read");

 return { content: "example content" };
        },
        writeTextFile(request) {
          expect(request.content).toBe("example content"); calls.push("write");

 return {};
        },
        createTerminal(request) {
          expect(request).toMatchObject({ sessionId: "host-session", command: "example", args: ["arg"] });
          calls.push("create");

 return { terminalId: "terminal-1" };
        },
        terminalOutput() { calls.push("output");

 return { output: "terminal output", truncated: false }; },
        killTerminal() { calls.push("kill");

 return {}; },
        waitForTerminalExit() { calls.push("wait");

 return { exitCode: 0 }; },
        releaseTerminal() { calls.push("release");

 return {}; },
      },
    });

    try {
      const { sessionId } = await gateway.newSession();
      const output: string[] = [];
      gateway.subscribe((event) => {
        if (event.type === "session_update" && event.notification.update.sessionUpdate === "agent_message_chunk" && event.notification.update.content.type === "text") output.push(event.notification.update.content.text);
      });

      for (const text of ["capabilities", "filesystem", "terminal"]) await gateway.prompt(sessionId, [{ type: "text", text }]);
      expect(JSON.parse(output[0])).toMatchObject({ fs: { readTextFile: true, writeTextFile: true }, terminal: true });
      expect(output.slice(1)).toEqual(["example content", "terminal output"]);
      expect(calls).toEqual(["read", "write", "create", "output", "kill", "wait", "release"]);
    } finally { await gateway.close(); }
  });
  it("exposes initialization, native sessions, content blocks, usage, modes, and config", async () => {
    const gateway = await startGateway();
    expect(gateway.initializeResult.agentInfo).toMatchObject({ name: "native-fixture", version: "2.0.2" });
    const session = await gateway.newSession();
    expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual(["agent", "findings"]);
    await expect(gateway.setMode(session.sessionId, "findings")).resolves.toEqual({});
    await expect(gateway.setConfigOption({ sessionId: session.sessionId, configId: "model", value: "default" })).resolves.toEqual({ configOptions: [] });

    const updates: string[] = [];

    const unsubscribe = gateway.subscribe((event) => {
      if (event.type === "session_update" && event.notification.update.sessionUpdate === "agent_message_chunk") {
        const content = event.notification.update.content;

        if (content.type === "text") updates.push(content.text);
      }
    });

    const response = await gateway.prompt(session.sessionId, [
      { type: "text", text: "describe" },
      { type: "image", data: "AA==", mimeType: "image/png" },
    ]);

    expect(response).toMatchObject({ stopReason: "end_turn", usage: { totalTokens: 3 } });
    expect(updates).toEqual(["received:text,image"]);
    unsubscribe();
    await gateway.closeSession(session.sessionId);
    await gateway.close();
  });

  it.each(["allow", "reject", null])("forwards the exact native permission decision (%s)", async (optionId) => {
    const gateway = await startGateway();

    try {
      const session = await gateway.newSession();
      let received = "";
      gateway.subscribe((event) => {
        if (event.type === "permission_request") gateway.respondToPermission(event.permissionId, optionId);

        if (event.type === "session_update" && event.notification.update.sessionUpdate === "agent_message_chunk" && event.notification.update.content.type === "text") received += event.notification.update.content.text;
      });
      await gateway.prompt(session.sessionId, [{ type: "text", text: "permission" }]);
      expect(JSON.parse(received)).toEqual({ outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } });
    } finally { await gateway.close(); }
  });

  it("exposes native list, load, resume, delete, and close methods", async () => {
    const gateway = await startGateway();
    const created = await gateway.newSession();
    const listed = await gateway.listSessions();
    expect(listed.sessions[0]).toMatchObject({ sessionId: created.sessionId, title: `Title ${created.sessionId}` });
    await expect(gateway.loadSession("saved-1")).resolves.toEqual({});
    await expect(gateway.resumeSession("saved-1")).resolves.toEqual({});
    await expect(gateway.deleteSession("saved-1")).resolves.toBeUndefined();
    await expect(gateway.closeSession(created.sessionId)).resolves.toBeUndefined();
    await gateway.close();
  });

  it("keeps run as a bounded convenience API and cancels through ACP", async () => {
    const gateway = await startGateway();

    try {
      await expect(gateway.run({ mode: "findings", prompt: "hello" })).resolves.toMatchObject({
        text: "received:text",
        stopReason: "end_turn",
        response: { stopReason: "end_turn" },
      });
      const controller = new AbortController();
      let cancellationReceived = false;
      gateway.subscribe((event) => {
        if (event.type !== "session_update" || event.notification.update.sessionUpdate !== "agent_message_chunk" || event.notification.update.content.type !== "text") return;

        if (event.notification.update.content.text === "prompt-started") controller.abort();

        if (event.notification.update.content.text === "cancel-received") cancellationReceived = true;
      });
      const delayed = gateway.run({ prompt: "delay", signal: controller.signal });
      await expectCode(delayed, "cancelled");
      await expect.poll(() => cancellationReceived).toBe(true);
      await expect(gateway.run({ prompt: "hello" })).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally { await gateway.close(); }
  });

  it("cancels run before a prompt starts", async () => {
    const gateway = await startGateway();

    try {
      const controller = new AbortController();
      const pending = gateway.run({ prompt: "delay", signal: controller.signal });
      controller.abort();
      await expectCode(pending, "cancelled");
    } finally { await gateway.close(); }
  });

  it("validates launch options without retaining host-native Bob controls", async () => {
    const workspace = await temporaryDirectory();
    await expect(Bob.start({
      credential: { kind: "apiKey", apiKey: "" },
      workspace,
    })).rejects.toMatchObject({ code: "configuration_invalid" });
    await expect(Bob.start({
      credential: { kind: "apiKey", apiKey: "key" },
      workspace: "relative",
    })).rejects.toMatchObject({ code: "configuration_invalid" });
  });

  it.each(["execution", "taskProfile", "launcherEntrypoint"])("rejects removed SDK policy option %s rather than changing its meaning", async (key) => {
    await expect(Bob.start({
      credential: { kind: "apiKey", apiKey: "key" }, workspace: await temporaryDirectory(),
      [key]: key === "execution" ? { kind: "disposable" } : fixture,
    })).rejects.toMatchObject({ code: "configuration_invalid" });
  });

  it("does not mislabel invalid prompt requests as unavailable modes", async () => {
    const gateway = await startGateway();

    try {
      await expectCode(gateway.run({ prompt: "invalid" }), "protocol_failed");
    } finally { await gateway.close(); }
  });

  it("accepts private user credentials but rejects a configuration home reached through a symlink", async () => {
    const workspace = await temporaryDirectory();
    const config = join(workspace, "config");
    const home = join(workspace, "home");
    await mkdir(join(config, "bob-gateway"), { recursive: true, mode: 0o700 });
    await mkdir(home);
    await writeFile(join(config, "bob-gateway/config.json"), JSON.stringify({ apiKey: "initialize-only" }), { mode: 0o600 });
    vi.stubEnv("BOB_API_KEY", "");
    vi.stubEnv("XDG_CONFIG_HOME", config);

    const options: BobStartOptions = { workspace, credential: { kind: "gatewayUserConfig" },
      environment: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data") } };

    // Positive control prevents an unavailable runtime from satisfying the rejection.
    await (await Bob.start(options)).close();
    const alias = join(workspace, "config-alias");
    await symlink(config, alias);
    vi.stubEnv("XDG_CONFIG_HOME", alias);
    let unexpected: BobClient | undefined;

    try {
      await expect(Bob.start(options).then((client) => { unexpected = client;

 return client; }))
        .rejects.toMatchObject({ code: "startup_failed" });
    } finally { await unexpected?.close(); }
  });
});

async function startGateway(overrides: Pick<BobStartOptions, "host" | "limits"> & { peerEntrypoint?: string } = {}): Promise<BobClient> {
  const options = validateSessionOptions({
    workspace: await temporaryDirectory(),
    limits: { promptTimeoutMs: 5_000, maxTextBytes: 1_024 },
    ...overrides,
  });

  const transport = new NativeAcpClient({ command: process.execPath, args: [overrides.peerEntrypoint ?? fixture],
    cwd: options.workspace, host: options.host });

  try {
    await transport.start();

    return new BobSession(options, transport);
  } catch (error) {
    await transport.close();
    throw error;
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bob-gateway-sdk-test-"));
  temporaryDirectories.push(directory);

  return directory;
}

async function expectCode<T>(promise: Promise<T>, code: BobError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error("Expected operation to fail");
  } catch (error) {
    if (!(error instanceof BobError)) throw error;
    expect(error.code).toBe(code);
  }
}

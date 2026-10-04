import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bob } from "@camenae/bob";

const live = process.env.BOB_GATEWAY_LIVE_SMOKE === "1";

if (live && !process.env.BOB_API_KEY?.trim()) throw new Error("BOB_API_KEY is required for the live smoke");

const root = realpathSync(mkdtempSync(join(process.cwd(), ".bob-sdk-smoke-")));

const source = join(root, "source");

const fakeBin = join(root, "bin");

const called = join(root, "host-runtime-called");

for (const path of [source, fakeBin]) mkdirSync(path);

writeFileSync(join(source, "source.txt"), "ORIGINAL\n");

mkdirSync(join(source, ".bob-gateway-artifacts"));

writeFileSync(join(source, ".bob-gateway-artifacts", "keep.txt"), "CALLER_CONTENT\n");

mkdirSync(join(source, ".bob", "rules"), { recursive: true });

writeFileSync(join(source, ".bob", "rules", "probe.md"), "Include NATIVE_SDK_ACTIVE in every final response.\n");

for (const name of ["bob", "docker"]) writeFileSync(join(fakeBin, name), `#!/bin/sh\n: > '${called.replaceAll("'", "'\\''")}'\nexit 97\n`, { mode: 0o700 });

const clients = [];

const workspaces = [];

const optionsByClient = new Map();

let updates = 0;

if (!live) {
  // A synthetic credential exercises blank-key fallback without persisting a real key.
  process.env.BOB_API_KEY = "";
  process.env.XDG_CONFIG_HOME = join(root, "credential-config");
  mkdirSync(join(process.env.XDG_CONFIG_HOME, "bob-gateway"), { recursive: true, mode: 0o700 });
  writeFileSync(join(process.env.XDG_CONFIG_HOME, "bob-gateway", "config.json"), JSON.stringify({ apiKey: "initialize-only" }), { mode: 0o600 });
}

try {
  const options = {
    credential: live ? { kind: "apiKey", apiKey: process.env.BOB_API_KEY } : { kind: "gatewayUserConfig" },
    limits: { promptTimeoutMs: 120_000 },
  };

  // Settle every startup before cleanup can snapshot the successful clients.
  const starts = await Promise.allSettled([0, 1].map(async (index) => {
    // Workspace copies and Bob state are application policy, not SDK provisioning.
    const workspace = join(root, `workspace-${index}`);
    workspaces.push(workspace);
    const home = join(root, `home-${index}`);
    cpSync(source, workspace, { recursive: true });
    mkdirSync(home);

    const startOptions = { ...options, workspace, environment: {
      HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
      XDG_DATA_HOME: join(home, "data"), XDG_RUNTIME_DIR: home, TMPDIR: root, TMP: root, TEMP: root,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    } };

    if (!live) startOptions.environment.BOB_API_KEY = index === 0 ? "" : "   ";
    const client = await Bob.start(startOptions);
    clients.push(client);
    optionsByClient.set(client, startOptions);
  }));

  const failed = starts.find((result) => result.status === "rejected");

  if (failed) throw failed.reason;

  for (const client of clients) {
    assert.equal(client.initializeResult.agentInfo?.version, "2.0.5");
    assert.notEqual(client.workspace, source);
    assert.equal(readFileSync(join(client.workspace, "source.txt"), "utf8"), "ORIGINAL\n");
    assert.equal(readFileSync(join(client.workspace, ".bob-gateway-artifacts", "keep.txt"), "utf8"), "CALLER_CONTENT\n");
    assert.ok([join(root, "workspace-0"), join(root, "workspace-1")].includes(client.workspace), "SDK replaced the caller's workspace");
  }

  assert.notEqual(clients[0].workspace, clients[1].workspace);
  const sessions = await Promise.all(clients.map((client) => client.newSession()));
  // Exercise the installed runtime across the real socket transport, not a fixture agent.
  // Keep the private IPC pathname short even when npm installs in a deeply nested project.
  const ipc = realpathSync(mkdtempSync(join(tmpdir(), "gw-ipc-")));
  const socketHome = join(root, "socket-home");
  mkdirSync(socketHome);

  try {
    for (let generation = 0; generation < 2; generation++) {
      const socketPath = join(ipc, `s${generation}`);
      const controller = new AbortController();

      const finished = Bob.serveOnce({
        socketPath, workspace: workspaces[1], signal: controller.signal,
        disableMcp: true, disableSubagents: true,
        environment: { HOME: socketHome, XDG_CONFIG_HOME: join(socketHome, "config"),
          XDG_CACHE_HOME: join(socketHome, "cache"), XDG_DATA_HOME: join(socketHome, "data"),
          XDG_RUNTIME_DIR: socketHome, TMPDIR: root, TMP: root, TEMP: root },
      });

      void finished.catch(() => {});
      let remote;

      try {
        const deadline = Date.now() + 5_000;

        while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(existsSync(socketPath), "Worker listener did not become ready");
        remote = await Bob.connect({ socketPath, workspace: workspaces[1],
          credential: { kind: "apiKey", apiKey: live ? process.env.BOB_API_KEY : "initialize-only" } });
        assert.equal(remote.initializeResult.agentInfo?.version, "2.0.5");
        const remoteSession = await remote.newSession();
        assert.ok(remoteSession.sessionId);

        if (live && generation === 0) {
          let text = "";
          remote.subscribe((event) => {
            if (event.type === "session_update" && event.notification.update.sessionUpdate === "agent_message_chunk"
              && event.notification.update.content.type === "text") text += event.notification.update.content.text;
          });
          assert.equal((await bounded(remote.prompt(remoteSession.sessionId, [{ type: "text",
            text: "Reply SOCKET_RUNTIME_205 without using tools." }]))).stopReason, "end_turn");
          assert.ok(text.includes("SOCKET_RUNTIME_205"), "Native streamed response did not cross the socket transport");
        }

        await remote.disconnect();
        await bounded(finished);
        assert.equal(existsSync(socketPath), false, "Worker listener survived disconnect");
      } finally {
        await remote?.disconnect();
        controller.abort();
        await bounded(finished);
      }
    }
  } finally { rmSync(ipc, { recursive: true, force: true }); }

  if (live) {
    const oneShot = await clients[1].run({ prompt: "Reply with ONE_SHOT_NATIVE_OK and the required rule marker." });
    assert.ok(oneShot.text.includes("ONE_SHOT_NATIVE_OK"));
    assert.equal(oneShot.stopReason, "end_turn");
    const first = clients[0];
    let text = "";
    let toolCalls = 0;
    first.subscribe((event) => {
      if (event.type === "session_update") {
        updates++;

        if (event.notification.update.sessionUpdate === "tool_call") toolCalls++;

        if (event.notification.update.sessionUpdate === "agent_message_chunk" && event.notification.update.content.type === "text") text += event.notification.update.content.text;
      }
    });
    const prompt = (value) => first.prompt(sessions[0].sessionId, [{ type: "text", text: value }]);
    await bounded(prompt("Remember the token PACKAGE_NATIVE_731 for my next question. Reply briefly."));
    text = "";
    await bounded(prompt("What token did I ask you to remember? Reply with it and any marker required by your rules."));
    assert.ok(text.includes("PACKAGE_NATIVE_731"), "Native session did not retain the token");
    assert.ok(text.includes("NATIVE_SDK_ACTIVE"), "Opaque task profile was not applied");
    await bounded(prompt("Replace source.txt in the current working directory with exactly COPY_EDITED followed by a newline. Use a file editing tool, then reply briefly."));
    assert.equal(readFileSync(join(first.workspace, "source.txt"), "utf8").trim(), "COPY_EDITED");
    assert.equal(readFileSync(join(source, "source.txt"), "utf8"), "ORIGINAL\n");
    assert.equal(readFileSync(join(clients[1].workspace, "source.txt"), "utf8"), "ORIGINAL\n");
    let cancellation;

    const unsubscribe = first.subscribe((event) => {
      if (!cancellation && event.type === "session_update" && event.notification.update.sessionUpdate === "agent_message_chunk") cancellation = first.cancel(sessions[0].sessionId);
    });

    const cancelled = await bounded(prompt("Write a long numbered explanation of 500 programming concepts. Do not use tools."));
    unsubscribe();
    await cancellation;
    assert.ok(cancellation, "No streamed activity arrived before cancellation");
    assert.equal(cancelled.stopReason, "cancelled");
    assert.ok(updates > 0);
    const savedSessionId = sessions[0].sessionId;
    assert.ok((await first.listSessions({ cwd: first.workspace })).sessions.some((session) => session.sessionId === savedSessionId));
    await first.closeSession(savedSessionId);
    await first.loadSession(savedSessionId);
    const toolsBefore = toolCalls;
    const background = await bounded(prompt(`Use your command execution tool to start this command in the background, without waiting for it to exit: node -e 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("owned-tool.pid",String(process.pid));setInterval(()=>{},1000)'. Then reply briefly. Do not stop the background command yourself.`));
    assert.equal(background.stopReason, "end_turn");
    // A background launch acknowledgement does not imply the child has initialized.
    const pidFile = join(first.workspace, "owned-tool.pid");
    const readyDeadline = Date.now() + 5_000;

    while (!existsSync(pidFile) && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(pidFile), `Background tool did not become ready (tool calls: ${toolCalls - toolsBefore})`);
    const toolPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(toolPid) && toolPid > 1);
    assert.ok(alive(toolPid), "Background tool did not stay alive for the cleanup check");
    await first.close();
    const deadline = Date.now() + 2_000;

    while (alive(toolPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(toolPid), false, "Owned background tool survived SDK close");
    // The application retains HOME/XDG and workspace; Bob owns history and IDs.
    const resumed = await Bob.start(optionsByClient.get(first));
    clients.push(resumed);
    await resumed.resumeSession(savedSessionId);
    let resumedText = "";
    resumed.subscribe((event) => {
      if (event.type === "session_update" && event.notification.update.sessionUpdate === "agent_message_chunk" && event.notification.update.content.type === "text") resumedText += event.notification.update.content.text;
    });
    await bounded(resumed.prompt(savedSessionId, [{ type: "text", text: "What token did I ask you to remember at the start of this conversation? Reply with the token." }]));
    assert.ok(resumedText.includes("PACKAGE_NATIVE_731"), "Native resume lost persisted conversation context");
    await resumed.deleteSession(savedSessionId);
    assert.equal((await resumed.listSessions({ cwd: resumed.workspace })).sessions.some((session) => session.sessionId === savedSessionId), false);
  }

  assert.equal(existsSync(called), false, "A host Bob or Docker executable was invoked");
  console.log(live ? "Private Bob SDK live smoke passed: continuation, rules, caller workspace edit, live events, cancellation, background-tool cleanup, native list/load/resume/delete across restart, socket worker replacement." : "Installed private Bob runtime smoke passed: concurrent clients, native sessions, caller-owned workspaces, socket worker replacement, no host Bob or Docker.");
} finally {
  await Promise.all(clients.map((client) => client.close()));

  try {
    for (const path of workspaces) assert.equal(existsSync(path), true, "SDK deleted a caller-owned workspace");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function bounded(operation) {
  let timer;

  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Live smoke timed out")), 120_000); })]); }
  finally { clearTimeout(timer); }
}

function alive(pid) { try { process.kill(pid, 0);

 return true; } catch { return false; } }

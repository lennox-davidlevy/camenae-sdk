import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const detached = process.argv.includes("--detached-child");

const child = spawn(process.execPath, ["-e", `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`], {
  detached, stdio: ["ignore", "ignore", "ignore", "ipc"], env: {},
});

const ready = new Promise((resolve) => child.once("message", resolve));

new AgentSideConnection(() => ({
  async initialize() { await ready;

 return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "tree-fixture", version: "1", title: String(child.pid) } }; },
  authenticate() { return {}; },
  newSession() { return { sessionId: "tree-session" }; },
  prompt() { setImmediate(() => process.exit(0));

 return { stopReason: "end_turn" }; },
  cancel() {},
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

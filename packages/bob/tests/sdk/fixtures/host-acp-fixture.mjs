import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

let capabilities;

const connection = new AgentSideConnection(() => ({
  initialize(params) {
    capabilities = params.clientCapabilities;

    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
  },
  authenticate() { return {}; },
  newSession() { return { sessionId: "host-session" }; },
  async prompt({ sessionId, prompt }) {
    const text = prompt[0].text;
    let output;

    if (text === "capabilities") output = JSON.stringify(capabilities);
    else if (text === "filesystem") {
      const result = await connection.readTextFile({ sessionId, path: "/project/input.txt", line: 2, limit: 3 });
      await connection.writeTextFile({ sessionId, path: "/project/output.txt", content: result.content });
      output = result.content;
    } else {
      const terminal = await connection.createTerminal({ sessionId, command: "example", args: ["arg"] });
      output = (await terminal.currentOutput()).output;
      await terminal.kill();
      await terminal.waitForExit();
      await terminal.release();
    }

    await connection.sessionUpdate({ sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: output },
    } });

    return { stopReason: "end_turn" };
  },
  cancel() {},
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

export function approvalPeer(input, output) {
  let nextSession = 0;

  return new AgentSideConnection((connection) => ({
    initialize: async () => ({ protocolVersion: 1, agentInfo: { name: "bob-shell", version: "2.0.5" } }),
    authenticate: async () => ({}),
    newSession: async () => ({ sessionId: String(++nextSession) }),
    cancel: async () => {},
    prompt: async ({ sessionId, prompt }) => {
      const requests = JSON.parse(prompt[0].text);
      const outcomes = [];

      if (Array.isArray(requests)) outcomes.push(...await Promise.all(requests.map((request) => connection.requestPermission({ sessionId, ...request }))));
      else for (const request of requests.sequential) outcomes.push(await connection.requestPermission({ sessionId, ...request }));

      if (requests.disconnect) {
        input.destroy();
        output.end();

        return new Promise(() => {});
      }

      return { stopReason: "end_turn", _meta: { outcomes } };
    },
  }), ndJsonStream(Writable.toWeb(output), Readable.toWeb(input)));
}

if (process.argv.includes("--stdio")) approvalPeer(process.stdin, process.stdout);

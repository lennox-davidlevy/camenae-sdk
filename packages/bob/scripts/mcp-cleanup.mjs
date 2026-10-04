import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Compatibility repair for @modelcontextprotocol/server 2.2.0 only.
// Non-resumable SSE cancellation/closure currently drops the writer but retains
// request IDs indefinitely when Protocol suppresses the cancelled reply. Retire
// those IDs at stream teardown, and clear all IDs at terminal transport close.
// Preserve event-store-backed resumption: its request IDs must survive a stream
// disconnect until the response is stored or the whole transport closes.
// No messages, dispatch rules, authorization, or installed files are changed.
// Source: https://github.com/modelcontextprotocol/typescript-sdk/blob/dd22ba25ddbe7cd8822e1fe9c738a974996a28f6/packages/server/src/server/streamableHttp.ts
// Remove when an upstream release passes mcp-transport-cleanup.test.mjs unaided.
const sha256 = "d02b0f5142148f7db422ad47d6641290557996f78cf7f361fff40507e1941a21";

const replacements = [
  [
    'if (this._streamMapping.get(streamId)?.controller === streamController) this._streamMapping.delete(streamId);',
    `if (this._streamMapping.get(streamId)?.controller === streamController) {
      this._streamMapping.delete(streamId);
      if (!this._eventStore) this._retireStreamRequests(streamId);
    }`,
  ],
  [
    '\t\t\t\t\t\tthis._streamMapping.delete(streamId);\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tstreamController.close();',
    '\t\t\t\t\t\tthis._streamMapping.delete(streamId);\n\t\t\t\t\t\tif (!this._eventStore) this._retireStreamRequests(streamId);\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tstreamController.close();',
  ],
  [
    '\tasync close() {\n\t\tif (this._closed) return;\n\t\tthis._closed = true;\n\t\tfor (const { cleanup } of this._streamMapping.values()) cleanup();',
    `\t_retireStreamRequests(streamId) {
      for (const [id, owner] of this._requestToStreamMapping) {
        if (owner !== streamId) continue;
        this._requestToStreamMapping.delete(id);
        this._requestResponseMap.delete(id);
      }
    }
\tasync close() {\n\t\tif (this._closed) return;\n\t\tthis._closed = true;\n\t\tfor (const { cleanup } of this._streamMapping.values()) cleanup();`,
  ],
  [
    '\t\tthis._streamMapping.clear();\n\t\tthis._requestResponseMap.clear();',
    '\t\tthis._streamMapping.clear();\n\t\tthis._requestResponseMap.clear();\n\t\tthis._requestToStreamMapping.clear();',
  ],
];

export const mcpCleanupPlugin = {
  name: "reviewed-mcp-stream-cleanup",
  setup(build) {
    let applied = false;
    build.onStart(() => {
      applied = false;
      const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@modelcontextprotocol/server")), "utf8"));

      if (metadata.version !== "2.2.0") throw new Error("Review MCP stream cleanup before changing its pinned version");
    });
    build.onLoad({ filter: /[/\\]@modelcontextprotocol[/\\]server[/\\]dist[/\\]index\.mjs$/ }, ({ path }) => {
      let contents = readFileSync(path, "utf8");

      if (createHash("sha256").update(contents).digest("hex") !== sha256) {
        throw new Error("MCP dependency changed: review its stream cleanup patch before building");
      }

      for (const [original, replacement] of replacements) {
        if (contents.split(original).length !== 2) throw new Error("MCP cleanup patch anchor is not unique");
        contents = contents.replace(original, replacement);
      }

      applied = true;

      return { contents, loader: "js" };
    });
    build.onEnd((result) => {
      if (result.errors.length === 0 && !applied) return { errors: [{ text: "MCP stream cleanup patch was not applied" }] };

      return undefined;
    });
  },
};

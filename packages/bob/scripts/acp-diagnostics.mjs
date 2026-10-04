import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

// Temporary privacy repair for the official SDK 1.4.0. Upstream 1.5.1 still
// logs raw payloads and exposes no logger hook. Patch only dependency diagnostic
// calls when bundling our public entrypoints; never alter ACP messages, schema
// validation, dispatch, errors returned to callers, or global console behavior.
// https://github.com/agentclientprotocol/typescript-sdk/blob/v1.4.0/src/jsonrpc.ts
// Remove once an upstream release provides payload-free diagnostics.
const reviewed = {
  "jsonrpc.js": {
    sha256: "1f322c9397c55282710f22f7bf0163f04b084efa6f1b108d3a2fb040426022a7",
    replacements: [
      ['console.error("Invalid message", { message });', 'console.error("ACP message rejected");'],
      ['console.error("Error handling notification", message.raw, response.error);', 'console.error("ACP notification rejected");'],
      ['console.error("Got response to unknown request", response.id);', 'console.error("ACP response rejected");'],
    ],
  },
  "connection.js": {
    sha256: "bea9070ef6e863f828d98757344006800c9967f41b0ab2ea19d6eaca95c77474",
    replacements: [
      ['console.error("ACP connection router stopped unexpectedly:", error);', 'console.error("ACP connection router stopped unexpectedly");'],
    ],
  },
};

export const acpDiagnosticsPlugin = {
  name: "reviewed-acp-diagnostics",
  setup(build) {
    build.onStart(() => {
      const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@agentclientprotocol/sdk")), "utf8"));

      if (metadata.version !== "1.4.0") throw new Error("Review ACP diagnostic privacy before changing its pinned version");
    });
    build.onLoad({ filter: /[/\\]@agentclientprotocol[/\\]sdk[/\\]dist[/\\](jsonrpc|connection)\.js$/ }, ({ path }) => {
      const contract = reviewed[basename(path)];
      let contents = readFileSync(path, "utf8");

      if (createHash("sha256").update(contents).digest("hex") !== contract.sha256) {
        throw new Error("ACP dependency changed: review its diagnostic privacy patch before building");
      }

      for (const [original, replacement] of contract.replacements) contents = contents.replaceAll(original, replacement);

      return { contents, loader: "js" };
    });
  },
};

import { createHash } from "node:crypto";

// Temporary correction to Bob 2.0.5's ACP approval path, NOT a general patcher.
// The tool dispatcher already resolved the real tool and checked availability.
// Carry only its native MCP alwaysAllow result to the ACP observer. Computing it
// here (rather than searching the root task in the observer) also handles child
// tasks correctly. Neither tool arguments nor ACP titles/IDs supply this bit.
// Existing session-local decisions keep precedence; all other ACP checks remain.
// See BOB-ACP-CORRECTION.md for consequences and the unpatched-upgrade exit gate.
const id = "acp-mcp-always-allow-v1";

const originalSha256 = "15c328ca5f6b9360d3c7a72e6bd46ae0ce9082eda20f57edc5da0348efac1cbe";

const correctedSha256 = "d443d6e7e0351c45fc2191d63787835c96d15eace7a9bad0a6d795985295da8c";

const replacements = [
  [
    "permission:Sx.getToolPermission(t),isOutsideWorkspace:w,isBobHomeWrite:F,isBuiltinSkill:T",
    "permission:Sx.getToolPermission(t),bobGatewayMcpAlwaysAllowed:t instanceof Iyt&&t.isAlwaysAllowed(),isOutsideWorkspace:w,isBobHomeWrite:F,isBuiltinSkill:T",
  ],
  [
    "let n=this.policy.permissionMemory.get(t.signature.name);if(n)return n;let a=await this.requestToolPermission(t);",
    'let n=this.policy.permissionMemory.get(t.signature.name);if(n)return n;if(t.bobGatewayMcpAlwaysAllowed===!0)return"allow";let a=await this.requestToolPermission(t);',
  ],
];

export function correctBobEntrypoint(source, bob) {
  if (bob.version !== "2.0.5" || bob.releaseCommit !== "2dc1809063bd2c2b550e66b5c20854f3cf8cb9f4"
    || bob.entrypointSha256 !== originalSha256 || bob.correction?.id !== id
    || bob.correction.entrypointSha256 !== correctedSha256) throw new Error("Review the Bob ACP correction before changing its pins");

  if (digest(source) !== originalSha256) throw new Error("Bob ACP correction requires the exact original entrypoint");
  let result = source.toString("utf8");

  for (const [original, replacement] of replacements) {
    if (result.split(original).length !== 2) throw new Error("Bob ACP correction anchor is not unique");
    result = result.replace(original, replacement);
  }

  if (digest(result) !== correctedSha256) throw new Error("Bob ACP correction output checksum mismatch");

  return result;
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import metadata from "../../package.json" with { type: "json" };

if (!process.env.BOB_API_KEY?.trim()) throw new Error("BOB_API_KEY is required; run only with live credential authorization");

const probe = process.argv[2];

if (!["approval", "managed-mcp", "mcp-approval"].includes(probe) || !process.argv[3]) throw new Error("Usage: package-live.mjs <approval|managed-mcp|mcp-approval> <local-sdk.tgz>");

const packageDir = fileURLToPath(new URL("../..", import.meta.url));

mkdirSync(join(packageDir, ".tmp"), { recursive: true });

const root = mkdtempSync(join(packageDir, ".tmp", "ap-"));

const project = join(root, "project");

mkdirSync(project);

mkdirSync(join(root, "home"));

try {
  writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, type: "module", allowScripts: { "@officecli/officecli@1.0.144": true } }));
  const dependencies = probe !== "approval" ? [`@modelcontextprotocol/sdk@${metadata.devDependencies["@modelcontextprotocol/sdk"]}`] : [];
  execFileSync("npm", ["install", "--no-audit", "--no-fund", resolve(process.argv[3]), ...dependencies], {
    cwd: project, stdio: "pipe", env: { ...process.env, BOB_API_KEY: undefined, BOBSHELL_API_KEY: undefined,
      HOME: join(root, "home"), npm_config_cache: join(packageDir, ".npm") },
  });
  copyFileSync(join(packageDir, `tests/smoke/fixtures/${probe}-consumer.mjs`), join(project, "consumer.mjs"));

  if (probe !== "approval") copyFileSync(join(packageDir, "tests/smoke/fixtures/managed-mcp-server.mjs"), join(project, "managed-mcp-server.mjs"));
  execFileSync(process.execPath, ["consumer.mjs", ...(probe === "mcp-approval" ? ["--live"] : [])], { cwd: project, stdio: "inherit", timeout: probe === "mcp-approval" ? 900_000 : 600_000,
    env: { ...process.env, BOB_GATEWAY_APPROVAL_SMOKE_ROOT: root, BOB_GATEWAY_SMOKE_ROOT: join(packageDir, ".tmp") } });
} finally { rmSync(root, { recursive: true, force: true }); }

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import metadata from "../../package.json" with { type: "json" };

const packageDir = fileURLToPath(new URL("../..", import.meta.url));

const require = createRequire(import.meta.url);

const vitest = fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")));

mkdirSync(join(packageDir, ".tmp"), { recursive: true });

const root = mkdtempSync(join(packageDir, ".tmp", "package-smoke-"));

mkdirSync(join(root, "home"));

const installEnvironment = { ...process.env, BOB_API_KEY: undefined, HOME: join(root, "home"), npm_config_cache: join(packageDir, ".npm") };

try {
  // An explicit archive is installed unchanged, so delivery can use the exact
  // bytes that passed both runtimes instead of rebuilding after validation.
  const suppliedArchive = process.argv[2] ? resolve(process.argv[2]) : undefined;

  const packed = suppliedArchive ? [{ filename: suppliedArchive,
    files: execFileSync("tar", ["-tzf", suppliedArchive], { encoding: "utf8", timeout: 30_000 })
      .trim().split("\n").filter((path) => !path.endsWith("/")).map((path) => ({ path: path.replace(/^package\//, "") })) }]
    : JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
    cwd: packageDir,
    encoding: "utf8",
    env: installEnvironment,
  }));

  const artifact = packed[0];

  if (!artifact?.filename || !Array.isArray(artifact.files)) throw new Error("npm pack returned no artifact metadata");
  const packedPaths = artifact.files.map((file) => file.path);

  if (!packedPaths.includes("dist/sdk/index.mjs")
    || !packedPaths.includes("dist/sdk/index.d.ts")
    || !packedPaths.includes("runtime/bob/dist/bob.js")
    || !packedPaths.includes("runtime/bob/dist/ibm-licence/license.txt")
    || !packedPaths.includes("runtime/compatibility.json")
    || !packedPaths.includes("README.md")
    || !packedPaths.includes("SDK.md")) {
    throw new Error("package is missing its SDK, declarations, private runtime, or guides");
  }

  if (!packedPaths.includes("BOB-ACP-CORRECTION.md")) throw new Error("package is missing its Bob correction provenance and removal guide");

  if (!packedPaths.includes("BOB-USAGE-CORRECTION.md")) throw new Error("package is missing its usage correction contract and removal guide");

  if (["dist/bob-gateway.mjs", "dist/launcher.mjs", "dist/server.mjs"].some((path) => packedPaths.includes(path))) {
    throw new Error("SDK package retained a retired gateway executable");
  }

  if (packedPaths.some((path) => path.startsWith("src/") || path.startsWith("tests/") || path.startsWith("tools/") || path.startsWith("container/") || path.includes("bob-configuration"))) {
    throw new Error("package contains source, tests, local tooling, or reference configuration");
  }

  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, type: "module", allowScripts: { "@officecli/officecli@1.0.144": true } }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", suppliedArchive ?? join(root, artifact.filename)], {
    cwd: project,
    stdio: "pipe",
    env: installEnvironment,
  });
  writeFileSync(join(project, "sdk-consumer.ts"), `
    import { Bob, BobError, type BobRunResult, type BobCredential, type BobClient, type BobPermissionAutoDecisionEvent, type BobManagedMcpServer, type BobSessionUsage, type BobCustomMode, type BobStartOptions, type BobServeOptions } from "@camenae/bob";
    import { createMcpToolGate, type McpToolPolicy, type McpToolAutoDecisionEvent } from "@camenae/bob/mcp";
    import { createBobCodeMode, type BobCodeModeOptions } from "@camenae/bob/code-mode";
    const codeMode: BobCodeModeOptions = { tools: [], authorize: async () => "deny" };
    const configureCodeMode = () => createBobCodeMode(codeMode);
    void configureCodeMode;
    const mcpPolicy: McpToolPolicy = { tools: { write_document: "ask" }, fallback: "deny" };
    const server: BobManagedMcpServer = { name: "documents", type: "http", url: "http://127.0.0.1:1/mcp", headers: [], alwaysAllow: ["write_document"] };
    const mcpObserver = (event: McpToolAutoDecisionEvent) => {
      const disabledDeny: "deny" | undefined = event.match === "disabled" ? event.decision : undefined;
      void disabledDeny;
    };
    const configure = () => createMcpToolGate({ server, bearerToken: "synthetic-token-for-types-only-12345", onAutoDecision: mcpObserver });
    void [createMcpToolGate, mcpPolicy, configure];
    const start = Bob.start;
    const mode: BobCustomMode = { slug: "assistant", name: "Assistant", roleDefinition: "Answer general questions.", groups: ["read", ["edit", { fileRegex: "md$" }]] };
    const directModes: Pick<BobStartOptions, "managedCustomModes"> = { managedCustomModes: [mode] };
    const workerModes: Pick<BobServeOptions, "managedCustomModes"> = directModes;
    void workerModes;
     const result: BobRunResult = { text: "ok", stopReason: "end_turn", response: { stopReason: "end_turn" } };
    const error: BobError | undefined = undefined;
    const credential: BobCredential = { kind: "sso" };
    const authenticate = (client: BobClient) => client.authenticate({ methodId: "sso" }, { timeoutMs: 1000 });
    const observe = (client: BobClient) => client.subscribe(event => {
      if (event.type === "session_update") {
        const usage = event.notification.update._meta?.["bob-gateway/usage"] as BobSessionUsage | undefined;
        if (usage?.version === 1) {
          const limit: number | null = usage.contextWindow;
          const coins: number | null = usage.bobcoins;
          void [limit, coins];
        }
      }
      if (event.type !== "permission_auto_decision") return;
      const decision: BobPermissionAutoDecisionEvent = event;
      const fallbackDeny: "deny" | undefined = decision.match === "fallback" ? decision.decision : undefined;
      void fallbackDeny;
    });
    void [start, result, error, credential, authenticate, observe];
  `);
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
    files: ["sdk-consumer.ts"],
  }));
  execFileSync(process.execPath, [
    require.resolve("typescript/bin/tsc"),
    "-p",
    join(project, "tsconfig.json"),
  ], { cwd: project, stdio: "pipe" });
  execFileSync(process.execPath, [vitest, "run", "tests/sdk/approval-policy.test.ts", "-t", "approval policy over socket ACP"], {
    cwd: packageDir,
    env: { ...installEnvironment, BOB_GATEWAY_TEST_PACKAGE: join(project, "node_modules/@camenae/bob/dist/sdk/index.mjs") },
    stdio: "inherit",
    timeout: 120_000,
  });
  const mcpEntrypoint = execFileSync(process.execPath, ["--input-type=module", "-e", 'console.log(import.meta.resolve("@camenae/bob/mcp"))'], { cwd: project, encoding: "utf8" }).trim();
  const codeModeEntrypoint = execFileSync(process.execPath, ["--input-type=module", "-e", 'console.log(import.meta.resolve("@camenae/bob/code-mode"))'], { cwd: project, encoding: "utf8" }).trim();
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createBobCodeMode } from ${JSON.stringify(codeModeEntrypoint)};
    const { verifyCodeMode } = await import(${JSON.stringify(new URL("./fixtures/code-mode-consumer.mjs", import.meta.url).href)});
    await verifyCodeMode(createBobCodeMode);
  `], { cwd: project, stdio: "inherit", timeout: 30_000 });
  execFileSync(process.execPath, [join(packageDir, "tests/smoke/fixtures/code-mode-native.mjs")], {
    cwd: project,
    env: { ...installEnvironment, BOBSHELL_API_KEY: undefined,
      BOB_GATEWAY_TEST_PACKAGE: join(project, "node_modules/@camenae/bob/dist/sdk/index.mjs"),
      BOB_GATEWAY_TEST_CODE_MODE_PACKAGE: fileURLToPath(codeModeEntrypoint) },
    stdio: "inherit", timeout: 120_000,
  });
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { BobError } from "@camenae/bob";
    import { createMcpToolGate } from "@camenae/bob/mcp";
    await assert.rejects(createMcpToolGate({}), BobError);
  `], { cwd: project, stdio: "inherit" });
  execFileSync(process.execPath, [vitest, "run", "tests/sdk/mcp-gate.test.ts"], {
    cwd: packageDir,
    env: { ...installEnvironment, BOB_GATEWAY_TEST_MCP_PACKAGE: fileURLToPath(mcpEntrypoint) },
    stdio: "inherit",
    timeout: 120_000,
  });
  execFileSync(process.execPath, [join(packageDir, "tests/smoke/fixtures/mcp-approval-consumer.mjs")], {
    cwd: packageDir,
    env: { ...installEnvironment, BOBSHELL_API_KEY: undefined,
      BOB_GATEWAY_TEST_PACKAGE: join(project, "node_modules/@camenae/bob/dist/sdk/index.mjs"),
      BOB_GATEWAY_TEST_MCP_PACKAGE: fileURLToPath(mcpEntrypoint) },
    // Conservative ceiling for real Bob startup, sequential turns and cleanup
    // across both transports/generations; not an expected duration or a sleep.
    stdio: "inherit", timeout: 900_000,
  });
  execFileSync(process.execPath, [join(packageDir, "tests/smoke/fixtures/usage-consumer.mjs")], {
    cwd: packageDir,
    env: { ...installEnvironment, BOBSHELL_API_KEY: undefined,
      BOB_GATEWAY_TEST_PACKAGE: join(project, "node_modules/@camenae/bob/dist/sdk/index.mjs") },
    stdio: "inherit", timeout: 300_000,
  });
  const installedMetadata = JSON.parse(readFileSync(join(project, "node_modules/@camenae/bob/package.json"), "utf8"));

  if (installedMetadata.name !== metadata.name || installedMetadata.version !== metadata.version || installedMetadata.bin !== undefined) {
    throw new Error("Installed SDK package identity or SDK-only contract is invalid");
  }

  copyFileSync(join(packageDir, "tests", "smoke", "fixtures", "package-runtime-consumer.mjs"), join(project, "consumer.mjs"));
  execFileSync(process.execPath, ["consumer.mjs"], {
    cwd: project,
    env: { ...process.env, HOME: join(root, "home") },
    stdio: "inherit",
    timeout: 300_000,
  });
  copyFileSync(join(packageDir, "tests", "smoke", "fixtures", "package-sso-consumer.mjs"), join(project, "sso-consumer.mjs"));
  execFileSync(process.execPath, ["sso-consumer.mjs"], {
    cwd: project,
    env: { ...installEnvironment, BOB_GATEWAY_SMOKE_ROOT: join(packageDir, ".tmp") },
    stdio: "inherit",
    timeout: 180_000,
  });
  console.log("@camenae/bob package install smoke passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}

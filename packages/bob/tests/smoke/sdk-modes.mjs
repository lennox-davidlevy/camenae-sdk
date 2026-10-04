import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bob, BobError } from "../../dist/sdk/index.mjs";

if (!process.env.BOB_API_KEY?.trim()) throw new Error("BOB_API_KEY is required for the live SDK smoke test");

const root = mkdtempSync(join(tmpdir(), "bob-gateway-sdk-live-"));

const workspace = join(root, "workspace");

const taskProfile = join(workspace, ".bob");

const home = join(root, "home");

mkdirSync(home);

mkdirSync(join(taskProfile, "rules-sdk-probe"), { recursive: true });

writeFileSync(join(taskProfile, "custom_modes.yaml"), `customModes:
  - slug: sdk-probe
    name: SDK Probe
    description: Verify native ACP through the public SDK.
    roleDefinition: Include SDK_MODE_ACTIVE in every reply.
    whenToUse: Only for this smoke test.
    customInstructions: Include SDK_MODE_ACTIVE in every reply.
    groups: []
`);

writeFileSync(join(taskProfile, "rules-sdk-probe", "grounding.md"), "Include SDK_RULE_ACTIVE in every reply.\n");

let gateway;

try {
  gateway = await Bob.start({
    credential: { kind: "apiKey", apiKey: process.env.BOB_API_KEY },
    workspace,
    environment: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
      XDG_DATA_HOME: join(home, "data"), XDG_RUNTIME_DIR: home, TMPDIR: root, TMP: root, TEMP: root },
    limits: { promptTimeoutMs: 120_000, maxTextBytes: 64 * 1024 },
  });

  if (gateway.initializeResult.agentInfo?.name !== "bob-shell" || gateway.initializeResult.agentInfo.version !== "2.0.5") {
    throw new Error("SDK did not initialize exact native Bob 2.0.5");
  }

  const session = await gateway.newSession();

  if (!session.modes?.availableModes.some((mode) => mode.id === "sdk-probe")) throw new Error("task-profile mode is unavailable");
  await gateway.closeSession(session.sessionId);

  const result = await gateway.run({
    mode: "sdk-probe",
    prompt: "Reply briefly with the two markers required by your mode and rule.",
  });

  if (!result.text.includes("SDK_MODE_ACTIVE") || !result.text.includes("SDK_RULE_ACTIVE")) {
    throw new Error("live SDK run did not apply the caller's mode and rule");
  }

  console.log("Native SDK caller-owned mode/rule smoke test passed.");
} catch (error) {
  if (error instanceof BobError) throw new Error(`live SDK failed with ${error.code}`);
  throw error;
} finally {
  await gateway?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}

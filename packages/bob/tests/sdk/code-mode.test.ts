import { test } from "vitest";
import { createBobCodeMode } from "../../src/sdk/code-mode.js";
import { verifyCodeMode } from "../smoke/fixtures/code-mode-consumer.mjs";

test("MCP Code Mode composes authorized tools, confines execution and cancels pending approval", async () => {
  await verifyCodeMode(createBobCodeMode);
}, 15000);

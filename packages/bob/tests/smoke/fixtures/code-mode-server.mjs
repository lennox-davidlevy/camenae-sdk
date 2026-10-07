import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { createBobCodeMode } = await import(process.env.BOB_GATEWAY_TEST_CODE_MODE_PACKAGE
  ? pathToFileURL(process.env.BOB_GATEWAY_TEST_CODE_MODE_PACKAGE).href : "@camenae/bob/code-mode");

const bridge = createBobCodeMode({
  tools: [{ name: "record", description: "Record a fixture receipt",
    inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1, maximum: 9 } }, required: ["id"], additionalProperties: false },
    outputSchema: { type: "integer" },
    execute: async (input) => {
      writeFileSync(join(process.env.CODE_MODE_ROOT, `receipt-${input.id}`), "executed");

      return input.id;
    } }],
  authorize: async ({ input }) => input.id === 9 ? "deny" : "allow",
});

await bridge.connectStdio();

process.once("SIGTERM", () => { void bridge.close(); });

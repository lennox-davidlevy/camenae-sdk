import { createBobCodeMode } from "@camenae/bob/code-mode";

// Run this as a dedicated Bob stdio MCP child, not inside your trusted web app.
// stdout belongs to MCP. Real handlers and approval UIs belong to the consumer.
const bridge = createBobCodeMode({
  tools: [{
    name: "add", description: "Add two numbers without external side effects.",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
    outputSchema: { type: "number" },
    execute: async (input) => input.a + input.b,
  }],
  authorize: async ({ toolName }) => toolName === "add" ? "allow" : "deny",
});

await bridge.connectStdio();

process.once("SIGTERM", () => { void bridge.close(); });

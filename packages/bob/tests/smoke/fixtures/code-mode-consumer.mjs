import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

// One contract owner, reused by source tests and exact installed-archive acceptance.
export async function verifyCodeMode(createBobCodeMode) {
  const calls = [];
  const approvals = [];
  const object = { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false };

  const tool = { name: "lookup", description: "Look up a fixture item", inputSchema: object, outputSchema: object,
    execute: async (input) => { calls.push(input.id);

      return input; } };

  const bridge = createBobCodeMode({ tools: [tool], limits: { maxToolCalls: 3, timeoutMs: 1000, maxOutputBytes: 1024 },
    authorize: async (call) => { approvals.push(call.input.id); call.input.id = 999;

      return approvals.at(-1) === 9 ? "deny" : "allow"; } });

  const client = new Client({ name: "code-mode-contract", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await bridge.connect(remote);
  await client.connect(local);

  const run = async (code) => {
    const response = await client.callTool({ name: "execute", arguments: { code } });

    return { response, result: JSON.parse(response.content[0].text) };
  };

  try {
    const listed = await client.listTools();
    assert.equal(listed.tools[0].name, "execute");
    const discovery = await run('return search({query:"lookup"})');
    assert.equal(discovery.result.ok, true);
    assert.match(JSON.stringify(discovery.result.value), /lookup/);
    const combined = await run("const items = await Promise.all([tools.lookup({id:1}), tools.lookup({id:2})]); return items.map(item => item.id)");
    assert.deepEqual(combined.result.value, [1, 2]);
    assert.deepEqual(calls, [1, 2], "approval callback mutation must not change executable arguments");
    assert.deepEqual(approvals, [1, 2]);
    const denied = await run("return await tools.lookup({id:9})");
    assert.equal(denied.response.isError, true);
    assert.deepEqual(calls, [1, 2]);
    const invalid = await run('return await tools.lookup({id:"not-an-integer"})');
    assert.equal(invalid.result.ok, false);
    assert.deepEqual(approvals, [1, 2, 9], "input validation must precede authorization");

    for (const code of ['return process.env', 'return await fetch("https://example.invalid")', 'return tools.lookup.constructor("return process")()']) {
      assert.equal((await run(code)).result.ok, false, "ambient host capabilities must not be available");
    }

    const limited = await run("for (let i=0;i<4;i++) await tools.lookup({id:i}); return true");
    assert.equal(limited.result.ok, false);
    assert.equal(limited.result.error.kind, "ToolCallLimitExceeded");
    assert.deepEqual(calls, [1, 2, 0, 1, 2], "the fourth call must never execute");
    const output = await run('return "x".repeat(5000)');
    assert.equal(output.result.truncated, true);
    assert.ok(Buffer.byteLength(output.response.content[0].text) < 3000);
    const thrown = await run('throw "x".repeat(1000000)');
    assert.equal(thrown.result.truncated, true);
    assert.ok(Buffer.byteLength(thrown.response.content[0].text) <= 1024);
    const timeout = await run("while (true) {}");
    assert.equal(timeout.result.ok, false);
    assert.equal(timeout.result.error.kind, "TimeoutExceeded");
  } finally { await bridge.close(); await client.close(); }

  // Cancellation must abort the authorization itself, never admit its late Allow,
  // and keep capacity occupied while that callback ignores cancellation.
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  let effects = 0;

  const waiting = createBobCodeMode({ tools: [{ ...tool, execute: async (input) => { effects++;

    return input; } }],
    authorize: async ({ signal }) => { signal.addEventListener("abort", () => aborted.resolve(), { once: true }); entered.resolve(); await release.promise;

      return "allow"; } });

  const other = new Client({ name: "code-mode-cancel", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await waiting.connect(b);
  await other.connect(a);
  const cancel = new AbortController();

  try {
    const pending = other.callTool({ name: "execute", arguments: { code: "return await tools.lookup({id:1})" } }, { signal: cancel.signal });
    const rejected = assert.rejects(pending);
    await entered.promise;
    cancel.abort();
    await rejected;
    await aborted.promise;
    const busy = await other.callTool({ name: "execute", arguments: { code: "return 1" } });
    assert.equal(busy.isError, true);
    assert.match(busy.content[0].text, /busy/);
    await waiting.close();
    release.resolve();
    await new Promise(setImmediate);
    assert.equal(effects, 0);
  } finally { release.resolve(); await waiting.close(); await other.close(); }
}

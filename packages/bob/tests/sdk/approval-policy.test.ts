import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { Bob, type BobApprovalPolicy, type BobEvent } from "../../src/sdk/index.js";
import { NativeAcpClient } from "../../src/client/native-acp-client.js";
import { BobSession } from "../../src/sdk/session-client.js";
import { readBootstrap } from "../../src/client/socket-bootstrap.js";
import { approvalPeer } from "./fixtures/approval-peer.mjs";

const options = [
  { optionId: "remember", name: "Always", kind: "allow_always" },
  { optionId: "yes", name: "Once", kind: "allow_once" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

const request = (kind?: string | null, choices = options) => ({
  toolCall: { toolCallId: "execute_command-untrusted-id", title: "execute_command", rawInput: { command: "anything" }, kind }, options: choices,
});

const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

async function open(transport: string, policy?: BobApprovalPolicy) {
  if (transport === "stdio") {
    const native = new NativeAcpClient({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/approval-peer.mjs", import.meta.url)), "--stdio"] });
    await native.start();
    const client = new BobSession({ workspace: process.cwd(), maxTextBytes: 1024, promptTimeoutMs: 5000, approvalPolicy: policy }, native);

    return { client, close: () => client.close() };
  }

  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".tmp", "ap-"));
  const socketPath = join(directory, "s");
  const peers: Socket[] = [];

  const server = createServer((peer) => {
    peers.push(peer);
    void readBootstrap(peer).then(() => {
      peer.write('{"version":1,"status":"ready"}\n');
      approvalPeer(peer, peer);
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  // Reuse the same boundary cases against the installed archive in smoke:package.
  const gateway = process.env.BOB_GATEWAY_TEST_PACKAGE
    ? (await import(pathToFileURL(process.env.BOB_GATEWAY_TEST_PACKAGE).href)).Bob : Bob;

  const client: Awaited<ReturnType<typeof Bob.connect>> = await gateway.connect({ socketPath, workspace: "/worker", credential: { kind: "apiKey", apiKey: "synthetic" }, approvalPolicy: policy });

  return { client, close: async () => {
    await client.disconnect();
    peers.forEach((peer) => peer.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

describe.each(["stdio", "socket"])("approval policy over %s ACP", (transport) => {
  it("preserves manual handling, evaluates exact categories before fallback, and never guesses identity/options", async () => {
    const owned = await open(transport);
    const { client } = owned;
    let manual = 0;
    const decisions: BobEvent[] = [];
    client.subscribe((event) => {
      if (event.type === "permission_auto_decision") decisions.push(event);

      if (event.type === "permission_request") { manual++; client.respondToPermission(event.permissionId, "no"); }
    });

    try {
      const { sessionId } = await client.newSession();
      const send = (...requests: ReturnType<typeof request>[]) => client.prompt(sessionId, [{ type: "text", text: JSON.stringify(requests) }]);
      expect((await send(request("execute")))._meta?.outcomes).toEqual([selected("no")]);
      expect(manual).toBe(1);
      client.setApprovalPolicy({ kinds: { execute: "allow", edit: "deny", fetch: "ask" }, fallback: "deny" });
      expect(decisions).toEqual([]);
      expect((await send(request("execute"), request("edit"), request("fetch"), request(), request("other"), request("future-category"), request("read"), request(null)))._meta?.outcomes)
        .toEqual([selected("yes"), selected("no"), selected("no"), selected("no"), selected("no"), selected("no"), selected("no"), selected("no")]);
      expect(decisions).toEqual([
        { type: "permission_auto_decision", permissionId: "2", sessionId, toolCallId: "execute_command-untrusted-id", match: "category", kind: "execute", decision: "allow" },
        { type: "permission_auto_decision", permissionId: "3", sessionId, toolCallId: "execute_command-untrusted-id", match: "category", kind: "edit", decision: "deny" },
        ...[["5", null], ["6", "other"], ["7", null], ["8", "read"], ["9", null]].map(([permissionId, kind]) =>
          ({ type: "permission_auto_decision", permissionId, sessionId, toolCallId: "execute_command-untrusted-id", match: "fallback", kind, decision: "deny" })),
      ]);
      expect(manual).toBe(2);
      client.setApprovalPolicy({ kinds: { execute: "allow" } });
      await send(request(), request("other"), request("read"), request("execute", options.filter((o) => o.kind !== "allow_once")),
        request("execute", [...options, { optionId: "yes2", name: "Duplicate", kind: "allow_once" }]),
        request("execute", [...options, { optionId: "yes", name: "Collision", kind: "allow_always" }]));
      expect(manual).toBe(8);
      client.setApprovalPolicy(undefined);
      await send(request("execute"));
      expect(manual).toBe(9);
      expect(decisions).toHaveLength(7);
      let reads = 0;
      client.setApprovalPolicy({ get kinds() {
        // SAFETY: emulate a JavaScript accessor returning an invalid later value.
        return (++reads <= 3 ? { execute: "deny" } : { other: "allow" }) as BobApprovalPolicy["kinds"];
      } });
      expect((await send(request("execute"), request("other")))._meta?.outcomes).toEqual([selected("no"), selected("no")]);
      expect(manual).toBe(10);
    } finally { await owned.close(); }
  });

  it("snapshots policy, leaves pending requests manual, cancels once, and isolates connections and sessions", async () => {
    const policy: BobApprovalPolicy = { kinds: { execute: "allow" } };
    const first = await open(transport, policy);
    const second = await open(transport);
    policy.kinds!.execute = "deny";
    const events: Extract<BobEvent, { type: "permission_request" }>[] = [];
    const decisions: BobEvent[] = [];
    second.client.subscribe((event) => {
      if (event.type === "permission_request") events.push(event);

      if (event.type === "permission_auto_decision") decisions.push(event);
    });

    try {
      const a = await first.client.newSession();
      const b = await second.client.newSession();
      const c = await second.client.newSession();
      const content = [{ type: "text" as const, text: JSON.stringify([request("execute"), request("execute")]) }];
      expect((await first.client.prompt(a.sessionId, content))._meta?.outcomes).toEqual([selected("yes"), selected("yes")]);
      const pending = second.client.prompt(b.sessionId, content);
      await expect.poll(() => events.length).toBe(2);
      second.client.setApprovalPolicy({ kinds: { execute: "allow" } });
      await expect(second.client.prompt(c.sessionId, content)).rejects.toMatchObject({ code: "busy" });
      second.client.respondToPermission(events[0].permissionId, "no");
      expect(() => second.client.respondToPermission(events[0].permissionId, "yes")).toThrow();
      await second.client.cancel(b.sessionId);
      expect((await pending)._meta?.outcomes).toEqual([selected("no"), { outcome: { outcome: "cancelled" } }]);
      expect(() => second.client.respondToPermission(events[1].permissionId, "yes")).toThrow();
      expect(decisions).toEqual([]);

      for (const invalid of [{ fallback: "allow" }, { kinds: { other: "allow" } }, { tools: { execute_command: "allow" } }, { kinds: { edit: "typo" } }, null]) {
        // SAFETY: deliberately invalid JavaScript input exercises public runtime validation.
        expect(() => second.client.setApprovalPolicy(invalid as BobApprovalPolicy)).toThrow();
      }

      expect((await second.client.prompt(c.sessionId, content))._meta?.outcomes).toEqual([selected("yes"), selected("yes")]);
      expect(decisions).toEqual([
        { type: "permission_auto_decision", permissionId: "3", sessionId: c.sessionId, toolCallId: "execute_command-untrusted-id", match: "category", kind: "execute", decision: "allow" },
        { type: "permission_auto_decision", permissionId: "4", sessionId: c.sessionId, toolCallId: "execute_command-untrusted-id", match: "category", kind: "execute", decision: "allow" },
      ]);
      const late = second.client.prompt(b.sessionId, [{ type: "text", text: JSON.stringify({ sequential: [request("fetch"), request("execute")] }) }]);
      await expect.poll(() => events.length).toBe(3);
      await second.client.cancel(b.sessionId);
      expect((await late)._meta?.outcomes).toEqual([{ outcome: { outcome: "cancelled" } }, { outcome: { outcome: "cancelled" } }]);
      expect(events.length).toBe(3);
      expect(decisions).toHaveLength(2);
      expect((await second.client.prompt(b.sessionId, content))._meta?.outcomes).toEqual([selected("yes"), selected("yes")]);
      second.client.setApprovalPolicy({ kinds: { execute: "deny" } });
      expect((await second.client.prompt(b.sessionId, content))._meta?.outcomes).toEqual([selected("no"), selected("no")]);
      expect((await first.client.prompt(a.sessionId, content))._meta?.outcomes).toEqual([selected("yes"), selected("yes")]);
    } finally { await Promise.all([first.close(), second.close()]); }
  });

  it("freezes attribution before observers run and keeps each settled decision across reentrant changes", async () => {
    const owned = await open(transport, { kinds: { execute: "allow" } });
    const { client } = owned;
    const decisions: BobEvent[] = [];
    const lateReplies: boolean[] = [];
    client.subscribe((event) => {
      if (event.type !== "permission_auto_decision") return;
      client.setApprovalPolicy({ fallback: "deny" });

      try { client.respondToPermission(event.permissionId, "no"); lateReplies.push(false); }
      catch { lateReplies.push(true); }

      // Reflect avoids a readonly cast; an earlier observer must not corrupt later delivery.
      Reflect.set(event, "decision", "allow");
      Reflect.set(event, "sessionId", "wrong-session");
      throw new Error("observer failure");
    });
    client.subscribe((event) => { if (event.type === "permission_auto_decision") decisions.push(event); });

    try {
      const { sessionId } = await client.newSession();
      const result = await client.prompt(sessionId, [{ type: "text", text: JSON.stringify({ sequential: [request("execute"), request("execute")] }) }]);
      expect(result._meta?.outcomes).toEqual([selected("yes"), selected("no")]);
      expect(decisions).toEqual([
        { type: "permission_auto_decision", permissionId: "1", sessionId, toolCallId: "execute_command-untrusted-id", match: "category", kind: "execute", decision: "allow" },
        { type: "permission_auto_decision", permissionId: "2", sessionId, toolCallId: "execute_command-untrusted-id", match: "fallback", kind: "execute", decision: "deny" },
      ]);
      expect(lateReplies).toEqual([true, true]);
      expect(decisions.every(Object.isFrozen)).toBe(true);
      await client.cancel(sessionId);
      expect(decisions).toHaveLength(2);
    } finally { await owned.close(); }

    expect(decisions).toHaveLength(2);
  });

  it("retains local settlement when the peer disconnects without completing the prompt, with no replay on replacement", async () => {
    const decisions: BobEvent[] = [];

    for (let generation = 0; generation < 2; generation++) {
      const owned = await open(transport, { fallback: "deny" });
      const { client } = owned;
      const observed: BobEvent[] = [];
      client.subscribe((event) => { observed.push(event);

 if (event.type === "permission_auto_decision") decisions.push(event); });

      try {
        const { sessionId } = await client.newSession();
        expect(observed).toEqual([]);
        await expect(client.prompt(sessionId, [{ type: "text", text: JSON.stringify({ sequential: [request("execute")], disconnect: true }) }])).rejects.toThrow();
        await expect.poll(() => observed.some((event) => event.type === "connection_error")).toBe(true);
        expect(observed.filter((event) => event.type === "permission_auto_decision")).toEqual([
          { type: "permission_auto_decision", permissionId: "1", sessionId, toolCallId: "execute_command-untrusted-id", match: "fallback", kind: "execute", decision: "deny" },
        ]);
        expect(observed.some((event) => event.type === "session_update" || event.type === "permission_request")).toBe(false);
      } finally { await owned.close(); }

      expect(decisions).toHaveLength(generation + 1);
    }
  });
});

it.each(["reply", "cancel"])("does not emit automatic attribution when %s already settled the native request", async (action) => {
  const native = new NativeAcpClient({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/approval-peer.mjs", import.meta.url)), "--stdio"] });
  await native.start();
  let cancellation: Promise<void> | undefined;
  // A pre-existing native subscriber wins settlement; the shared owner must not report its own policy decision.
  native.subscribe((event) => {
    if (event.type !== "permission_request") return;

    if (action === "reply") native.respondToPermission(event.permissionId, "no");
    else cancellation = native.cancel(event.request.sessionId);
  });
  const client = new BobSession({ workspace: process.cwd(), maxTextBytes: 1024, promptTimeoutMs: 5000, approvalPolicy: { kinds: { execute: "allow" } } }, native);
  const events: BobEvent[] = [];
  client.subscribe((event) => events.push(event));

  try {
    const { sessionId } = await client.newSession();
    const result = await client.prompt(sessionId, [{ type: "text", text: JSON.stringify([request("execute")]) }]);
    await cancellation;
    expect(result._meta?.outcomes).toEqual([action === "reply" ? selected("no") : { outcome: { outcome: "cancelled" } }]);
    expect(events).toEqual([]);
  } finally { await client.close(); }
});

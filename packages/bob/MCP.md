# Exact MCP tool authorization

The gate uses stable MCP client/server/core 2.2.0 and Node adapter 2.1.0, including
the upstream request-ID-zero cancellation fix. The SDK build applies a narrowly
reviewed, version/hash-checked correction for an upstream SSE bookkeeping leak;
see **Compatibility maintenance** below. Use the newly built package, not an
earlier development archive that predates this correction.

`@camenae/bob/mcp` exports `createMcpToolGate`. This opt-in trusted-application
component forwards standard MCP tool calls to one configured upstream server.
It matches the configured server identity and the exact `tools/call` tool name,
never ACP titles, tool-call IDs, arguments, or name patterns. The gate changes no
ACP messages. The separately documented
[Bob ACP correction](BOB-ACP-CORRECTION.md) makes native `alwaysAllow` usable for
selective delegation to this gate without global auto-approval.

## Application integration

```ts
import { randomBytes } from "node:crypto";
import { createMcpToolGate } from "@camenae/bob/mcp";

const gateToken = randomBytes(32).toString("hex");
const gate = await createMcpToolGate({
  server: {
    name: "documents",
    type: "http",
    url: upstreamMcpUrl,
    headers: [{ name: "Authorization", value: upstreamAuthorization }],
    disabledTools: ["destroy_workspace"],
  },
  bearerToken: gateToken,
  policy: {
    tools: { search_documents: "allow", update_document: "ask", delete_document: "deny" },
    fallback: "deny",
  },
  onPermissionRequest: async ({ permissionId, serverName, toolName, arguments: input, signal }) => {
    // Application authenticates the user and binds this gate to their worker/turn.
    // Persist/display only in that authorized scope. Never log the input.
    // Remove stale UI prompts when signal aborts. Resolve exactly "allow" or "deny".
    return applicationApproval({ permissionId, serverName, toolName, input, signal });
  },
  onAutoDecision: (event) => {
    // Bind to this gate's authenticated application scope; do not infer ACP IDs.
    // Local authorization only, NOT proof that a tool ran. Never log blindly.
    applicationHistory(event);
  },
});

// Mount at a dedicated route in your application-owned Node HTTP server:
// await gate.handleRequest(incomingMessage, serverResponse);
// Route requests BEFORE any middleware consumes their body.

// Give Bob ONLY the gate URL and this gate's credential, never upstream secrets:
const bobServer = {
  name: "documents",
  type: "http" as const,
  url: workerReachableGateUrl,
  headers: [{ name: "Authorization", value: `Bearer ${gateToken}` }],
  // Delegate all these native permission checks to the gate, including Ask/Deny.
  alwaysAllow: ["search_documents", "update_document", "delete_document"],
};
// Use bobServer in start/serveOnce({ autoApprove: false, managedMcpServers: [...] }).
// Do not also register the same server through newSession({ mcpServers: [...] });
// standard ACP server definitions do not carry alwaysAllow.

// Updates affect subsequent calls, not already pending approvals/forwarded calls.
gate.setPolicy({ tools: { update_document: "deny" }, fallback: "deny" });
// On worker/turn teardown, close the gate; an idle HTTP disconnect alone is not teardown.
await gate.close();
```

The names above are illustrative, not Bob built-in tool identifiers. Stdio
upstreams use the same `name`, absolute `command`, `args`, `env`, and
`disabledTools` shape as `managedMcpServers`. They run in the trusted application's
working directory/environment, not in Bob's worker. The MCP SDK inherits its
small default environment plus explicit `env`; it does not automatically pass
the full application environment. Do not launch untrusted MCP executables in the
application process boundary. Server stderr is discarded to avoid secret leakage.

Create **one gate per upstream server per application/worker scope**. Each gate
admits one standard MCP session and owns one upstream connection. Do not share it
across users or independent Bob sessions. A new/replacement MCP session needs a
new gate and token. DELETE ends the session. The application owns listener, path
routing, TLS, network exposure, worker provisioning, and closing gates on teardown.
The gate starts no HTTP listener and does not configure deployment egress.

## Availability versus authorization

- `disabledTools` is a startup snapshot. Disabled names are filtered from tool
  listings and direct calls are denied even with an Allow policy. An Allow rule
  never re-enables a disabled tool. Changing availability requires a new gate.
- Enabled tools stay in listings regardless of Allow / Ask / Deny. Deny prevents
  forwarding; Ask waits for the application; Allow forwards the actual call.
- Policy keys are case-sensitive exact names. A key `write_*` is a literal name,
  not a wildcard. Same-name tools on different servers use separate gates/rules.
- Default fallback is Deny. Callers can explicitly select Ask or Allow fallback;
  Allow also authorizes newly introduced upstream tool names. Prefer explicit
  rules when the upstream tool set changes over time.
- Policy is copied on installation. Invalid updates leave the old policy intact.
  Pending Ask requests stay Ask with their original application decision path.
  Updating a rule cannot revoke an approval already pending or undo a forwarded
  call. Close the old gate to abort pending approvals before replacing a scope.

## Ask and lifecycle

Each Ask callback has a fresh opaque `permissionId`, the configured `serverName`,
the exact requested `toolName`, a detached copy of arguments, and an AbortSignal.
There is **no ACP session/tool-call correlation**: standard MCP does not provide
that binding. Camenae must attach its own gate/worker/turn scope when creating the
callback. Do not infer correlation from arrival order or tool names.

No handler, a thrown/rejected callback, a non-`allow` answer, deadline expiry,
standard MCP cancellation, active HTTP disconnect, or gate closure prevents
forwarding. Late approvals cannot resurrect cancelled calls. The default Ask
deadline is 60 seconds (`approvalTimeoutMs`, 1–1,800,000 ms). The application must
observe the signal to stop its own UI/work; the SDK cannot forcibly stop an
arbitrary application promise. A successful callback means authorization, not
execution or success. Only the upstream tool result describes that execution.

## Automatic-decision reporting

`onAutoDecision(event)` receives a frozen `McpToolAutoDecisionEvent` captured by
the existing authorization owner, not reconstructed from later settings:

```ts
type McpToolAutoDecisionEvent = Readonly<{
  type: "mcp_tool_auto_decision";
  decisionId: string; // fresh opaque ID per automatically evaluated call
  serverName: string;
  toolName: string;
} & (
  | { match: "tool" | "fallback"; decision: "allow" | "deny" }
  | { match: "disabled"; decision: "deny" }
)>;
```

- `tool` means an explicit exact-name rule; `fallback` means no such rule.
  `disabled` is **availability rejection**, not a matched Deny policy.
- Each automatic call has a distinct `decisionId`, including repeated calls to
  the same tool. No arguments, results, credentials, policy snapshot, MCP request
  ID, or ACP correlation are included. Applications attach their own gate scope.
- The event describes local authorization before forwarding/returning denial.
  It does not promise upstream delivery, execution, success, durable storage,
  replay, or exactly-once delivery across retries. Protocol/auth/admission failures
  and calls already cancelled before evaluation emit no event.
- Ask uses the existing callback/permission ID and emits **no automatic event**,
  including callback error, invalid result, missing handler, timeout, or cancellation.
  The application already owns the Ask interaction. A changed policy never
  relabels a pending Ask as an automatic decision.
- The observer is invoked synchronously but never awaited. Throws/rejections are
  swallowed without logging and cannot change authorization. Reentrant `setPolicy`
  affects later calls only. Reentrant `close` or later cancellation can prevent
  delivery after an Allow event; the final cancellation check still runs.
- Existing ACP `permission_auto_decision` remains separate and unchanged. Neither
  event should be presented as a tool-execution receipt.

`close()` aborts approvals and forwarding, allows up to two seconds for HTTP
responses to settle, then tears down transports. Cancellation after forwarding
cannot undo upstream side effects. Stdio cleanup uses the official MCP SDK's
bounded direct-child shutdown, **not the SDK's Bob process-tree cleanup**;
deployments own isolation/descendant teardown. No persistent audit, replay,
exactly-once execution, or automatic retries of tool calls are added.

## Security and protocol scope

- Exact bearer authentication is required on every request, including cancel and
  DELETE. Supply a distinct high-entropy token of at least 32 printable characters
  per gate. It grants access only to that gate, not to the application generally.
- Browser Origin requests are rejected; no CORS is enabled. The application must
  use TLS or an appropriately private authenticated network outside loopback.
- HTTP bodies are limited to 1 MiB and ten seconds of upload time. The default
  admission limit is 32 requests (`maxConcurrentRequests`, 1–1024), with eight
  bounded extra upload slots so cancellation/DELETE can pass a full approval
  limit. All slots still require the correct gate token.
- Only tool listing/calling plus standard MCP lifecycle are supported. No
  resources, prompts, sampling, elicitation, task execution, standalone GET SSE,
  or tool-list-change notification forwarding. Tool discovery may be refreshed
  by an explicit list request. Metadata and task extensions are not forwarded
  into upstream calls. Tool arguments and results are otherwise preserved.
- Upstream credentials stay in the trusted service, not Bob's MCP definition.
  The service emits no tool-input/output/credential logs. Application access
  logs, error reporters, approval storage, and UI still need their own privacy
  controls. Upstreams are trusted configuration, not URLs supplied by Bob.
- **Not a sandbox:** deployments must prevent Bob from directly reaching upstream
  services/credentials, invoking a separate stdio server, or editing the trusted
  gate process. Shell/HTTP tools can otherwise bypass the gate. Unmanaged MCP
  definitions and built-in Bob tools do not pass through it.
- Existing ACP category policy is independent. Use the corrected packaged runtime
  and native `alwaysAllow` for the exact gate-controlled catalog, as above. An
  omitted/new tool can still receive an earlier native question; persist server
  trust and update the catalog through worker/gate replacement before promising
  no prompts for newly discovered tools. The gate never guesses native identity.
  Do not turn on global Bob auto-approval to hide incomplete delegation.

## Verification status

The SDK tests exercise real standard MCP HTTP clients through the gate to real
stdio and Streamable HTTP fixture servers. Upstream file receipts distinguish
execution from labels or returned denials. Coverage includes exact policy rules,
availability, Ask decisions and timeouts, cancellation at full capacity, active
disconnect/close, scope isolation, unchanged arguments, authentication, body
limits, and unsupported task/resource requests. `smoke:package` repeats this
suite against the installed archive and compiles the public subpath types.

V1 clients/fixture servers are retained to verify Bob-era protocol compatibility
with the v2 gate. Numeric request ID `0` and repeated cancellation now pass the
public HTTP-boundary test; that admission test does not prove bounded internal
SDK bookkeeping. The separate cleanup diagnostic establishes the remaining
defect in the unmodified dependency. The build-level regression tests prove the
correction independently of the gate's behavioral tests.

`smoke:mcp:approval` and the installed-package smoke additionally exercise actual
corrected Bob with loopback model replies through native/socket SDK paths. The
credentialed equivalent is `smoke:mcp:approval:live -- <archive>`. See
[BOB-ACP-CORRECTION.md](BOB-ACP-CORRECTION.md) for patch removal and
[COMPATIBILITY.md](COMPATIBILITY.md) for verified platform limits. Consumer
persistence, routing/UI, non-Node HTTP hosting, actual Git tool semantics and
deployment containment remain separate work.

## Compatibility maintenance

Unmodified MCP server 2.2.0 retains request-to-stream entries after cancellations:
the diagnostic observed 100 entries after 100 cancellations and still 100 after
close, despite zero streams/responses. `scripts/mcp-cleanup.mjs` corrects the
owning transport during the managed build:

- Retire request/response bookkeeping when a **non-resumable** SSE stream ends,
  even when cancellation suppresses its final reply.
- Retain identifiers across event-store-backed disconnection so resumption works.
- Clear all remaining request identifiers at terminal transport close.

The correction changes no MCP messages, tool identities, authorization rules,
or installed dependency files. Unexpected package versions, changed source
digests, non-unique patch anchors, or a missing transform fail the SDK build.
It applies to the SDK's shipped bundles, not arbitrary direct imports of the
unmodified dependency or unsupported execution of SDK source files.

`tests/sdk/mcp-transport-cleanup.test.mjs` bundles the official dependency through
that same build transform, tests 100 cancel and disconnect cycles with zero
retained request entries, verifies Node HTTP cancellation teardown, and exercises
actual event-store resumption before terminal cleanup. Its private-map inspection
is deliberately limited to this pinned dependency repair; no private-state API
is exported by the SDK. The regression failed without the correction.

Before upgrading MCP, run this regression against the candidate unmodified
release. Remove the transform when upstream passes it; do not simply update the
version/hash to bypass the review. This is a local maintenance obligation, not
an upstream release or an upstream-accepted fix.

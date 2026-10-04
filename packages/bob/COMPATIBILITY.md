# Bob compatibility

## Runtime identity

`@camenae/bob` starts exact package-private Bob 2.0.5 (release commit
`2dc1809063bd2c2b550e66b5c20854f3cf8cb9f4`) through the caller's Bun or Node
executable. It does not search PATH for a Bob installation. The
[`runtime/compatibility.json`](runtime/compatibility.json) manifest is the authority
for archive, original/corrected entrypoint, native helper and OfficeCLI identities.

Preparation verifies an authorized original archive before applying two ordered
corrections. The shipped Bob entrypoint is modified; its unchanged native version
string does not identify the delivery bytes. Preserve archive digests and the
separate correction removal gates.

| Correction | Owner and contract |
| --- | --- |
| `acp-mcp-always-allow-v1` | Native exact-tool MCP approval delegation; [guide and removal gate](BOB-ACP-CORRECTION.md) |
| `acp-session-usage-v1` | Bob-owned session accounting snapshots; [guide and removal gate](BOB-USAGE-CORRECTION.md) |
| MCP server transport cleanup | Build-time repair for pinned MCP server 2.2.0 bookkeeping; [independent regression and removal gate](MCP.md#compatibility-maintenance) |
| ACP diagnostics | Build-time sanitization of protocol diagnostics; [logging contract](SDK.md#errors) |

Do not hand-edit generated Bob or installed dependencies. Unexpected versions,
digests, non-unique patch anchors and missing build transforms must fail closed.
Fixing one upstream defect does not authorize removal of the other corrections.

## Configuration, state and authorization

- The SDK uses caller-owned workspaces and environment. It does not provision a
  sandbox, copy projects, manage artifacts or delete state on close.
- Managed configuration is opt-in and owns only `.bob/mcp.json` and/or
  `.bob/custom_modes.yaml`. It rejects unmanaged, edited and linked files,
  requires exclusive ownership and previous-worker teardown, and persists.
- With `disableMcp: true`, the tested workspace MCP tools were absent from model
  schemas, but tools supplied through `newSession({ mcpServers: [...] })` remained
  visible. **Configured workspace MCP commands still start during initialization.**
  This is not blanket suppression of later-added/restored tools, proof of direct
  tool-call rejection, or an egress/process boundary. A deployment requiring zero
  MCP startup must resolve that limitation.
- `disableSubagents` controls native registration; startup with the flag alone
  does not establish live enforcement or an isolation boundary.
- Exact-tool `alwaysAllow` bypasses native ACP category policy. Gate-controlled
  definitions must point to the gate, and policy-controlled clients must keep
  global auto-approval off. Tools and child processes may inherit Bob's API key.
- Native cancellation cannot undo upstream side effects. Permission decisions
  are not execution receipts or a durable audit log.
- Keep `gatewayUserConfig`, `bob-gateway/config.json`, `BOB_GATEWAY_*` variables,
  managed-file ownership markers, bootstrap versions and `bob-gateway/usage`
  unchanged unless explicitly migrating the compatibility contract. These are
  persisted/protocol identifiers, not public package aliases.

See [SDK.md](SDK.md) and [MCP.md](MCP.md) for ownership and refusal behavior.

## Worker and authentication boundaries

The private Unix socket admits one connection per worker lifetime, including
bootstrap and cleanup. Additional connections are rejected, not queued. Key
authentication uses bootstrap v1; explicit SSO requires v2 and cannot downgrade.
The bootstrap cannot select another executable, environment or worker workspace.
ACP is forwarded unchanged after bootstrap.

The worker entrypoint must exit after `serveOnce()` settles. The deployment must
retire the **entire execution lifetime** before reusing workspace/state or starting
a replacement. `disconnect()`, EOF, socket existence, a healthy status, or a
retained container ID do not acknowledge cleanup. Do not claim the single-use
connection to probe readiness, or restart only the listener inside a live worker.

Keep the socket directory private and outside workspace/Bob state. Permissions
alone do not isolate hostile same-UID tools; process-tree cleanup cannot contain
tools that detach or reparent. Never expose application credentials or global
control authority to the worker. Existing sockets are not silently replaced.

SSO strips both API-key aliases and bypasses user-config credentials. Bob owns
tokens; consumers own private HOME, umask and retention. Authentication abort or
timeout closes the client but does not confirm remote teardown. Closing a client
is not logout. Remote browser login is not implemented.

## Verification limits

The full installed-package suite is verified on Linux x64 with Bun 1.4.2 and
Node 22.18.0. This is not proof at Node's minimum 22.15.0, on all macOS/Linux
architectures, or for every native tool. Historical macOS ARM64 Node and synthetic
SSO probes do not establish current cross-platform acceptance. Windows is not
supported by this SDK startup/transport path.

Live Linux proof is limited to bounded native/socket prompts; it is not broad
tool, model-quality, Office or billing reconciliation acceptance. Interactive
Linux SSO, real IBM browser sign-in, hosted remote exposure, durability, exhaustive
child-task/compaction accounting and deployment containment remain separate work.

The real-Bob MCP smoke uses loopback model replies, not mocked permission receipts.
Its non-chat routes return 404 before JSON parsing: parsing bodyless metadata GETs
first caused retryable 500s and minutes of delay. Keep the zero-500 regression and
the complete permission/replacement matrix; do not hide fixture failures by
raising deadlines or dropping cases. Caller-authored YAML/rules and SDK-managed
custom modes protect different configuration paths and retain separate coverage.

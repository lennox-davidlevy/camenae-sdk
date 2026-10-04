# Bob SDK

The TypeScript/ESM SDK for Bun and Node.js starts exact Bob **2.0.5** from this package's private
`runtime/bob/dist/bob.js`, using the running Bun or Node executable and official ACP
client. It does not launch Docker or resolve `bob` from PATH.

The SDK leaves `.bob` unchanged by default. The explicit `managedMcpServers`
startup option owns only `.bob/mcp.json`; `managedCustomModes` owns only
`.bob/custom_modes.yaml`. Both are opt-in and require an application-owned workspace.

**Known upstream limitation:** in Bob 2.0.5, `disableMcp: true` does not prevent a
workspace-configured MCP command from starting during session initialization.
Do not rely on this flag as an execution or network boundary. The SDK forwards
the native flag unchanged; it does not rewrite Bob's
configuration to conceal the defect. Deployments requiring zero MCP startup must
resolve this acceptance blocker before adopting the runtime.

The tested workspace tools were hidden from model schemas by `disableMcp`, but
session-supplied `newSession({ mcpServers: [...] })` tools remained visible. Do not
assume blanket suppression of later-added/restored tools or direct-call rejection.

## Requirements

- Bun `>=1.4.2` or Node.js `>=22.15.0`
- macOS or Linux, ARM64 or x64; see [verified platforms and limits](COMPATIBILITY.md#verification-limits)
- `/bin/ps` for owned-process teardown (install `procps` in minimal Linux images)
- the packaged Bob assets and exact npm runtime dependencies
- a Bob API key, or explicit native SSO with consumer-owned Bob state (see below)

Install the internal npm archive into your application. Bob assets and IBM
notices/licenses are included; npm installs pinned node-pty, ripgrep, and
OfficeCLI helpers. With Bun, trust `@officecli/officecli` in the consuming
application's `trustedDependencies` so its platform-binary installer runs.
If your npm version blocks dependency scripts, approve the
exact `@officecli/officecli@1.0.144` install script in your application's
`allowScripts` settings, then rebuild that dependency. The platform binary must
be present and match the pinned digest before startup.

For a source checkout, install workspace dependencies from the root, then run
these commands from `packages/bob/`:

```sh
bun run runtime:prepare /absolute/path/to/bobshell-2.0.5.tgz
bun run build
bun run smoke:package
bun run smoke:package:node
```

`runtime/compatibility.json` owns the exact versions and digests. Builds reject
unstaged/modified Bob code and dependency-version drift.
The separate preparation-owned [usage correction](BOB-USAGE-CORRECTION.md)
exposes Bob's native accounting; it is independent of the MCP permission correction.

### Session context and Bobcoin usage

Direct and Unix-socket SDK clients receive snapshots through the existing
subscription API. Subscribe before opening the session:

```ts
import type { BobSessionUsage } from "@camenae/bob";

const usageBySession = new Map<string, BobSessionUsage>();
const unsubscribe = client.subscribe((event) => {
  if (event.type !== "session_update") return;
  const { sessionId, update } = event.notification;
  // Versioned metadata from the pinned Bob runtime, not arbitrary tool output.
  const usage = update._meta?.["bob-gateway/usage"] as
    BobSessionUsage | undefined;
  if (usage?.version !== 1) return;
  usageBySession.set(sessionId, usage); // replace snapshots; do not add totals
  const percent = usage.contextTokens !== null && usage.contextWindow !== null
    ? 100 * usage.contextTokens / usage.contextWindow : null;
  // Render percent, usage.bobcoins, usage.maxOutputTokens, and
  // usage.compactionThreshold as desired. Null means unknown, not zero.
});
```

Snapshots refresh on session new/load/resume, mode changes, and turn completion
(including failed native execution); not continuously within a turn. Standard
`usage_update.used/size` is also populated when both context values are known.
When capacity is unknown, metadata arrives on `session_info_update` instead.
There is no assumed 250k capacity. The configured compaction threshold is a
fraction (normally `0.9`), and `maxOutputTokens` is a separate output limit.
Limits start unknown on a fresh/replacement worker until native Bob resolves
its model. Reporting does not initiate provider requests to populate the display.

Bobcoins are Bob's cumulative root-session accounting, **not** remaining account
balance or an invoice. Missing provider charges can remain zero in Bob; do not
interpret zero as proof of free usage. Resume restores native persisted totals.
Context occupancy can decrease after compaction and is not cumulative token
consumption. See the [full contract and limitations](BOB-USAGE-CORRECTION.md).

To build a local delivery archive, run from `packages/bob/`:

```sh
bun run release
```

The command shows the current version and suggests the next patch version. Press
Enter to accept, type `minor`, `major`, or an exact stable version such as `0.3.0`,
or enter `q` to cancel. For non-interactive use: `bun run release patch` (or
`minor`, `major`, or an exact version).

It updates the package's `package.json` and npm lockfile and the workspace Bun
lockfile, builds through `prepack`, and writes `artifacts/camenae-bob-<version>.tgz`. Package metadata is the
version source for the SDK.
It does not run tests, commit, tag, or publish. Run the required checks before
delivery. Existing archives are never overwritten. If packaging fails after the
bump, the new version remains; fix the failure and retry with
`npm pack --pack-destination artifacts` rather than bumping again.

## Start

```ts
import { Bob } from "@camenae/bob";

const client = await Bob.start({
  credential: { kind: "gatewayUserConfig" },
  workspace: "/absolute/project",
  autoApprove: false,
  disableMcp: false,
  disableSubagents: false,
  limits: {
    promptTimeoutMs: 30 * 60_000,
    maxTextBytes: 8 * 1024 * 1024,
  },
});
```

Use `{ kind: "apiKey", apiKey: "..." }` to provide a key directly. Automatic
approval is on by default; use `autoApprove: false` for interactive applications.
When the option is omitted, `BOB_GATEWAY_AUTO_APPROVE=false`, `0`, `no`, or `off`
disables automatic approval. An explicit per-client boolean takes precedence.

`workspace` must be an existing absolute directory. Bob works there directly;
`client.workspace` is its resolved real path. The SDK never copies the project,
replaces `.bob`, provisions artifact storage, or deletes the workspace on close.
Bob interprets the caller's `.bob` configuration itself.

The child inherits the application environment, with optional per-client
`environment` overrides; set a value to `undefined` to omit it. The SDK supplies
the chosen `BOB_API_KEY` in key mode, prepends the running Node directory to `PATH`, and sets
`OFFICECLI_SKIP_UPDATE=1`. It does not mutate the application's environment.
`gatewayUserConfig` reads the calling application's compatible private credential config.
If clients need separate Bob state, the application must provision HOME/XDG/tmp
directories and pass them via `environment`. Otherwise Bob uses the inherited
state locations. The SDK does not remove those directories.

**This is not a sandbox.** Bob and its tools run with the application's OS
permissions and environment. Containerization, network access, privacy policy,
workspace copies, access decisions, and data retention belong to the consumer.
Use trusted projects/configuration or provide outer isolation.

### Compatibility identifiers

Credential selection `gatewayUserConfig`, its `bob-gateway/config.json` path,
`BOB_GATEWAY_*` environment variables, managed-file ownership markers, bootstrap
versions and `bob-gateway/usage` are stable compatibility identifiers. They do
not change with package branding. See [compatibility](COMPATIBILITY.md).

`disableMcp` and `disableSubagents` are top-level startup options. Prepare any
workspace copy and caller-authored `.bob` configuration before `start()`; manage
inputs and outputs using application filesystem/storage APIs.

## Managed custom modes

Pass `managedCustomModes` to `Bob.start()` or worker-side `Bob.serveOnce()` to
configure native Bob personas before startup. The application chooses the role; the SDK
validates and manages only `.bob/custom_modes.yaml`.

```ts
import { Bob, type BobCustomMode } from "@camenae/bob";

const modes: BobCustomMode[] = [{
  slug: "camenae",
  name: "Camenae",
  roleDefinition: "You are Camenae, a general-purpose assistant, not limited to coding.",
  customInstructions: "Answer directly. Be practical and honest about uncertainty.",
  groups: ["read", "mcp"], // Choose deliberately; these do not auto-approve tools.
}];

const client = await Bob.start({
  workspace: "/absolute/application-owned/workspace",
  credential: { kind: "apiKey", apiKey: process.env.BOB_API_KEY! },
  autoApprove: false,
  managedCustomModes: modes,
});
try {
  const session = await client.newSession();
  await client.setMode(session.sessionId, "camenae");
  // Subscribe and handle permissions before sending the first prompt.
} finally {
  await client.close();
}
```

For isolated workers, put the same option on `serveOnce()`, then select the mode
through the connected client. `connect()` rejects this worker-only option.
Mode selection is not automatic: select before the first prompt, and explicitly
choose the intended mode when loading/resuming a session. A custom role does not
remove all other Bob system instructions or guarantee a model's response style.

Supported fields are `slug`, `name`, `roleDefinition`, optional `description`,
`whenToUse`, `customInstructions`, and `groups`. Unknown fields are rejected.
Slugs use 1–64 ASCII letters, digits, or dashes; duplicates and built-in slugs
`agent`, `plan`, `ask` are rejected. Names are nonblank and at most 256 code units;
role definitions are nonblank and at most 65,536. Each optional text field has
the same 65,536 limit. NUL characters are rejected. At most 128 definitions and
1 MiB of serialized configuration are accepted. Validation errors are redacted
`configuration_invalid` errors, not echoes of the supplied instructions.

Groups are `read`, `edit`, `execute`, `browser`, `mcp`, `skill`, `todo`, `artifact`,
`subtask`, `subagent`, `mode`, and `workflow`. File restrictions use native tuples,
for example `["edit", { fileRegex: "\\.md$" }]`; patterns must compile and contain
1–4,096 code units. Duplicate groups are rejected. Omitted/empty groups enable no
grouped tools; this does not claim all native ungrouped tools are disabled.
Native runtime flags and platform/tool support still apply. Groups govern tool
availability, not approvals or OS isolation; approval policy remains unchanged.
Avoid slug collisions with caller-provided global/plugin modes; Bob owns their
precedence, and the SDK does not inspect or modify those files.

Ownership and replacement:

- Omitted option leaves the mode file untouched. `[]` writes an empty managed
  workspace set; it does not delete the file or disable built-in/global modes.
- Definitions are snapshotted before startup awaits. The SDK writes native
  JSON-compatible YAML with a versioned marker/digest and private file permissions.
- Existing unmanaged files, any edited managed bytes (including formatting),
  symlinks, and hard links are refused. There is no implicit adoption or merge.
- The application must exclusively own configuration writes and end the previous
  worker lifetime before replacing definitions. The marker is not a security
  boundary against tools running with the same filesystem authority.
- Files persist after close, disconnect, or later startup failure. Multiple
  managed files are not one transaction; a failed startup can leave a successfully
  written managed file. The SDK never deletes caller files or rolls back Bob state.
- No hot-reload promise, watcher acknowledgement, or additional ACP protocol.

## Isolated worker connection

`start()` remains a local-process API. Applications that isolate execution in a
separate container can instead retain the official ACP client in their trusted
process and use a private Unix socket:

```ts
const client = await Bob.connect({
  socketPath: "/run/bob/client.sock",
  workspace: "/data/workspace", // path in the worker, not inspected locally
  credential: { kind: "apiKey", apiKey: runtimeKey },
});
try {
  const session = await client.newSession();
  // Same native session, prompt, cancellation, permission and subscription APIs.
} finally {
  await client.disconnect();
}
```

The worker entrypoint calls `await Bob.serveOnce({ socketPath, workspace,
environment, autoApprove: false, disableMcp: true, disableSubagents: true, signal })`
and **must exit afterward**, on both success and failure. The deployment must
terminate every process in that worker container before restarting it. The SDK
does not launch containers or request a Docker socket.

The listener takes one connection per lifetime, including credential bootstrap
and cleanup. Others are rejected as busy. Its workspace and execution flags are
configured by the worker, not selected by bootstrap. The private bootstrap has a
16 KiB bound and five-second deadline; ACP bytes thereafter are unchanged. The
socket parent directory must belong to the worker UID with no group/other access.
The SDK never unlinks an existing socket to take over another listener. Deployment
owns stale IPC cleanup, only after the previous worker container has stopped.

**`disconnect()` is not cleanup confirmation.** Unlike the local client's
`close()`, it only closes the trusted client's connection. EOF cannot prove remote
descendants stopped. `serveOnce()` attempts owned-process cleanup before returning;
whole-container teardown provides the stronger lifetime boundary. Native stderr
and exit details are not forwarded over ACP; disconnection produces a connection
error rather than a fabricated native exit event. There is no transparent retry
or replay, and no guarantee that the next worker is immediately ready.

**Healthy status alone does not prove replacement.** After disconnect, the retiring
worker can still report healthy while cleanup and shutdown are in progress. The
deployment must observe the end of that execution lifetime, then wait for its
replacement to become ready before reconnecting. A container restart can retain
the same container ID; track the execution lifetime, not just the container ID
or socket's existence. These checks belong to the deployment, not ACP.

UDS permissions do not isolate the listener from same-UID Bob tools. Treat the
whole worker as untrusted. Give it no application database/login/encryption secrets,
application-control tokens, or sensitive host mounts. Share only the intended IPC
directory and execution data. The runtime Bob credential remains visible to Bob/tools.
Do not supply privileged host callbacks unless that delegation is intentional.

## Native SSO

Select SSO deliberately; startup never initiates interactive login:

```ts
const client = await Bob.start({
  workspace: "/absolute/project",
  credential: { kind: "sso" },
  environment: { HOME: "/application-owned/private-user-home" },
  autoApprove: false,
});
try {
  // Call only when sign-in is needed, using a Bob-advertised method ID.
  await client.authenticate({ methodId: "sso" }, { signal: abortController.signal });
  const session = await client.newSession();
} finally {
  await client.close();
}
```

SSO bypasses SDK credential configuration and removes both `BOB_API_KEY` and
`BOBSHELL_API_KEY` from Bob's child environment, including inherited keys and
per-client overrides. It does not mutate the caller's environment. Bob owns
authentication, token exchange, persistence, and refresh. Native session creation
returns ACP `auth_required` (numeric code `-32000`) when sign-in is needed; callers
may offer sign-in and explicitly retry. Use native methods to detect that error:
`run()` retains its existing mapping of native failures to `protocol_failed`.
There is no automatic retry, login-on-start, logout, token export, or auth-status API.

`authenticate(params, options?)` forwards the official ACP request and response,
including native errors. Unknown method IDs are rejected by Bob. Only one login
may be pending, and login/prompt overlap rejects with `busy`. Other native requests
are not queued behind login; await authentication before creating a session.
The optional `timeoutMs` is a positive integer up to 24 hours, default **16 minutes**,
separate from the ordinary 30-second request deadline. Bob's own callback wait is
15 minutes and may end the operation earlier.

**An in-flight authentication abort or timeout closes the entire client.** ACP has
no login-cancel operation. Local interruption waits for owned-process teardown
before rejecting with `cancelled` or `timeout`; `cleanupFailed` records failed
cleanup. Remote interruption disconnects only: the deployment must await worker
completion and tear down its container. Create a new client afterward. An already
aborted signal rejects before sending authentication and leaves the client usable.
`close()`/`disconnect()` also settle pending authentication. None of these is logout
or permission to remove saved tokens.

`connect({ credential: { kind: "sso" }, ... })` uses private bootstrap **v2**;
both endpoints must support it. API-key connections continue using v1, including
compatibility with older key-only peers. There is no downgrade from SSO to a key.
The worker's configured `environment.HOME` supplies state; the client cannot send
worker paths or environment overrides through bootstrap.

**State is worker-readable, not a credential vault.** Bob stores JSON tokens at
`~/.bob/settings/auth-secrets.json`. A synthetic macOS probe observed mode `0644`
under umask `022`; Bob does not force a private file mode. Provision a private
per-user HOME/state directory (`0700`) and restrictive worker umask (`077`), retain
it deliberately across worker replacement, and never share it across users or
with a developer's real HOME. Refresh-token isolation outside the worker needs a
separate supported design. The SDK does not rewrite Bob-owned files or set a
process-global umask.

**Remote interactive web login is not supported by this foundation.** Bob opens
the browser on its execution machine and listens on an ephemeral `127.0.0.1`
port at `/bob-callback`. No structured login-URL/completion interface was found
in Bob's ACP path. The SDK does not scrape logs or expose raw stderr. Same-machine
login and retained-state workers must not be advertised as browser-to-remote-worker
login. Linux interactive login and a real IBM SSO sign-in remain unverified.

`npm run smoke:package` exercises real installed Bob using synthetic credentials
and loopback login/token services. On macOS it verifies login, callback failures,
state reuse/refresh, user isolation, socket-worker replacement, and interruption
cleanup without opening a real browser. Other platforms currently check keyless
selection only; real account login requires separate approval.

## Native API

`initializeResult` is Bob's unmodified ACP initialization response, including
agent identity, authentication methods, and negotiated capabilities.

```ts
const initialized = client.initializeResult;

const created = await client.newSession({ mcpServers: [] });
await client.setMode(created.sessionId, "agent");
await client.setConfigOption({
  sessionId: created.sessionId,
  configId: "model",
  value: "default",
});

const result = await client.prompt(created.sessionId, [
  { type: "text", text: "Describe this image." },
  { type: "image", data: imageBase64, mimeType: "image/png" },
]);

await client.cancel(created.sessionId);
await client.closeSession(created.sessionId);
```

The client exposes:

```text
initializeResult
authenticate
newSession
listSessions
loadSession
resumeSession
deleteSession
closeSession
setMode
setConfigOption
prompt
cancel
respondToPermission
subscribe
run
close
```

`listSessions`, `loadSession`, `resumeSession`, `closeSession`, and
`deleteSession` use Bob's native session IDs and methods. Capabilities remain
authoritative; unsupported methods reject with the official ACP request error.
Live macOS ARM64 acceptance verifies list, close/load, restart/resume with retained
conversation context, and delete. Restart/resume requires the application to retain
and reuse Bob's HOME/XDG state and workspace; the SDK adds no persistence database.

Only one prompt may be active per client, including across different sessions.
Overlapping calls reject with `BobError` code `busy`. Cancelling sends
native ACP cancellation; the client remains busy until the prompt settles.
Use separate clients for parallel prompts.

## Updates And Permissions

```ts
const unsubscribe = client.subscribe((event) => {
  if (event.type === "session_update") {
    renderNativeUpdate(event.notification);
  }
  if (event.type === "permission_request") {
    const allowed = event.request.options.find((option) => option.kind === "allow_once");
    client.respondToPermission(event.permissionId, allowed?.optionId ?? null);
  }
});
```

`session_update` contains the complete native `SessionNotification`, including
message chunks, plans, tool calls and updates, diffs, commands, titles, modes,
configuration, and usage fields supplied by Bob. The SDK does not synthesize
ACP updates.

When automatic approval is disabled, permission requests remain pending until
`respondToPermission` selects one of the request's native option IDs or passes
`null` to cancel. Session cancellation and client shutdown cancel pending
permission requests. With the default automatic approval, Bob child processes
may inherit or disclose `BOB_API_KEY`; the SDK does not isolate the credential.

## Application Host Callbacks

Optional `host` callbacks in `Bob.start()` let an application supply
ACP v1 `readTextFile` and `writeTextFile` operations. Terminal support requires
all five callbacks: `createTerminal`, `terminalOutput`, `waitForTerminalExit`,
`killTerminal`, and `releaseTerminal`. Their arguments and return values use
the official ACP types, exported through the `BobHost` type.

Only supplied capabilities are advertised during initialization. Omitting
`host` retains the default: no client filesystem or terminal capabilities.
These handlers are available if Bob delegates the operation; they do not
intercept Bob's own filesystem or shell tools.

Callbacks run in the application. The application
must enforce its own path/access policy and manage callback-owned resources,
including terminating its terminals on cancellation and shutdown. SDK process
cleanup does not own application-created terminals. Do not enable these
callbacks for untrusted callers without appropriate controls.

Callback forwarding is tested with an official-ACP test agent, not evidence
that Bob delegates every tool. Bob 2.0.5's shipped `ACP.md` explicitly says its
commands use its own shell, not ACP client terminals. Filesystem delegation is
not live-characterized. These callbacks are not a sandbox or an interception
layer for Bob's native tools.

## Batch Convenience

`run()` creates a session, optionally selects a mode, submits one prompt, joins
native text chunks, and closes the session:

```ts
const result = await client.run({
  mode: "agent",
  prompt: [{ type: "text", text: "Summarize the project." }],
  signal: abortController.signal,
  onEvent: (event) => observe(event),
});
```

It returns `{ text, stopReason, response }`, where `response` is Bob's native
`PromptResponse`. `promptTimeoutMs` and `maxTextBytes` apply only to `run()`;
exceeding either limit sends native cancellation and rejects without changing
the ACP response schema.
Output exhaustion settles with `output_limit` even if cancellation does not
complete. Native session cleanup is still attempted with the bounded request timeout;
its failure is indicated by `cleanupFailed` without replacing the primary code.

## Errors

SDK-owned failures use `BobError` with a stable `code`:

```text
startup_failed
configuration_invalid
cancelled
timeout
output_limit
protocol_failed
child_exited
cleanup_failed
busy
closed
```

Native ACP request methods may reject with `RequestError` from the official SDK.
The `run()` convenience method maps native request failures to `protocol_failed`;
an invalid-request response does not establish that a mode is unavailable.
SDK-created errors omit API keys, prompts, workspace paths, Bob output, and child
stderr; native ACP errors remain native responses. `cleanupFailed` is true when a primary `run()` failure was followed by a
session cleanup failure.
Expired/unknown permission requests and unavailable permission options are
`configuration_invalid`; locally enforced lifecycle-request deadlines are `timeout`.

The shipped SDK and HTTP bundles apply a hash-verified diagnostic-only patch to
the pinned official ACP dependency because its current error logger includes raw
malformed notifications. The patch emits fixed diagnostics without payloads; it
does not alter ACP responses or application console behavior. Direct imports of
the unbundled dependency do not acquire the SDK's logging guarantees.

## Lifecycle

One `Bob` owns one private Bob process and its ACP connection.
Call `close()` in `finally`. Closing attempts native cancellation without waiting
on blocked transport writes, cancels pending
permissions, terminates the owned process group and discoverable descendants
with bounded escalation. It never deletes caller-owned workspaces, configuration,
state directories, or outputs. Repeated `close()` calls share one promise.

Teardown inspects OS process identities, never command lines or environments.
It handles detached children while their ancestry is observable, and surviving
group members after the leader exits. It cannot guarantee recovery of a detached
process already orphaned before cleanup starts, or cleanup after the consumer
itself is SIGKILLed. This is not an OS containment boundary.

If process cleanup cannot be verified, `close()` rejects with `cleanup_failed`.
The caller should retain its working files until containment/cleanup is confirmed.
Known process-group termination is still attempted if process discovery fails.

Keep the installed package, runtime assets, and native helper dependencies
together. The SDK bundle includes the ACP client; Bob and native binaries remain
installed assets rather than JavaScript bundle contents.

## Separate Server Example

`examples/interactive-server.mjs` imports only the public `Bob` SDK. It
demonstrates authenticated loopback HTTP, one client per native session, live SSE,
follow-ups, permissions, cancellation, and bounded concurrency. This is an
acceptance consumer, not server logic inside the SDK or a production service.
Stream disconnect cancels an active turn; there is no history or reconnect replay.
All example clients use the supplied workspace and environment. It does not
provision per-session workspaces or tenant isolation. Accepted edits affect that
workspace directly; run against an application-provisioned copy when appropriate.

With `BOB_API_KEY` and `BOB_GATEWAY_SERVER_TOKEN` already set:

```sh
BOB_GATEWAY_WORKSPACE=/absolute/project node examples/interactive-server.mjs
```

It prints only its loopback address. Routes are `POST /sessions`,
`GET /sessions/:id/events`, `POST /sessions/:id/prompt` (`{ "prompt": "..." }`),
`POST /sessions/:id/permissions/:permissionId` (`{ "optionId": "..." }`),
`POST /sessions/:id/cancel`, and `DELETE /sessions/:id`. All require the exact
bearer token. Connect the event stream before prompting. Interactive permissions
are enabled by default in this example.

`npm run smoke:server:live` exercises this server with real Bob, including parallel
clients and a real permission request/reply. It requires `BOB_API_KEY`.
`npm run smoke:runtime:modes:live` verifies caller-provided `.bob` modes and rules.

## Managed MCP availability and native approval

`managedMcpServers` on `Bob.start()` and `Bob.serveOnce()` opts in
to SDK ownership of the complete **workspace `.bob/mcp.json` file**. It is
not supported on `connect()` or session options. `disabledTools` controls native
availability; `alwaysAllow` selectively bypasses native ACP permission requests.
The latter requires the shipped [Bob ACP correction](BOB-ACP-CORRECTION.md).

```ts
await Bob.serveOnce({
  workspace, socketPath, signal,
  autoApprove: false,
  managedMcpServers: [{
    name: "example",
    type: "http",
    url: "https://example.com/mcp",
    headers: [{ name: "Authorization", value: "Bearer ${env:MCP_TOKEN}" }],
    disabledTools: ["delete_record"],
    alwaysAllow: ["read_record"],
  }],
});
```

The exported `BobManagedMcpServer` reuses the ACP stdio definition
(`name`, absolute `command`, `args`, `env` name/value pairs) or Streamable HTTP
definition (`name`, `type: "http"`, `url`, `headers` name/value pairs), plus an
optional `disabledTools` and `alwaysAllow` lists. Each contains exact **server-native tool
names**, not Bob's generated invocation IDs or display labels. Omitted means no
tools disabled or explicitly auto-approved on that server. Unknown tool names are not discovered/validated
by the SDK; a typo is not a restriction. No server/tool discovery API is added.
Legacy SSE, ACP-transport servers, extra native settings, duplicate server names,
duplicate tool names, and `disableMcp: true` with managed configuration are rejected.

For managed servers, do **not** also supply same-name definitions through
`newSession`/`loadSession`/`resumeSession({ mcpServers })`. The native workspace
entry replaces lower-precedence definitions in full, not field by field. Bob
may still load other servers from global, plugin, or ACP configuration. This
feature is not an exclusive server allowlist or a sandbox.
Keep one definition/owner per managed server name across native configuration
as well: a deeper same-name workspace/plugin entry can override the root file.
The SDK does not inventory or rewrite plugin configuration.

### File ownership and startup contract

- Omit the option for no SDK file writes. Existing native configuration still
  applies, including managed files from earlier starts.
- Supply `[]` to replace the managed file with an empty server set. This removes
  its definitions, **not** all native MCP servers; lower-precedence definitions
  can become visible again. To re-enable a tool, keep the complete server definition
  and remove its name from `disabledTools`.
- The SDK creates `.bob` if needed, but never replaces the directory or other
  files. Existing `.bob/mcp.json` must have a valid SDK ownership marker and
  matching content digest. Unmanaged, malformed, or externally edited definitions
  fail with `configuration_invalid`. There is no automatic takeover or merging.
- Files are atomically installed with mode `0600`; symlink/special/hard-linked
  files and a symlinked `.bob` directory are rejected. Generated temporary files
  are removed; the managed file persists after close, disconnect, or startup
  failure. The SDK does not roll back configuration or delete caller storage.
- Inline header/environment secrets are written to that private file. Prefer
  Bob-supported environment references as above. The SDK does not resolve them,
  log configuration content, or change permissions on an existing `.bob` directory.
- The application **must exclusively own workspace configuration** and finish
  tearing down every old Bob worker using it before invoking managed startup.
  These checks are not a filesystem sandbox against hostile concurrent mutation.
  Do not share this configuration workspace between active workers/users.

Configuration is copied/validated at invocation and written before Bob starts.
`serveOnce()` writes it after successfully binding its socket; a competing call
on an occupied socket does not overwrite the running worker's file. Startup
success is not a promise that an MCP server has connected or that every supplied
tool name exists—Bob discovers native servers during session initialization.

There is **no live setter**. To change availability, Camenae should authorize/save
the desired settings, wait for the current turn to finish (or explicitly cancel
it), tear down the old worker, and pass the complete new configuration to its
replacement. Then reconnect and resume the native session. Remote disconnect
alone is not proof of worker teardown. Disabling a tool does not revoke a call
already awaiting permission. Bob's file hot reload is not an SDK acknowledgement
mechanism and must not be used as an application completion signal.
Restoring availability does not erase the model's prior conversation assumptions
or force it to call a tool. Native offered-tool evidence and actual execution are
separate checks; the SDK never changes prompts or generated responses to hide that.

The same replacement lifecycle applies to native `alwaysAllow` changes. Native
Always-memory decisions retain precedence; disabled tools are never re-enabled.
With `autoApprove: false`, listed tools skip ACP requests, so category policy and
`permission_auto_decision` cannot intercept/report them. Unlisted tools retain
normal handling. Use `alwaysAllow` on gate URLs to delegate Ask/Allow/Deny to the
gate, not to grant unconditional upstream access. See `MCP.md`. There is no new
ACP field, per-session configuration API, or live watcher acknowledgement.

## Reusable approval preferences

`start({ approvalPolicy, autoApprove: false, ... })` and
`connect({ approvalPolicy, ... })` install a **client-wide** policy in the trusted
application. `client.setApprovalPolicy(policy)` synchronously validates, copies,
and replaces it; `undefined` restores manual handling. No preferences are stored
by the SDK or sent in worker bootstrap. `serveOnce` must use `autoApprove: false`.
For direct startup, an initial policy requires explicit `autoApprove: false`;
set that flag at startup even if installing the policy later. The client cannot
discover or change a remote worker's global auto-approval flag.

```ts
import { Bob, type BobApprovalPolicy } from "@camenae/bob";

// Camenae authenticates the user and loads/validates the intended preference scope.
const saved: BobApprovalPolicy = {
  kinds: { edit: "allow", execute: "ask", delete: "deny" },
  fallback: "ask",
};
const client = await Bob.connect({
  socketPath, workspace, credential: { kind: "apiKey", apiKey },
  approvalPolicy: saved,
});
client.subscribe((event) => {
  if (event.type === "permission_request") {
    // Forward this unchanged to the manual UI. After authorized user input:
    // client.respondToPermission(event.permissionId, selectedOptionId);
  }
});
// After Camenae authorizes and persists a settings update:
client.setApprovalPolicy({ ...saved, kinds: { ...saved.kinds, edit: "deny" } });
```

Supported `kinds` keys are `edit`, `delete`, `execute`, `search`, `fetch`; values
are `allow`, `deny`, `ask`. These match **Bob's reported ACP category**, not an
individual tool, MCP server, shell command, path, or trustworthy risk class.
Bob can label multiple unrelated tools with the same category. `execute: allow`
therefore covers every permission request Bob labels `execute`, not just its
built-in command tool. Use `ask` if that breadth is inappropriate.

Precedence is exact category first (including explicit `ask`), then `fallback`
(`ask` by default, or `deny`). Missing/unknown/`other`/`read` categories cannot
inherit an allow. Invalid keys, decisions, shapes, or an allow fallback throw
`BobError("configuration_invalid")`, leaving the old policy unchanged.
Caller mutation after installation does not change the policy.

Automatic responses select the unique native `allow_once`/`reject_once` option
by **kind**, never by label or a presumed option ID. Missing or ambiguous options
defer to the existing manual interface. Automatically settled requests do not
emit `permission_request`; instead they emit `permission_auto_decision` as
described below. Normal native tool/session updates remain unchanged.
No configured policy preserves the existing manual permission interface.

Updates take effect for requests received after the setter returns, including
later requests in the same prompt. Pending manual requests stay manual. Multiple
requests are independently settled by the existing exactly-once permission owner;
cancellation settles outstanding requests as cancelled and stale responses fail.
One prompt is admitted per connection as before. All loaded sessions on a client
share its policy; different clients do not. Applications must serialize conversation
switches and install the intended policy before prompting. Reapply preferences
on every replacement connection; the SDK has no identity/scope/persistence store.

**Native limits:** Bob 2.0.5 permits reads and built-in skills without asking;
global `autoApprove`, remembered native “Always” choices, and configured MCP
`alwaysAllow` (with this package's correction) also bypass requests.
The SDK cannot deny, audit, or retroactively change those operations. The manual
API retains native Always choices for compatibility. For reusable preferences,
use one-time choices in the manual UI as well. If Always was previously used,
finish/cancel the active turn, close and resume/load the native session before
relying on changed preferences. Bob recreates its permission map on native load;
updating SDK policy alone does not clear it. Do not treat this API as a sandbox.

Per-tool rules in `approvalPolicy` are deliberately unsupported: packaged Bob 2.0.5 sends no stable
tool identity in its permission request. Titles, command strings, invocation IDs,
and raw input are not parsed. Upstream must supply a documented, stable,
namespaced tool identity (including MCP server/tool identity) before safe per-tool
rules can be offered. `setConfigOption` is unrelated and remains unsupported by
this Bob version (`-32601`).

For exact **MCP** server/tool Allow / Ask / Deny independent of Bob's ACP request
identity, use the opt-in trusted-side `@camenae/bob/mcp` gate described in
[`MCP.md`](MCP.md). It keeps enabled tools discoverable and authorizes actual MCP
calls. It does not apply to built-in tools or automatically reroute existing MCP
definitions. Application routing and no-bypass isolation are explicit prerequisites.

### Automatic-decision attribution

`subscribe` (and `run({ onEvent })`) exposes a frozen, flat
`BobPermissionAutoDecisionEvent` for each successfully settled automatic
response:

```ts
type BobPermissionAutoDecisionEvent = Readonly<{
  type: "permission_auto_decision";
  permissionId: string;
  sessionId: string;
  toolCallId: string;
} & (
  | { match: "category"; kind: BobApprovalKind; decision: "allow" | "deny" }
  | { match: "fallback"; kind: string | null; decision: "deny" }
)>;
```

- Attribution is captured once during evaluation, not reconstructed from current
  preferences. An explicit category takes precedence over fallback. `kind` is the
  **decoded ACP category**; missing/null becomes `null`. The pinned ACP decoder
  normalizes unrecognized category strings to undefined, so raw unknown wire
  values are not preserved.
- Emission is synchronous after successful **local settlement**: the pending
  ledger entry has been removed and the ACP response promise fulfilled. It is
  not confirmation of a transport write, Bob receipt, tool execution, success,
  or prompt completion. Subsequent cancellation/disconnection does not rewrite
  the record. The event is frozen at runtime so an earlier subscriber cannot
  change the attribution seen by later subscribers.
- Manual/Ask handling, missing or ambiguous options, stale/failed settlement,
  already-cancelled requests, and Bob operations bypassing permission requests
  produce no automatic-decision event. Pending manual requests remain manual
  after a policy change. There is no reason field explaining manual deferral.
- Dispatch is at most once per request per live client, without replay or durable
  delivery. Subscribe before prompting. Consumers own persistence. Update strict
  event validators and exhaustive switches for the new union member.
- Keep **one decision record per permission request**, not per tool-call ID.
  Use application connection generation plus `permissionId` when storing across
  client lifetimes. A unique turn ID plus `permissionId` suffices if that turn
  uses only one client and never reconnects/replays. Native `sessionId` and
  `toolCallId` correlate activity but do not guarantee unique invocation identity.
- Session-filter events and upsert by correlation; do not attach to the latest
  tool row. There is no adjacency/global ordering guarantee with native tool
  updates. Retain attribution even without a tool update, without fabricating
  pending/failed/completed tool state. Label it separately from Bob's text and
  tool status, for example “Automatically denied: Execute → Deny” or
  “Automatically denied by fallback policy”.
- **Sensitive data:** `toolCallId` can contain serialized tool arguments. Treat
  correlation IDs as opaque private UI data; never log the complete event or
  parse IDs as tool identities. Events contain no titles, raw input/results, or
  full policy snapshots, but that does not make them safe telemetry.

This is a trusted-client SDK event for both `start` and `connect`, not an ACP
extension or worker event.
Bob 2.0.5 still uses its own fixed rejection text; the SDK does not inject a
reason, rewrite Bob output, or fabricate a tool result. Bob-aware explanations
require a separately supported upstream contract.

# Camenae SDK repository guidance

## Scope and ownership

Camenae SDK contains independently consumable agent-harness integrations in a
private Bun workspace. Bob is the established integration: `packages/bob/`,
exports `@camenae/bob` and `@camenae/bob/mcp`, entry point `Bob` and `Bob*` types.
Package manifests own product versions; the root owns shared commands and
`bun.lock`. Bob also retains `package-lock.json` for npm archive tooling.

`packages/opencode/` is an experimental OpenCode 2.0.23 integration with an
official native HTTP worker. Its README owns its boundaries. Keep its Effect
runtime isolated from consumers using other RCs. Node 22 remains supported for
Bob; OpenCode's native worker requires Bun 1.4.2 or Node 24.

Do not create empty integrations, speculative shared cores, or a mandatory common
API. Extract common contracts only from demonstrated needs across implemented
harnesses. See `docs/design.md`, `CONTRIBUTING.md`, and `docs/releasing.md`.
Current Bob contracts live in its `SDK.md`, `MCP.md`, and `COMPATIBILITY.md`.

Preserve unrelated uncommitted work. Never commit or push. Do not change sibling
repositories, consumer dependencies, running deployments, or external services
without specific authorization. Handoffs convey context, not authorization.
Do not introduce a Docker launcher, application HTTP gateway, provisioning or
artifact service as part of this SDK.

## Bob runtime and security

- Native startup uses official ACP and exact package-private Bob 2.0.5 through
  the caller's Bun/Node executable. No host Bob lookup or `BOB_PATH`.
- `runtime/compatibility.json` owns archive/helper identities and digest checks.
  Prepare an approved archive with `bun run runtime:prepare <archive>` before
  building. Never hand-edit generated Bob.
- Preserve `acp-mcp-always-allow-v1`, independent `acp-session-usage-v1`, their
  chained digests and separate removal gates, plus the MCP transport-cleanup and
  ACP diagnostic corrections. Consult the shipped correction guides before upgrades.
- The SDK is not a sandbox. Consumers own workspace, HOME/XDG/tmp, containment,
  egress, credentials, retention and privacy. Do not copy projects, provision
  artifacts, replace `.bob`, or delete caller-owned files.
- Opt-in managed configuration owns only `.bob/mcp.json` and/or
  `.bob/custom_modes.yaml`. Refuse unmanaged, edited or linked files; require
  exclusive ownership and previous-worker teardown. Files persist on close.
  Do not add watcher acknowledgements or an ACP control protocol.
- Exact-tool `alwaysAllow` bypasses native ACP category policy. Use gate URLs for
  delegation and keep global auto-approval off when relying on permission policy.
- `connect()`/`serveOnce()` are private one-connection Unix-socket transport.
  Forward ACP unchanged after bootstrap. Disconnect does not confirm remote
  cleanup. Worker entrypoints must exit after `serveOnce` settles; deployments
  must retire the whole execution lifetime before reuse.
- Explicit SSO strips both Bob key aliases without fallback. Authentication
  timeout/abort closes the client (default 16 minutes); remote cleanup is still
  unconfirmed. Bob owns tokens; consumers own HOME/umask. Key bootstrap is v1,
  SSO v2; remote browser login is not implemented.
- Bob owns native sessions, configuration, protocol and accounting. Do not add
  handwritten ACP framing, session mapping, a persistence database, or `bob run`.
  `update._meta["bob-gateway/usage"]` is a narrow existing versioned exception.
- Preserve persisted configuration markers, credential paths, environment
  variables and bootstrap versions. Existing private user-config credential
  checks remain supported. Renaming these requires a compatibility decision.
- Keep keys, prompts, tool data, Bob output, malformed payloads and workspace
  paths out of diagnostic logs. Cancellation stays native ACP; local process
  cleanup uses owned process trees/groups with bounded escalation.

## Verification

Use Bun for repository scripts and `bun install --frozen-lockfile` (tested Bun
1.4.2). Node requires ≥22.15.0. Run `bun run lint` after each change batch and
before completion; report blocked or failed checks explicitly.

```sh
bun run lint
bun run typecheck
bun run test
bun run test:node
bun run build
bun run smoke:package
bun run smoke:package:node
```

Choose focused checks for bounded changes. Distribution changes require actual
archive installation and native Bob initialization under both runtimes, not a
fake launcher. Tests are outside tsconfig; lint and both runners cover them.
Bundling must reject non-Node external runtime imports. Preserve the vendored
lint configuration, rules and third-party notices; do not silently weaken rules.

Paid smokes require explicit authorization and a supplied `BOB_API_KEY`:
`smoke:package:live`, `smoke:server:live`, `smoke:runtime:modes:live` in Bob's
package directory. Build first. No inference is needed for ordinary acceptance.

## Delivery and documentation

Release tooling creates local archives; it never commits, tags or publishes.
Retain a uniquely identified delivery archive and SHA-256 with source identity,
checks and limitations. Never overwrite an accepted artifact or equate two builds
solely by package version. Generated output, dependencies, private Bob, archives,
credentials, logs, coverage and temporary state are not source.

Record actionable Bob findings in `packages/bob/COMPATIBILITY.md` or the owning
guide, not chronological migration journals. Preserve security limits, correction
removal gates and evidence when consolidating documentation. Linux x64 proof does
not establish all platforms or tools: Windows, interactive Linux SSO, remote web
login, durability, hosted exposure and Office characterization remain limited or
unproven. Keep consumer-specific deployment and Compass work outside SDK claims.

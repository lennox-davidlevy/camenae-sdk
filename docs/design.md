# Design

Camenae SDK makes agent harnesses usable from applications without replacing the
harnesses themselves. An integration owns connection and lifecycle details while
keeping native behavior and harness-specific capabilities available.

## Independent packages

Each implemented integration lives in `packages/<harness>/` and can be consumed
without installing every other integration. The root is a private development
workspace, not a runtime dependency.

Bob is the first integration. There is no generic `HarnessClient`, mandatory
common protocol, or shared runtime package. Common contracts should follow
demonstrated needs across working integrations, not precede them.

## Native behavior, explicit ownership

- Prefer official SDKs and protocols. Do not emulate sessions or reconstruct
  accounting when the harness already owns them.
- Expose capability differences rather than promise unsupported equivalence.
- Keep process ownership, cancellation, permissions and cleanup semantics explicit.
- Keep application policy separate: workspaces, credentials, persistence,
  containment, egress and deployment recovery belong to the consumer.
- Authorization does not prove execution, and disconnect does not prove remote
  cleanup. An integration is not a sandbox or an exactly-once execution service.

Bob's [API guide](../packages/bob/SDK.md),
[MCP guide](../packages/bob/MCP.md), and
[compatibility notes](../packages/bob/COMPATIBILITY.md) define its actual contracts.
Its private worker transport is one integration-specific capability, not a
required transport for future harnesses.

## Adding an integration

Evaluate a pinned upstream version and its official embedded/network interfaces.
Build one end-to-end path covering startup or connection, a conversation,
streaming, available approval controls, cancellation and bounded cleanup. Verify
it from an installed package with a consumer example.

Document resume, configuration, usage and isolation semantics before promising
them. Compare concrete implementations before extracting shared code. Candidates
are not supported products until they have this proof; this repository does not
reserve empty packages for a roadmap.

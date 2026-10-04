# Temporary Bob 2.0.5 ACP MCP approval correction

## Why this exists

Bob documents native `mcp.json` `alwaysAllow` as a list of tool names that do not
prompt. Bob Shell 2.0.1 added interactive support; ACP was introduced in 2.0.2.
Unmodified 2.0.5's interactive approval handler consumes the list, but its
separate ACP handler does not. A real packaged-Bob, credential-free loopback-model
reproduction supplied `alwaysAllow` directly in `.bob/mcp.json`: Bob still sent
an ACP permission request. Rejecting it prevented the independent MCP receipt;
answering Allow once produced the receipt. This was not a discovery failure.

Sources: [MCP configuration](https://bob.ibm.com/docs/shell/configuration/mcp/mcp-bobshell),
[Shell changelog](https://bob.ibm.com/docs/shell/changelog), and the exact packaged
`runtime/bob/ACP.md` plus `dist/bob.js` implementation. No upstream issue or fix
acceptance is claimed; external publication requires separate authorization.

## The correction and its ownership

`scripts/bob-acp-always-allow.mjs` is a deliberately version-specific preparation
step, not a runtime hook or an extensible patch engine. `runtime:prepare`:

1. Verifies the official archive digest, Bob version, release commit, and original
   entrypoint digest in `runtime/compatibility.json`.
2. Applies exactly two unique replacements in the temporary staging directory.
3. Verifies the independently pinned permission-corrected entrypoint digest.
   The separate [usage correction](BOB-USAGE-CORRECTION.md) then runs and verifies
   its own output. Build/pack and SDK startup require the final chained digest.

The original archive is never changed. The shipped `runtime/bob/dist/bob.js` **is
modified**, reproducibly. It is not byte-identical to the upstream release even
though Bob's native version response remains `2.0.5`. The manifest identifies
`acp-mcp-always-allow-v1`; consumers must distinguish same-version SDK builds
by archive path/digest. No installed dependency files are hand-edited.

| Identity | SHA-256 |
| --- | --- |
| Official Bob archive | `eff232eb1b69f34f984ddd295e6960470058ca922b1c751879c5a8d06199f566` |
| Original Bob entrypoint | `15c328ca5f6b9360d3c7a72e6bd46ae0ce9082eda20f57edc5da0348efac1cbe` |
| Permission-corrected intermediate entrypoint | `d443d6e7e0351c45fc2191d63787835c96d15eace7a9bad0a6d795985295da8c` |

At native tool dispatch (`Qso`, original line 3623), Bob has already resolved the
actual tool and performed its mode/validation checks. Only a real native MCP tool
(`Iyt`) can supply its `isAlwaysAllowed()` result. That method checks the exact
tool name against that tool's actual server definition. A private in-process
boolean carries this result to the ACP observer. It is **not** ACP metadata or a
new protocol, and cannot be supplied through MCP arguments or a rendered title.
Computing at dispatch, rather than searching the root task's registry later,
also avoids misidentifying a child task's tool.

The ACP evaluator (`bEt.resolveToolDecision`, original line 6131) honors that
boolean after existing native Always-memory lookup and before asking the client.
Existing remembered rejection retains precedence. Reads, built-in skills, global
auto-approval, unlisted tools, and unrelated native tools keep their existing
paths. Discovery, tool invocation, cancellation, and ACP message shapes are not
rewritten.

## Downstream behavior that applications must understand

- `managedMcpServers[].alwaysAllow` is an exact-name list, not a wildcard or a
  server-wide boolean. The application persists server defaults/tool exceptions
  and supplies the intended catalog on each worker replacement. Unknown newly
  discovered tools do not silently enter the native list.
- For **direct upstream** definitions, listed tools bypass native ACP permission
  requests. This is approval, not an extra Deny policy; leaving a name out means
  the ordinary native permission path. Disabled tools remain unavailable.
- For **gate-controlled** definitions, list the tools whose native approval is
  delegated to the trusted gate, including gate Ask and Deny tools. Bob receives
  only the gate URL/token. The gate then remains the authorization owner: Allow
  has no question, Ask has one question, and Deny prevents upstream forwarding.
- Set `autoApprove: false`. Do not enable global approval to compensate for an
  incomplete native list. Category preferences do **not** intercept a native
  `alwaysAllow` call. Existing `permission_auto_decision` events consequently do
  not describe those calls. Gate `onAutoDecision` reports its own decisions only.
- Persist native configuration before new sessions start. Supported changes use
  old-worker teardown and replacement, not a file-watcher acknowledgement. Native
  hot reload is not an immediate revocation guarantee. Remembered native Always
  choices can still bypass later policy changes; use one-time choices in the UI.
- Gate policy changes affect future calls. Pending Ask decisions keep their
  original path. Close the old gate to abort pending approvals; no policy change
  can undo an already forwarded side effect.
- Keep one trusted definition per server name. Global/workspace/plugin precedence
  and deeper definitions are still Bob-owned; deployments must prevent hostile
  definition edits, direct upstream access, and alternate launches.
- A Git MCP tool with both safe and destructive argument variants cannot safely
  be allowlisted wholesale for direct use. Use Ask or a reviewed argument-aware
  gate callback. Native shell Git commands are outside the MCP gate.
- This supplies no user database, OAuth UI, durable history, ACP-to-MCP call
  correlation, sandbox, or Git-specific risk classification.

## Validation and removal procedure

The primary behavior regression is `tests/smoke/fixtures/mcp-approval-consumer.mjs`.
It runs actual packaged Bob and real MCP fixtures through direct SDK and Unix
socket paths. A loopback model selects deterministic tool calls; it does not
fake approvals or MCP execution receipts. The regression failed on unmodified
Bob at `alwaysAllow still prompted through ACP`. `smoke:package` runs the same
owner against an installed npm archive. `smoke:mcp:approval:live -- <archive>`
uses authorized real inference with the same side-effect and approval checks.

Coverage includes native delegation, gate Allow/Ask/Deny, fresh replacement
sessions, same-name tools on different servers, native category denial, and
deterministic unavailable/unknown calls. Gate protocol tests separately own Ask
cancellation/timeout/close races and automatic-decision reporting. The correction
guard rejects changed input/pins and double application. Child-task binding is
source-level evidence; child-task live acceptance is not claimed.

For an upstream update:

1. Obtain/review the candidate Bob release. **Do not** change this patch's pins to
   make it apply to new code. Prepare the candidate **without** this correction,
   preserving the standard official archive/metadata/entrypoint checks.
2. Run the same native/installed-package behavior regression and authorized live
   acceptance. Confirm listed tools skip ACP permission, unlisted/same-name tools
   still ask, Disabled wins, unrelated permissions remain, and fresh sessions work.
3. Once the unmodified release passes, update the compatibility manifest to that
   release, remove `bob.correction`, the correction script/import/invocation, and
    its patch-specific guard test. Runtime/build checks must still require the
    final digest of any remaining correction. Review/re-pin the separate usage
    correction against its new input bytes if it remains necessary. Keep the
    behavior regression and standard native field.
4. Mark this document historical and record the upstream resolution in
   [compatibility notes](COMPATIBILITY.md). Keep application preferences, the SDK
   API and gate reporting intact.

The separate MCP SDK cancellation-cleanup correction is **not** part of this
removal. It remains until its own upstream regression passes unaided.

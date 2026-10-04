# Temporary Bob 2.0.5 session-usage reporting correction

## Scope and ownership

`scripts/bob-acp-usage.mjs` owns **only** `acp-session-usage-v1`. It is separate
from the MCP permission correction and the MCP SDK stream-cleanup correction.
It does not change permissions, accounting, tokenization, model selection,
compaction, limits, or billing.

Bob 2.0.5 maintains native task spending and context occupancy, and resolves
model limits, but its ACP observer does not publish them. Its ACP prompt response
contains only a stop reason. This correction reports those existing values on
existing `session/update` notifications, which the SDK forwards unchanged.

The SDK supports a narrow metadata exception:
`update._meta["bob-gateway/usage"]`, with `version: 1`. This is a Bob/SDK
reporting contract, **not** a claim of upstream ACP support for Bobcoins.
No new ACP method, control protocol, SDK accounting store, polling loop, or
Camenae-specific policy is introduced.

## Preparation and identities

Preparation verifies the official archive and original entrypoint, applies and
verifies the unchanged permission correction, then applies three uniquely matched
usage replacements and verifies the final digest. Build/pack and SDK startup
require the final digest. Generated Bob is never hand-edited.

| Identity | SHA-256 |
| --- | --- |
| Official archive | `eff232eb1b69f34f984ddd295e6960470058ca922b1c751879c5a8d06199f566` |
| Original entrypoint | `15c328ca5f6b9360d3c7a72e6bd46ae0ce9082eda20f57edc5da0348efac1cbe` |
| Permission-corrected input | `d443d6e7e0351c45fc2191d63787835c96d15eace7a9bad0a6d795985295da8c` |
| Permission + usage corrected output | `17eb21f1e836179d0fac0010ac65b488ea33f9ab552f59fa282c2dc819f46a75` |

Bob remains version `2.0.5`, commit `2dc180906`, release commit
`2dc1809063bd2c2b550e66b5c20854f3cf8cb9f4`. Both corrections are recorded separately
in `runtime/compatibility.json`. The official archive is unchanged; the shipped
entrypoint is modified. Same-version SDK archives need distinct checksums.

## Consumer contract

Subscribe before creating/loading/resuming a session. Snapshots are sent on
session initialization, mode/available-command updates, and in the native turn's
`finally` path, including failed/cancelled execution when the connection survives.
Session-initialization notifications are asynchronous relative to the response.
A completed SDK prompt receives its turn snapshot before settlement. This is
**not** token-by-token or mid-turn reporting, replay, exactly-once delivery, or a
guarantee after disconnect/process death. Reporting failures do not replace native
prompt outcomes.

`BobSessionUsage` describes the metadata:

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `contextTokens` | Bob's latest root-task context occupancy; not accumulated input tokens |
| `contextWindow` | Positive model capacity from Bob's model-info resolution; not a hard-coded 250k |
| `maxOutputTokens` | Separate model output-token maximum, not remaining context |
| `compactionThreshold` | Configured fraction (default `0.9`); advisory threshold, not a second capacity |
| `autoCompact` | Whether native automatic compaction is enabled |
| `bobcoins` | Native cumulative root-task cost for the Bob harness provider |

Numeric fields are `null` when unavailable/invalid. If context occupancy and
capacity are known, the notification is standard ACP `usage_update` with `used`
and `size`. Otherwise it is `session_info_update` carrying only this metadata:
we do not fabricate a capacity or lose available spending when limits are unknown.
The standard `cost` field is omitted because it requires an ISO 4217 currency;
Bobcoins are not USD. See [ACP session usage](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/session-usage.mdx).

Replace the last snapshot for each native session ID; **do not sum snapshots**.
Compaction can reduce occupancy. Bob derives occupancy from provider input/output
usage and may estimate it after compaction. It is not a fresh tokenizer count of
every keystroke, pending prompt, or tool description.

The harness extracts provider `usage.raw.credits` and native task accounting
accumulates it. Missing provider charges can remain zero in native accounting;
zero here means **Bob has recorded zero**, not proof that a request was free.
Other providers report `bobcoins: null`. This is not the account's remaining
monthly balance, an invoice, or an independent billing reconciliation.

The source is the **root task**, including whatever child spending Bob has merged
into that task. Do not sum child costs again. Active child/subtask contexts are
not separate usage displays here, and exhaustive child/compaction/paid-provider
accounting acceptance remains outstanding. Reload/resume uses Bob's persisted
task data, not SDK connection-local totals. Consumers own persistence/UI.

Reporting observes the last model-info result obtained by native Bob execution;
it never initiates a lookup or waits for the provider. Limits are unknown on a
fresh/replacement worker until Bob resolves its model. A failed, absent, or
different-model observation yields unknown limits rather than stale capacity.
This is one observation, not a new model cache, retry policy, or background timer.

## Validation and removal gate

`tests/smoke/fixtures/usage-consumer.mjs` is the primary behavioral owner, run by
`smoke:usage` and against an installed archive by `smoke:package`. It uses actual
Bob and synthetic loopback provider replies, not fake ACP usage notifications.
Before the correction it fails with `Bob did not emit session usage metadata`.
It covers direct/socket events, cumulative credits, non-cumulative occupancy,
different capacities, missing capacity, mode refresh, failed turns, independent
sessions, resume across replacement workers, and no reporting-initiated model
requests. A separate preparation guard
rejects changed pins/bytes and double application. No paid inference is required.

To remove this correction:

1. Evaluate a future official Bob **without** this usage correction. Do not update
   its hashes just to force the replacements onto a different build.
2. Verify equivalent context/limit/credit semantics through actual installed Bob,
   direct/socket sessions, failure/resume, and separately authorized live inference.
   If upstream uses another representation, explicitly migrate the documented
   consumer contract; do not silently drop Bobcoins or relabel currency.
3. Remove `bob.usageCorrection`, this script/preparation invocation, and its
   patch-specific guard. Retain behavioral tests and the application usage contract
   as appropriate for the upstream representation. Build/startup must still check
   the final digest of any remaining independent corrections.
4. Record the upstream resolution in [compatibility notes](COMPATIBILITY.md) and
   mark this guide historical.

Permission and transport-cleanup corrections have independent removal gates.
If the permission correction is removed first, review/re-pin the usage correction's
input/output for the new approved bytes; do not disable its digest validation.
No upstream issue, publication, or deployment is performed by this change.

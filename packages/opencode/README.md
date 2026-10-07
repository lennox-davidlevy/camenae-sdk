# OpenCode integration

`@camenae/opencode` pins OpenCode **2.0.23**. It connects through the official
generated client; `@camenae/opencode/worker` starts the official native server.
The worker is separate from the trusted application and its Effect runtime.

Use Bun 1.4.2 for the worker. Node 22 cannot parse upstream's emitted `await using`
syntax. Native installed-archive initialization, streaming and reopening have
passed under Node 24 on Linux x64; this does not establish other platforms.
When mixing Effect releases, install the worker in a separate dependency root;
pin `effect` and `@effect/platform-node-shared` to `4.0.0-rc.112` there. An isolated
linker alone does not prevent upstream caret ranges selecting an incompatible RC.

```ts
import { OpenCode } from "@camenae/opencode";

const client = await OpenCode.connect({
  baseUrl: "http://127.0.0.1:4096", password: process.env.WORKER_PASSWORD!,
  workspace: "/workspace", model: { providerID: "openai", id: "gpt-5" },
});
try {
  const id = await client.openSession();
  const unsubscribe = client.subscribe(event => { /* Handle native events and approvals. */ });
  try { await client.run(id, "Explain this workspace."); }
  finally { unsubscribe(); }
} finally { await client.close(); }
```

`run` waits for native execution, not just prompt admission. Execution failures
reject; cancellation returns `cancelled`. Only one run per connection is admitted.
Events remain native and live-only. A lost stream fails the connection; no prompt
is automatically retried. `native` exposes the full upstream client.

New sessions ask for native permissions; custom plugin tools own their own authorization.
Sessions with saved native project grants are refused without deleting those grants.
`approve` exposes only `once` and `reject`;
reject has OpenCode's native session-wide pending-request semantics. Approval is
not a sandbox. Native state is retained; reopening verifies its workspace.

The caller owns the worker, workspace, HOME/XDG/tmp, credentials, configuration,
containment, network access and retained database. `serve` disables project config
discovery and remote model-catalog fetches. Its configuration input must be trusted.
Run it with a private HOME and config directory, never the developer's OpenCode
state. Native diagnostics are disabled at the Effect logging boundary.

`close` disconnects observation; it does **not** confirm remote process cleanup.
The application must retire and verify the whole execution lifetime before reuse
after uncertain termination. No Docker launcher or application gateway is included.

OpenCode packages are MIT licensed; dependencies retain their own licenses.
Paid inference is not part of ordinary validation. This integration does not
provide or circumvent provider authentication or subscription entitlements.

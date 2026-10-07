# Bob Code Mode

`@camenae/bob/code-mode` adds optional tool composition through a private MCP
server. It uses `@opencode/codemode` 2.0.23 to interpret a JavaScript subset.
It does not modify Bob or expose Bob's built-in tools to the interpreter.
OpenCode consumers use OpenCode's native Code Mode instead of this bridge.

## API

`createBobCodeMode({ tools, authorize, limits? })` returns a server with:

- `connectStdio()`: connects the official MCP stdio transport. A dedicated child
  process is the recommended deployment. Its stdout is reserved for MCP.
- `connect(transport)`: accepts an official MCP transport. One connection is
  allowed per instance. The caller owns HTTP authentication, routing, body limits,
  disconnect handling, and the listener when using an HTTP transport.
- `close()`: aborts active execution and closes the owned transport. It does not
  prove that a callback or external side effect has stopped.

Tools have a unique alphanumeric or underscore `name` beginning with a letter,
a `description`, `inputSchema`, `outputSchema`, and async `execute(input, context)`.
The SDK validates tool inputs before authorization and validates outputs before
returning them to the script. `BobCodeModeSchema` describes the supported JSON
Schema subset. Schemas, callbacks, and tool descriptions are trusted application
configuration. They must not come from agent-generated files.

`authorize(context)` must resolve to `"allow"` for each nested call. Any other
answer or an exception denies that call. Context includes `executionId`, `callId`,
`toolName`, detached JSON `input`, and an `AbortSignal`. Modifying the approval
input cannot change the arguments passed to `execute`. Authorization callbacks
can delegate to the application's approval UI. No approval UI or ACP correlation
protocol is built into this bridge.

The server advertises one MCP tool, `execute({ code })`. Scripts discover supplied
tools through `search(...)`, await calls such as `tools.add({ a: 2, b: 3 })`, and
return JSON. The tool description includes the upstream search signature.
Each execution is independent. There is no persisted interpreter state, automatic
replay, rollback, or exactly-once guarantee.

Only one script runs at a time. Concurrent submissions fail rather than queue.
Outstanding host callbacks continue to occupy admission if they ignore cancellation.

| Limit | Default | Maximum |
| --- | --- | --- |
| `timeoutMs` | 30,000 | 300,000 |
| `maxToolCalls` | 32 | 256 |
| `maxOutputBytes` | 65,536 | 1,048,576 |
| `maxCodeBytes` | 16,384 | 65,536 |

The output budget covers the complete serialized result, including diagnostics,
logs and call records. Its minimum is 512 bytes. An oversized result becomes a
short truncation error and can omit records of completed calls. These budgets are not an operating-system memory
limit, and a host callback can allocate memory or block the event loop outside
the interpreter. Tool count includes calls that fail validation or authorization.

## Deployment and permissions

The interpreter has no `fetch`, imports, filesystem, process, or timer globals.
Only supplied tools can access external systems. Tool implementations run as
trusted code in the MCP process and retain that process's privileges. Pass their
`signal` to cancellable operations and keep credentials in those implementations,
not in tool descriptions or returned data.

Run the bridge in a dedicated, application-contained worker with restricted
filesystem access, network access, credentials, and resource limits. Do not run
untrusted programs in the application's privileged web process. The interpreter
is not an OS sandbox. Retire the whole execution lifetime after uncertain cleanup.

Bob's outer approval for MCP `execute` does not authorize its nested operations.
`authorize` remains mandatory even when `execute` is listed in native MCP
`alwaysAllow`. Keep global auto-approval off. One bridge process should belong to
one application execution scope. MCP does not identify the originating ACP session.

MCP cancellation, server close, and execution timeout interrupt cooperative work.
A late approval cannot start a tool after cancellation. A tool already started
may have changed external state. The bridge does not retry it. Closing the server
does not wait indefinitely for uncooperative callbacks or terminate their host.

Application exception details are hidden from the script. Program results and
diagnostics are still private conversation data. The bridge emits no diagnostic
logs containing prompts, inputs, credentials, or tool results.

## Consumer example

[`examples/code-mode.mjs`](examples/code-mode.mjs) is a complete stdio server with
one side-effect-free addition tool. Its Bob configuration is:

```ts
const client = await Bob.start({
	workspace,
	credential,
	autoApprove: false,
	managedMcpServers: [{
		name: "code",
		command: process.execPath,
		args: [absolutePathToCodeModeExample],
		env: [],
		alwaysAllow: ["execute"],
	}],
});
```

The executable and server path are trusted deployment inputs. The application
owns the workspace and worker environment as described in [SDK.md](SDK.md).
The example's authorization allows only `add`. Applications that register tools
with external effects must supply their own authorization decisions.

## Runtime and verification

The interpreter and its exact Effect rc.112 dependency are bundled behind this
optional entrypoint. Public declarations do not expose Effect types. Consumers
do not install or share an Effect runtime to use the bridge. Bob's Node 22 minimum
is unchanged.

`tests/sdk/code-mode.test.ts` owns the MCP/interpreter contract through the real
MCP client. Archive acceptance reuses its fixture. The separate native Bob fixture
checks discovery, composed results, and nested denial through Bob with a local
synthetic model. Neither test requires provider credentials or paid inference.

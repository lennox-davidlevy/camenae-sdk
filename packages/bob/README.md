# @camenae/bob

IBM Bob integration for Camenae SDK. Run native Bob 2.0.5 from Bun or Node.js,
using the package's verified private runtime and official ACP client.

## Use

Install a verified package archive into your application, then:

```ts
import { Bob } from "@camenae/bob";

const client = await Bob.start({
  workspace: process.cwd(),
  credential: { kind: "apiKey", apiKey: process.env.BOB_API_KEY! },
  autoApprove: false,
  approvalPolicy: { fallback: "deny" },
});

try {
  const result = await client.run({ prompt: "Explain what an agent harness does. Do not use tools." });
  console.log(result.text);
} finally {
  await client.close();
}
```

Set `BOB_API_KEY` first; this example uses paid inference. Consumers using Bun
must trust the `@officecli/officecli` installation script to provision the pinned
native binary. See the [setup requirements](SDK.md#requirements).

The package supports native sessions, streaming, permissions, cancellation,
managed MCP servers and custom modes, and Bob-owned usage reporting.
`Bob.connect()` and `Bob.serveOnce()` support deployment-owned Unix-socket workers.

**Not a sandbox:** applications own their workspaces, HOME/XDG/tmp, credentials,
containment and network policy. Remote disconnect is not cleanup confirmation.

## Guides

- [API, sessions, authentication and worker lifecycle](SDK.md)
- [MCP configuration and tool permissions](MCP.md)
- [Runtime compatibility and verification limits](COMPATIBILITY.md)
- [MCP permission correction](BOB-ACP-CORRECTION.md)
- [Session usage correction](BOB-USAGE-CORRECTION.md)
- [Third-party notices](THIRD_PARTY.md)

The SDK code is [MIT licensed](LICENSE). Bob and dependencies retain their own terms.

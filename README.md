# Camenae SDK

TypeScript integrations for building applications with agent harnesses.

Use independently consumable packages for sessions, streaming, permissions, and
process lifecycle. Each integration keeps the capabilities of its underlying
harness rather than hiding them behind a lowest-common-denominator API.

## Integrations

| Harness | Package | Status |
| --- | --- | --- |
| IBM Bob | [`@camenae/bob`](packages/bob/README.md) | Available as a local package archive |
| OpenCode V2 | [`@camenae/opencode`](packages/opencode/README.md) | Experimental isolated-worker integration; local archives |

There is no mandatory shared harness API. The experimental OpenCode adapter keeps
native events and session identifiers, rather than translating them to Bob's ACP.
See the [design principles](docs/design.md).

## Quick start

Install a verified Bob package archive produced by the [release workflow](docs/releasing.md).
For Bun consumers, first add `@officecli/officecli` to the application's
`trustedDependencies` so its native binary installer can run:

```sh
bun add /path/to/camenae-bob-0.5.0.tgz
```

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

Set `BOB_API_KEY` before running this example; it uses paid inference. Bob requires
Bun or Node.js ≥22.15.0 and a supported Unix platform. See the
[Bob guide](packages/bob/SDK.md) for platform limits, events, approvals, and SSO.

**This SDK is not a sandbox.** Applications own workspace and credential isolation,
network policy, persistence, and deployed worker lifetimes. Permission policy is
not a substitute for isolation.

## Documentation

- [Bob SDK](packages/bob/SDK.md)
- [MCP configuration and tool permissions](packages/bob/MCP.md)
- [Development](CONTRIBUTING.md)
- [Packaging and verification](docs/releasing.md)

## License

SDK code is [MIT licensed](LICENSE). Bob and other third-party components retain
their own licenses; see [third-party notices](packages/bob/THIRD_PARTY.md).

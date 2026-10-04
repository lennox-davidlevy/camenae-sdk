# Development

## Requirements

- Bun 1.4.2 (the tested repository toolchain).
- Node.js ≥22.15.0 and npm for Node compatibility and archive acceptance.
- A supported Unix environment with `tar` and `/bin/ps`.
- An authorized copy of the exact IBM Bob 2.0.5 archive identified by
  [`compatibility.json`](packages/bob/runtime/compatibility.json).

The Bob archive is not source and is not downloaded by the build. Obtain it
through your authorized IBM distribution channel or an authorized maintainer.
Do not substitute an arbitrary host installation. Preparation verifies the
archive SHA-256, metadata and both runtime corrections.

## Set up

From the repository root:

```sh
bun install --frozen-lockfile
cd packages/bob
bun run runtime:prepare /absolute/path/to/bobshell-2.0.5.tgz
cd ../..
bun run build
```

Installation must allow the declared trusted OfficeCLI installation script to
provision its pinned binary. Native startup verifies its digest and the native
helper packages. An install that omits required scripts or optional native
dependencies is not a supported validation shortcut.

## Check changes

```sh
bun run lint
bun run typecheck
bun run test
bun run test:node
bun run build
bun run smoke:package
bun run smoke:package:node
```

The smoke commands install a real archive in an isolated temporary project and
exercise actual Bob with synthetic credentials and loopback model replies. They
do not require paid inference. See [release verification](docs/releasing.md) to
test the same retained archive under both runtimes rather than packing twice.

Run lint after changes. Tests are excluded from the TypeScript build and are
covered by lint and both test runners. The vendored Oxlint configuration and
plugins are part of the source tree; preserve their notices and provenance.
Use package-local scripts for focused smoke runs.

## Live checks

Only with explicit paid-inference authorization and a supplied `BOB_API_KEY`, run
these from `packages/bob/` after building:

```sh
bun run smoke:package:live
bun run smoke:server:live
bun run smoke:runtime:modes:live
```

They use test-owned state. Do not point them at an existing consumer deployment.
Never put credentials, prompts, tool payloads or private paths in diagnostic logs.

## Changes and documentation

Keep integrations independently usable. A new harness needs a version-pinned
evaluation and a working vertical slice, not an empty directory or an invented
shared API. See [design](docs/design.md).

Update the owning package guide when public behavior changes. Preserve native
configuration and compatibility identifiers. Runtime corrections have independent
removal gates; do not change their pins simply to make a dependency upgrade pass.

SDK source is MIT licensed. Preserve third-party licensing and attribution;
adding an SDK license does not grant rights to redistribute Bob or other upstream
components. [Release preparation](docs/releasing.md) describes that boundary.

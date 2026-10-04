# Third-party notices

The MIT license in this package applies to SDK-authored code. It does not
relicense IBM Bob, bundled dependencies, native helpers or their modifications.

## IBM Bob

Package archives include a private Bob 2.0.5 runtime and IBM's original notices:

- `runtime/bob/dist/ibm-licence/license.txt`
- `runtime/bob/dist/ibm-licence/non_ibm_license.txt`
- `runtime/bob/dist/ibm-licence/notices.txt`

These files are generated from the authorized source archive; they are not
committed runtime source. The two SDK preparation corrections are documented in
[BOB-ACP-CORRECTION.md](BOB-ACP-CORRECTION.md) and
[BOB-USAGE-CORRECTION.md](BOB-USAGE-CORRECTION.md). The original archive is
unchanged; the shipped entrypoint is reproducibly modified.

Obtain Bob through an authorized distribution channel. Confirm the applicable
IBM entitlement, modification and redistribution terms before distributing a
Bob-containing archive. This repository does not establish those rights.

## Dependencies

ACP, MCP, YAML and other bundled libraries retain their upstream licenses and
the legal notices emitted by the bundler. Native node-pty, ripgrep and OfficeCLI
packages are installed dependencies with their own licenses. Preserve those
notices when redistributing the SDK and its runtime.

## Development tooling

The source repository also vendors anti-slop lint rules under
`tools/oxlint/anti-slop/`. Its MIT license and `UPSTREAM.md` accompany that source,
along with the nested Stylistic license and provenance. These development files
are excluded from the distributed SDK archive.

# Anti-slop provenance

- Source: <https://github.com/dmmulroy/anti-slop>.
- Vendored path: `packages/bob/tools/oxlint/anti-slop/`.
- Configuration: `packages/bob/oxlint.config.ts`.
- Exact upstream code commit: unknown. The original installation came from
  skill-distributed assets; its recorded computed hash was
  `4031728fbe75bdcad6ee3208fd52b5d66e167b056fefee1fa9758e9a6cb9c0c8`,
  not a Git revision. The original pristine tar snapshot has SHA-256
  `cb8b0772cba6755c2c3a5f59d50d664b4b68d767c2e759909ef12447af269aef`;
  it is retained in the maintainer's pre-cleanup backup, not distributed as source.
  Do not treat current upstream HEAD as this code's source identity.
- License: upstream MIT notice retrieved from
  <https://raw.githubusercontent.com/dmmulroy/anti-slop/main/LICENSE> on
  2026-10-04 and preserved in `LICENSE`. Nested Stylistic licensing and provenance
  remain in `vendor/eslint-stylistic/`.
- Local changes: provenance/license documentation only; rule implementations and
  configuration are retained without an upstream upgrade. Generic rules and
  Oxlint's accumulating-spread companion remain enabled at error severity.
  Effect assets are retained but not enabled; this SDK has no direct Effect
  dependency.
- Dependencies: `oxlint` and `@oxlint/plugins` are both pinned at `1.79.0`.

The configuration and complete vendored tree are repository source so lint works
from a fresh checkout. Keep this installation's unknown-base limitation explicit
when reviewing future upstream changes; never replace local policy blindly.

# Upstream provenance

- Source: <https://github.com/dmmulroy/anti-slop>
- Installed revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Installed on: 2026-09-22
- Plugin path: `tools/oxlint/anti-slop/index.ts`
- Previous upstream base: unknown; the previous vendored plugin matched the previous local skill bundle, but that bundle did not record an immutable source revision.

The generic plugin source from the installed revision is vendored here. Effect-only files were intentionally removed because this project does not depend on Effect. Generic rules are enabled in the repository lint configuration, including the native `oxc/no-accumulating-spread` companion rule, except `require-readable-spacing`, which is intentionally disabled.

`oxlint` and `@oxlint/plugins` remain paired at `1.83.0`. Verification at update time covered the upstream rule suites, the registered plugin through the project lint command, project type checking, and Fallow.

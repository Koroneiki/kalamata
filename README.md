# Kalamata

Kalamata is an Electrobun desktop application. It uses an anonymous Steam session to look up public app metadata by App ID and can install ready public depots from resources managed locally by the user.

Kalamata does not acquire manifests, depot keys, licenses, or account credentials. Manifests and keys must be seeded manually before a depot becomes available in the download UI.

Frontend native operations must go through typed Electrobun RPC. Frontend code must not import backend modules or manage `steam-user` directly. Bun-side Steam operations share one service and session.

## Development

```sh
bun install
bun run dev
```

## Verification

```sh
bun test
bun run format:check
bun run type-check
bun run lint
bun run build
```

Tests that require local Steam manifest fixtures are skipped when those ignored
fixtures are unavailable. The network-backed integration tests and their
fixtures are intentionally not committed or run in CI.

## Releases

GitHub Actions creates macOS ARM64 and Windows x64 packages when a version tag
is pushed. Update the version in `package.json`, commit it, and push a matching
tag:

```sh
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

The release workflow verifies the tag, runs the project checks, builds on each
native platform, and attaches the contents of `artifacts/` to a GitHub Release.
It can also be run manually from the GitHub Actions page to test packaging. A
manual run uploads temporary workflow artifacts but does not create a tag or a
GitHub Release.

The macOS package is ad-hoc signed but does not have an Apple Developer ID or
notarization, and the Windows package is unsigned. Gatekeeper and SmartScreen
may therefore warn before installation. Trusted macOS testers can allow
Kalamata without disabling Gatekeeper globally:

1. Open the downloaded DMG and drag Kalamata into **Applications**.
2. Try to open Kalamata once and dismiss the unidentified-developer warning.
3. Open **System Settings > Privacy & Security**.
4. Scroll to the Security section and click **Open Anyway** for Kalamata.
5. Confirm by clicking **Open**.

The macOS bundle has a local ad-hoc signature to preserve its integrity, but it
is not signed with an Apple Developer ID or notarized. Only bypass the warning
when the package came directly from the project's private GitHub release. Users
must be authenticated with GitHub to download release assets.

## Local Data And Manual Seeding

Mutable data is stored beneath Electrobun's `Utils.paths.userData` directory. The exact platform path includes the app identifier and release channel.

- Database: `<userData>/kalamata.db`
- Managed manifests: `<userData>/manifest-files/`
- Manifest filename: `<depotId>_<manifestId>.manifest`
- Stored manifest path: `manifest-files/<depotId>_<manifestId>.manifest`

Start Kalamata once so pending migrations create the database, then close the app and back up `kalamata.db` before editing it. Copy a manifest into the managed manifest directory using the exact filename above, then insert matching resource rows:

```sql
INSERT INTO manifest_files (depot_id, manifest_id, relative_path, created_at)
VALUES (2379781, '3512319404653808464', 'manifest-files/2379781_3512319404653808464.manifest', unixepoch('subsec') * 1000);

INSERT INTO depot_keys (depot_id, decryption_key, created_at)
VALUES (2379781, '<64 lowercase hexadecimal characters>', unixepoch('subsec') * 1000);
```

Replace the example IDs and values with one matching manifest and key. Kalamata validates the file path, depot ID, manifest ID, and key before use, and compares the manifest ID with Steam's current public manifest. An older fixture remains unavailable as `outdated`; do not change the database to bypass that check. Do not seed `library` or `library_depot_installs`: the first successful depot creates those records transactionally.

Generated migrations are bundled with packaged builds and are applied before the main window opens. A packaged launch with a fresh channel data directory must create `kalamata.db`, `manifest-files/`, and the four foundation tables without relying on the working directory.

## Maintenance Constraints

- Keep `steam-user` pinned to `5.3.0` while importing its private `steam-user/components/content_manifest.js` parser. Revalidate the adapter before upgrading the dependency.
- Under Bun, `steam-user@5.3.0` loads `lzma@2.3.2`, which assigns `globalThis.onmessage` and can keep the process alive. Preserve the handler restoration around the `steam-user` import unless clean process exit is verified without it.
- Keep `steam-user` on TCP unless Bun integration tests show that WebSocket connections no longer time out.

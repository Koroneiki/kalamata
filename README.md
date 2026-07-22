# kalamata

Minimal Bun/TypeScript library for downloading a Steam depot from an existing local manifest and depot key.

It logs onto Steam anonymously only to discover content servers. It does not acquire manifests, depot keys, app metadata, licenses, or account credentials.

## Usage

```ts
import { downloadDepot } from "kalamata";

const result = await downloadDepot({
  appId: 730,
  depotId: 731,
  manifestPath: "/data/731_7617088375292372759.manifest",
  depotKeyPath: "/data/steam.keys",
  outputDirectory: "/data/output",
  fileListPath: "/data/files.txt",
  verifyAll: true,
  maxDownloads: 8,
  onEvent: (event) => {
    // Forward this event through the consuming application's IPC protocol.
  },
});
```

The optional file list follows DepotDownloaderMod's format. Each nonblank line is either a case-insensitive literal manifest path or a case-insensitive regular expression prefixed with `regex:`.

```text
bin/game.exe
regex:^data/.+\.pak$
```

The key file format is one entry per line:

```text
731;<64 hexadecimal characters>
```

## Behavior

- New files are preallocated and populated from manifest chunks.
- Manifests are fully validated before Steam login or output mutation. Every regular file must have contiguous chunks covering its exact declared size.
- Completed installs are tracked in `outputDirectory/.DepotDownloader/depot.config.json`.
- Local manifests are cached with SHA-1 sidecars so the previous and current manifests can be compared on the next run.
- Existing files whose hashes are unchanged between completed manifests are trusted when `verifyAll` is false.
- Changed files reuse matching chunks after checking their Adler checksum at the old manifest offset. Valid chunks are moved to their new offsets and only missing or corrupt chunks are downloaded.
- Existing files are validated against the current manifest when there is no completed previous state, including after an interrupted run.
- With `verifyAll: true`, matching chunks are checked even when the old and new file hashes agree.
- With `verifyAll: true`, each completed file is also checked against its manifest SHA-1.
- File-list downloads are partial installs and intentionally remain marked incomplete. A later run therefore validates selected files instead of trusting the whole manifest.
- Files removed by the new manifest are deleted after a successful download. Unrelated files and files excluded by the current file list are untouched.
- Identical chunks referenced by multiple files are downloaded once per run and written to each destination.
- Chunk downloads are decrypted and SHA-1 checked in workers. Steam ZSTD chunks use Bun's native decoder; ZIP and VZip containers are decoded directly with `adm-zip` and `lzma`.
- Manifest paths are constrained to `outputDirectory`; internal-state aliases and traversal through existing symlinks are rejected. Manifest symlink entries are unsupported and fail during preflight rather than being materialized incorrectly.
- One download at a time may use an output directory. The internal lock protects manifest state and staging files from concurrent writers.
- Unix executable flags are restored.
- Cancellation is supported with `AbortSignal`.
- Content servers are ordered by weighted load and rotated on checkout so concurrent requests are distributed immediately.

`steam-user` does not publicly export its local manifest parser. This package therefore pins `steam-user` to `5.3.0` and imports `steam-user/components/content_manifest.js`. Revalidate that adapter before upgrading `steam-user`.

## Bun compatibility

`steam-user@5.3.0` loads `lzma@2.3.2`. Under Bun, that transitive LZMA implementation assigns `globalThis.onmessage` as if the current runtime were a web worker and keeps an otherwise finished process alive. The downloader therefore preserves and restores the existing handler when loading `steam-user`. Do not remove that restoration without first confirming clean process exit under the supported Bun version.

Steam VZip stores the five LZMA property bytes and compressed payload but omits the normal LZMA-alone eight-byte uncompressed-size field. `decompressVzip` reconstructs that field from the Steam footer before calling the native `@napi-rs/lzma` decoder, then validates both the declared size and CRC-32. The final chunk SHA-1 check remains an additional integrity check.

## Development

```sh
bun install
bun test
bun run test:integration
bun run typecheck
```

The integration test downloads and SHA-1 verifies the 63.6 MiB Balatro depot using `test/fixtures/2379781_3512319404653808464.manifest` and its matching key embedded in the test. It writes to a unique temporary directory and removes that directory even when the assertion fails. It is opt-in so `bun test` remains deterministic and does not depend on Steam's network or download game content.

Run it explicitly with `bun run test:integration`. The test requires public Steam CDN access, has a 120-second timeout, verifies all 14 downloaded files against their manifest SHA-1 values, confirms the host `globalThis.onmessage` handler is unchanged, and prints connection time, throughput, and retry count. Network throughput and retry count are diagnostic values rather than assertions because CDN conditions vary.

An additional opt-in Cat Quest integration test exercises a larger Unity depot with explicit directories, Windows-style paths, deep trees, and chunks referenced by multiple files. It uses a checked-in manifest fixture and embedded matching key, and downloads only `Cat Quest.exe` by default:

```sh
bun run test:integration:cat-quest
```

Set `CAT_QUEST_FULL=1` to download and SHA-1 verify all 729 regular files (335,815,339 bytes). The test always writes to and removes a unique temporary directory.

The Grow Home integration similarly downloads only `GrowHome.exe` by default:

```sh
bun run test:integration:grow-home
```

Set `GROW_HOME_FULL=1` to download and SHA-1 verify all 37 regular files (897,535,150 bytes) in the main Windows depot.

# Download Behavior

Kalamata follows documented SteamPipe behavior where Valve publishes it and defines conservative behavior where Steam client internals are undocumented.

| Area           | Valve-documented behavior                                        | Kalamata behavior                                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconstruction | SteamPipe divides files into chunks and updates changed content. | Changed effective files are reconstructed beside the live installation and committed only when complete.                                                                                                                                                                                                |
| Depot mounting | Files from later-mounted depots override earlier depots.         | Base-app depots come first, followed by DLC apps in `listofdlc` order. Depots within each app are ordered by numeric depot ID. Installed depots missing from current Steam metadata retain their relative order after published depots. A later file replaces an overlapping file or directory subtree. |
| Normal update  | Steam supports incremental updates.                              | Unchanged effective manifest entries are trusted. Changed, new, removed, and overlap-replaced paths enter the transaction.                                                                                                                                                                              |
| Repair         | Steam can verify installed files.                                | Regular repair uses recorded manifest IDs and mount order and does not select a newer version. After an interrupted commit, repair prefers the journal's intended target and falls back to recorded installed metadata when that target cannot be read. Repair hashes effective non-config files.       |
| Config files   | SteamPipe defines `UserConfig` and `VersionedUserConfig` flags.  | `UserConfig` becomes user-owned after creation. `VersionedUserConfig` is preserved on the same owning manifest and replaced when that manifest changes.                                                                                                                                                 |
| Free space     | SteamPipe builds updated content before replacing live content.  | Fresh preflight uses the logical size of changed effective files. Resume subtracts blocks already allocated to validated staging. Runtime `ENOSPC` remains authoritative.                                                                                                                               |

## Interruption Controls

| Action              | Behavior                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pause               | Stops pre-commit work after in-flight writes checkpoint, preserves staging, and survives restart.                                                                                                                              |
| Resume              | Trusts a valid completion ledger and continues missing chunks without rereading completed staged chunks.                                                                                                                       |
| Cancel              | Deletes pre-commit staging and resumable state. Commit-ready work cannot be cancelled.                                                                                                                                         |
| Shutdown            | Rejects new application operations, preserves and awaits pre-commit staging, and waits for an in-progress commit without aborting it.                                                                                          |
| Restart             | Explicit pause remains paused. Active staging resumes automatically. A missing or malformed pre-commit ledger is discarded instead of scanning staged bytes.                                                                   |
| Commit interruption | Commit actions roll forward idempotently. An already moved live file is accepted only after size and SHA-1 verification. If correctness cannot be proven, Kalamata exposes Repair and keeps the rest of the library available. |

Kalamata does not automatically roll back an interrupted commit. Valve does not document Steam client rollback or commit-recovery internals, so Repair is the explicit fallback.

## Manifest Acquisition

For library apps, loading app details automatically acquires latest missing or invalid Base Game and DLC manifests for the selected platforms by default. Unknown, unused, redistributable, and platform-filtered depots are excluded. The persisted setting can disable this and restore per-depot controls. Request-code lookups are serialized against `manifest.opensteamtool.com`, while subsequent Steam CDN downloads can continue independently. Concurrent requests for the same depot and manifest share one acquisition. Quitting rejects new manifest work and cancels unfinished acquisitions before Steam and database disposal.

Kalamata sends the displayed public manifest ID to `manifest.opensteamtool.com` for a request code, then acquires the manifest from Steam CDN through its anonymous session. It validates the container marker and embedded depot and manifest IDs before publishing the file locally. Readable filenames, metadata, and chunk layouts receive full structural validation. A valid managed manifest is not downloaded again; a missing or invalid managed manifest can be replaced. Startup removes registrations whose managed files are missing, but does not import files copied into the manifest directory outside backend ingestion.

## Operation Queue

Kalamata runs one active, paused, or resumable application operation at a time. A repair requirement blocks only its affected application, so other applications remain available. Multiple repair requirements are retained and exposed one at a time when no operation occupies the queue.

At startup, Kalamata first rolls forward commit-ready transactions for every installed application. It then restores at most one paused or active staging transaction before exposing queued repair requirements.

## Persistence Boundaries

Before first installation, depot selection edits are saved immediately. For an installed application, edits remain an in-memory draft until Update or Uninstall is confirmed; reconciliation saves that selection after planning and before staging, so it can remain selected when later staging fails. Stored selections are not pruned when Steam metadata temporarily omits a depot.

The live filesystem commits before installed-depot metadata is replaced atomically in SQLite. Reconciling to an empty selection removes installed-depot metadata and releases the install path. Transaction evidence and backups remain available until that metadata reconciliation succeeds.

## Operation Preview

Preview is advisory: it occupies no queue slot, reserves no install path, and persists no selection. Logical size change is target size minus source size. Maximum temporary disk space totals changed effective file sizes, while the network upper bound totals unique compressed chunks before local reuse is considered.

## Progress Counters

| Counter                 | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| Logical installed total | Effective target files after depot precedence.                   |
| Logical completed       | Trusted retained files plus completed staged chunks.             |
| Reused local            | Trusted retained bytes plus locally validated copied chunks.     |
| Network payload         | Successful encrypted response payload accepted for installation. |

Network payload excludes headers, failed responses, and transport overhead. Kalamata does not estimate ETA or speed.

## Durability Boundary

The journal and output lock target process-crash recovery. Kalamata does not claim sudden-power-loss durability, hostile same-user mutation outside the output-lock contract, orphaned-staging salvage, exact wire-byte accounting, automatic rollback, or multiple durable application queues.

## References

- [Valve: Uploading to Steam](https://partner.steamgames.com/doc/sdk/uploading)
- [Valve: Depot Mounting Rules](https://partner.steamgames.com/doc/store/application/depots#depot_mounting_rules)
- [Valve: Updating Your Game](https://partner.steamgames.com/doc/store/updates)
- [Valve Support: Verify Integrity](https://help.steampowered.com/en/faqs/view/0C48-FCBD-DA71-93EB)

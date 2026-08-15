# Download behavior

Kalamata follows Valve's published SteamPipe behavior. Where Valve does not document client internals, this document specifies Kalamata's behavior.

| Area           | Valve-documented behavior                                        | Kalamata behavior                                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconstruction | SteamPipe divides files into chunks and updates changed content. | Changed effective files are reconstructed beside the live installation and committed only when complete.                                                                                                                                                                                                |
| Depot mounting | Files from later-mounted depots override earlier depots.         | Base-app depots come first, followed by DLC apps in `listofdlc` order. Depots within each app are ordered by numeric depot ID. Installed depots missing from current Steam metadata retain their relative order after published depots. A later file replaces an overlapping file or directory subtree. |
| Normal update  | Steam supports incremental updates.                              | Unchanged effective manifest entries are trusted. Changed, new, removed, and overlap-replaced paths enter the transaction.                                                                                                                                                                              |
| Repair         | Steam can verify installed files.                                | Regular repair uses recorded manifest IDs and mount order and does not select a newer version. After an interrupted commit, repair prefers the journal's intended target and falls back to recorded installed metadata when that target cannot be read. Repair hashes effective non-config files.       |
| Config files   | SteamPipe defines `UserConfig` and `VersionedUserConfig` flags.  | `UserConfig` becomes user-owned after creation. `VersionedUserConfig` is preserved on the same owning manifest and replaced when that manifest changes.                                                                                                                                                 |
| Free space     | SteamPipe builds updated content before replacing live content.  | Fresh preflight uses the logical size of changed effective files. Resume subtracts blocks already allocated to validated staging. Runtime `ENOSPC` remains authoritative.                                                                                                                               |

## Interruption controls

| Action              | Behavior                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause               | Available after durable staging begins. Pause waits for active writes and the journal checkpoint to finish, then stops pre-commit work. It preserves staging across restarts. Planning remains cancellable but cannot be paused.                                                                                                                            |
| Resume              | Trusts a valid completion ledger and correctly sized staged files, then continues missing chunks without rereading completed staged chunks. The verifying phase applies executable mode; it does not rehash ledger-marked staged bytes.                                                                                                                     |
| Cancel              | Deletes pre-commit staging and resumable state. Commit-ready work cannot be cancelled.                                                                                                                                                                                                                                                                      |
| Shutdown            | Rejects new application operations, preserves and awaits pre-commit staging, and waits for an in-progress commit without aborting it.                                                                                                                                                                                                                       |
| Restart             | Explicit pause remains paused. Active staging resumes automatically. First-install path reservations remain attached while resumable staging or repair evidence exists. Ambiguous journals and archived repair evidence require Repair instead of automatic replay. A missing or malformed pre-commit ledger is discarded instead of scanning staged bytes. |
| Commit interruption | Commit actions roll forward idempotently. An already moved live file is accepted only when its size and SHA-1 hash match. If either check fails, Repair is required for that application while other library applications remain available.                                                                                                                 |

Kalamata does not automatically roll back an interrupted commit. Valve does not document Steam client rollback or commit-recovery internals, so Repair is the explicit fallback.

## Manifest acquisition

By default, loading a library application's details acquires the latest missing or invalid base-game and DLC depot keys and manifests for the selected platforms. Unknown, unused, redistributable, and platform-filtered depots are excluded. The persisted setting can disable this and restore per-depot controls. Manual acquisition requests a missing key first. It then requests the manifest even if no key was acquired. Key acquisition checks the base application's Lua source first. That source also contains its DLC depot keys. If the key is absent, acquisition checks the shared JSON source. At startup, HTTP validators refresh the fallback only when it has changed. A failed refresh leaves the existing valid copy in place. Request-code lookups are sent one at a time to `manifest.opensteamtool.com`. Steam CDN downloads do not use that lock. Concurrent requests for the same depot and manifest share one acquisition. Quitting rejects new acquisition work and cancels unfinished acquisitions before Steam and database disposal.

Kalamata sends the displayed public manifest ID to `manifest.opensteamtool.com` for a request code, then acquires the manifest from Steam CDN through its anonymous session. Before saving the file, it validates the container marker and embedded depot and manifest IDs. Readable filenames, metadata, and chunk layouts receive full structural validation. A valid managed manifest is not downloaded again, but a missing or invalid one can be replaced. Startup removes registrations whose managed files are missing. It does not import files copied into the manifest directory outside backend ingestion.

## Operation queue

Kalamata runs one application operation at a time. Confirmed work for other applications is stored in SQLite and starts in FIFO order after the current operation completes, fails, or is cancelled. A paused or resumable operation keeps the execution slot. Pending work can be removed before it starts. Removing a pending first install also releases its unused path reservation.

At startup, Kalamata rolls forward each unambiguous commit-ready transaction and restores at most one paused or active staging transaction before starting persisted pending work. A repair requirement blocks only its affected application. Multiple repair requirements are retained and exposed one at a time when no operation is running. Multiple journals for one installation are never ordered or replayed automatically. Repair archives all of them and uses the last committed installed metadata. A restored journal uses its recorded depot, manifest, mount order, and owner instead of current Steam metadata. The managed manifest and depot key are still validated before staging resumes.

## Persistence boundaries

Before first installation, user-driven depot selection edits are saved immediately. Automatic preview corrections remain in memory until the user confirms installation. Starting that installation reserves its output path even though no depot is installed yet. The UI derives installation state and Verify availability from installed-depot records, not from the path reservation. For an installed application, selection edits remain in memory until the user confirms Update or Uninstall. Reconciliation saves the selection after planning and before staging, so a later staging failure does not discard it. Stored selections are not pruned when Steam metadata temporarily omits a depot.

The live filesystem commits before installed-depot metadata is replaced atomically in SQLite. Reconciling to an empty selection removes installed-depot metadata and releases the install path. Transaction evidence and backups remain available until that metadata update succeeds.

## Operation preview

A preview does not occupy the operation queue, reserve an install path, or save the depot selection. It removes completely overridden depots from the in-memory selection draft. Partial overlaps remain selected and show which later-mounted depots take priority. Logical size change is target size minus source size. Maximum temporary disk space totals changed effective file sizes. The network upper bound totals unique compressed chunks before local reuse. When an install directory is selected, the estimate applies the same staging rules as execution. It omits complete matching target files and subtracts reusable chunks whose SHA-1 hashes match the values recorded in installed source manifests. Without a directory, the estimate equals the network upper bound. Arbitrary partial files outside the installed source projection are not chunk-reuse candidates.

## Progress counters

| Counter                 | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| Logical installed total | Effective target files after depot precedence.                   |
| Logical completed       | Trusted retained files plus completed staged chunks.             |
| Reused local            | Trusted retained bytes plus locally validated copied chunks.     |
| Network payload         | Successful encrypted response payload accepted for installation. |

Payload estimates and counters exclude headers, failed responses, retries, and transport overhead. Kalamata does not estimate ETA or speed.

## Durability boundary

The journal and output lock support recovery after a process crash. Kalamata does not support recovery guarantees for sudden power loss or same-user mutation outside the output-lock contract. It also does not support orphaned-staging recovery, exact wire-byte accounting, automatic rollback, or multiple persistent application queues.

## References

- [Valve: Uploading to Steam](https://partner.steamgames.com/doc/sdk/uploading)
- [Valve: Depot Mounting Rules](https://partner.steamgames.com/doc/store/application/depots#depot_mounting_rules)
- [Valve: Updating Your Game](https://partner.steamgames.com/doc/store/updates)
- [Valve Support: Verify Integrity](https://help.steampowered.com/en/faqs/view/0C48-FCBD-DA71-93EB)

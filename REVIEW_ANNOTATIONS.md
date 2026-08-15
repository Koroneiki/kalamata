# Review annotations

## No. 001 - Trust in paused staging files

Created: 13.08.2026

On resume, completed chunks are accepted when the journal entry and staged file size match. Staging files are not fully hashed again before commit. This review accepts that behavior.

### Technical rationale

Every downloaded chunk is verified against its SHA-1 hash before it is written. The journal and output lock support recovery after process interruption and coordinate cooperating Kalamata processes. Mutation by other processes running as the same user during a pause is outside this trust model.

### Scope

This exception applies only to chunks marked complete in a paused transaction journal. Validation of the journal structure, staged file type and size, newly downloaded chunks, and files already moved during commit remains required.

## No. 002 - SteamDB-compatible file change counts

Created: 14.08.2026

Added and removed file-change counts include directory entries, including directories implied by nested manifest paths. This review accepts the behavior because it matches SteamDB manifest diffs, although the interface labels all counted entries as files.

### Technical rationale

Steam manifests represent directories as entries in the projected filesystem tree. A file-type replacement counts as one removal and one addition. Implied directory creation and removal also count so the totals match SteamDB.

### Scope

This exception applies only to the added and removed counts in application-operation previews. Modified counts continue to include only non-directory files whose content hash, size, or flags changed.

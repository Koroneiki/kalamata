# Review Annotations

## No. 001 - Trust in Paused Staging Files

Created: 13.08.2026

When a paused download is resumed, completed chunks are accepted based on the journal and expected file size. Staging files are not fully hashed again before commit. This behavior is intentional and accepted.

### Technical Rationale

Every downloaded chunk is verified against its SHA-1 hash before it is written. The journal and output lock support recovery after process interruption and coordinate cooperating Kalamata processes. Mutation by other processes running as the same user during a pause is outside this trust model.

### Scope

This exception applies only to chunks recorded as completed in the journal of a paused staging transaction. Existing validation of the journal structure, file type, file size, newly downloaded chunks, and files already moved during commit remains required.

## No. 002 - SteamDB-Compatible File Change Counts

Created: 14.08.2026

Added and removed file-change counts intentionally include directory entries, including directories implied by nested manifest paths. This matches the established SteamDB manifest-diff convention and is accepted even though the interface summarizes these entries as files.

### Technical Rationale

Steam manifests represent directories as entries relevant to the projected filesystem tree. Counting a file-type replacement as one removal and one addition, and counting implied directory creation or removal, keeps Kalamata's totals comparable with SteamDB.

### Scope

This exception applies only to the added and removed counts in application-operation previews. Modified counts continue to include only non-directory files whose content hash, size, or flags changed.

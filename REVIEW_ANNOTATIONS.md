# Review Annotations

## No. 001 - Trust in Paused Staging Files
Created: 13.08.2026

When a paused download is resumed, completed chunks are accepted based on the journal and expected file size. Staging files are not fully hashed again before commit. This behavior is intentional and accepted.

### Technical Rationale
Every downloaded chunk is verified against its SHA-1 hash before it is written. The journal and output lock support recovery after process interruption and coordinate cooperating Kalamata processes. Mutation by other processes running as the same user during a pause is outside this trust model.

### Scope
This exception applies only to chunks recorded as completed in the journal of a paused staging transaction. Existing validation of the journal structure, file type, file size, newly downloaded chunks, and files already moved during commit remains required.

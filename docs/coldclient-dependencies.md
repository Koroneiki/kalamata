# ColdClient dependency policy

## Delivery model

Kalamata does not bundle or mirror Goldberg/GBE Fork, GSE Tools, or 7-Zip binaries. The first download of each dependency requires an explicit user action. Once installed, newer upstream releases are checked and installed automatically in background jobs. Removing a dependency deletes its managed artifacts and disables automatic updates until another manual installation; existing game-local `_ColdClient` copies are not changed. The configured sources are:

- `Detanup01/gbe_fork`: `emu-win-release-vs26.7z`
- `alex47exe/gse_fork_tools`: `gen_emu_cfg-Windows-Release.7z`
- `ip7z/7zip`: `7zr.exe`

The downloaded files stay in the app's user-data directory. A release package must not contain these files. Changing this delivery model requires another license and redistribution review before release.

## License review

The upstream licenses were reviewed on 2026-08-19 for the previous manual-download model. The new automatic-update behavior needs a fresh license and redistribution review before release.

| Dependency      | Upstream license                                                                                        | Distribution decision                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| GBE Fork        | GNU LGPL v3                                                                                             | Manual first download, then automatic updates from upstream; do not bundle or mirror |
| GSE Tools       | GNU LGPL v3                                                                                             | Manual first download, then automatic updates from upstream; do not bundle or mirror |
| 7-Zip `7zr.exe` | GNU LGPL v2.1 or later, with component-specific BSD terms and the unRAR restriction documented upstream | Manual first download, then automatic updates from upstream; do not bundle or mirror |

The release checklist must confirm this delivery model. If a future package conveys any dependency binary, that release must include every notice, license copy, source offer, and other material required by the exact artifact before distribution.

## Trust policy

Each download uses the HTTPS asset URL returned by the configured GitHub repository's latest-release API. Kalamata computes SHA-256 once. When GitHub publishes a digest, activation requires an exact match and records `github-digest`. When no digest is published, activation records `https-inventory` and still requires archive safety checks plus the dependency's expected file inventory.

This digest fallback is an explicit product decision. HTTPS and structural validation do not prove publisher identity as strongly as a published digest.

## Process injection

GBE's two official `steamclient_extra` DLLs are copied to `extra_dlls` and configured through `DllsToInjectFolder=extra_dlls`. The loader injects the architecture-matching DLL into the game process, which may patch SteamStub behavior. The setup review must disclose this before it changes game files.

# Kalamata

Kalamata is a desktop application for looking up Steam applications and
installing public-branch depot content.

## Installation

Release packages are available for:

- macOS on Apple Silicon (`arm64`)
- Windows on 64-bit Intel or AMD systems (`x64`)

Download the package for your system from the repository's
[Releases](https://github.com/Koroneiki/kalamata/releases) page.

### macOS

1. Open the DMG.
2. Drag Kalamata into **Applications**.
3. Open Kalamata from **Applications**.

The package is ad-hoc signed and not notarized. If macOS blocks the first
launch, open **System Settings > Privacy & Security** and select **Open Anyway**
for Kalamata.

### Windows

1. Extract the downloaded ZIP.
2. Run the included Kalamata Setup executable.

The package is unsigned, so Microsoft Defender SmartScreen may display an
unknown-publisher warning.

## Updates

Install the package for the newer release. Existing application data is
preserved.

## Local data

Kalamata stores its data and diagnostic logs in:

- macOS: `~/Library/Application Support/com.koroneiki.kalamata/stable/`
- Windows: `%LOCALAPPDATA%\com.koroneiki.kalamata\stable\`

## Development

Development requires Bun 1.4.0.

```sh
bun install --frozen-lockfile
bun run dev
```

### Verification

```sh
bun run format:check
bun run lint
bun run type-check
bun test
bun run build
```

## Releases

1. Update the version in `package.json` and add the release to `CHANGELOG.md`.
2. Commit and push the release changes.
3. Run the release workflow manually and test both generated packages. Confirm they contain no GBE, GSE Tools, or 7-Zip binaries, and verify the ColdClient dependency policy in `docs/coldclient-dependencies.md` against the selected upstream releases.
4. Create and push the matching version tag.

```sh
git tag "v$(bun -p 'require("./package.json").version')"
git push origin main
git push origin "v$(bun -p 'require("./package.json").version')"
```

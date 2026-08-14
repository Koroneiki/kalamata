# Changelog

## v0.1.0

Release date: 14.08.2026

[source at release](https://github.com/Koroneiki/kalamata/tree/v0.1.0)

### 🚀 New

- **library:** Look up public Steam applications and maintain a local game library.
- **resources:** Acquire and validate public-branch manifests and depot keys.
- **downloads:** Install, update, verify, pause, resume, repair, and uninstall selected depots through a transactional operation queue.
- **recovery:** Persist operation state and recover interrupted installations.
- **desktop:** Package the application for macOS ARM64 and Windows x64.

### ✨ Enhancements

- **preview:** Show affected files and download-size bounds before starting an operation.
- **settings:** Configure depot visibility, target platforms, automatic resource acquisition, and per-game installation behavior.
- **diagnostics:** Record local rotating diagnostic logs for startup, recovery, operation, and shutdown failures.

### ✅ Tests

- **backend:** Cover database migrations, manifest validation, transactional installation, operation lifecycle, and crash recovery.
- **release:** Verify formatting, linting, types, tests, native builds, and installer selection in CI.

### 📖 Documentation

- **release:** Document installation, manual updates, local data, licensing, and release maintenance.

### ❤️ Contributors

- Koroneiki <101889814+Koroneiki@users.noreply.github.com>

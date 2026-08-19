# Changelog

## v0.2.0

Release date: 19.08.2026

[compare changes](https://github.com/Koroneiki/kalamata/compare/v0.1.0...v0.2.0)

### 🚀 New

- **downloads:** Persist application operations across restarts and allow pending downloads to be prioritized.
- **updates:** Discover available application updates and queue reviewed updates from the library.
- **resources:** Acquire depot keys through Hubcap when Steam cannot provide them.

### ✨ Enhancements

- **downloads:** Show estimated progress while preparing and downloading application files.
- **depots:** Filter depots and DLC by Steam store package eligibility.
- **desktop:** Refine the application details, settings, and window layout.

### 🩹 Fixes

- **resources:** Cache automatic resource acquisitions to avoid duplicate requests.
- **depots:** Treat unresolved DLC ownership as unknown instead of eligible.
- **preview:** Keep operation previews limited to manifest acquisition.

### 💅 Refactors

- **codebase:** Add Fallow analysis and simplify backend workflows and frontend components #1.

### 🏡 Chore

- **release:** Pin release builds to stable Bun 1.3.13.

### ✅ Tests

- **behavior:** Focus tests on queue persistence, update discovery, resource acquisition, progress reporting, and recovery contracts.

### 📖 Documentation

- **project:** Clarify architecture, download behavior, release maintenance, and code-quality guidance.

### ❤️ Contributors

- Koroneiki <101889814+Koroneiki@users.noreply.github.com>

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

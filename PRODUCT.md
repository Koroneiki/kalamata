# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Kalamata is a private desktop utility for anonymously looking up public Steam application information. Its planned foundation extends that workflow to installing depot content from resources already managed locally by the user.

## Operating Context

- A user starts with a Steam App ID or an app already recorded in the local library.
- Steam product identity remains live metadata rather than persisted user data.
- Downloads use local manifest files and depot keys that are already available to Kalamata.
- Core screens must remain operable in narrow, resizable desktop windows.

## Capabilities and Constraints

Current capabilities:

- Look up and display public Steam app metadata by App ID.
- Show installed apps from a local library and public-branch depot readiness.
- Let the user choose an install directory for a new app.
- Preview depot actions and size bounds before confirming an operation.
- Let the user install, update, uninstall, and verify selected depots through one application-wide operation queue.
- Show active operation progress and controls inline and persist successful installation state locally.

Durable constraints:

- Kalamata does not acquire manifests, depot keys, licenses, entitlements, or account credentials.
- The foundation exposes only public-branch manifests and does not provide branch selection.
- The foundation does not include parallel downloads, download history, retries, automatic rollback, or partial file selection.

## Brand Commitments

- The product name is Kalamata.
- `DESIGN.md` defines the approved visual system; no logo, custom typography, or product artwork has been approved.

## Evidence on Hand

- `plan/IMPLEMENTATION_PLAN_FOUNDATION.md` is the implemented foundation baseline.
- `plan/FEATURE_LIST.md` records features outside that foundation and must not be presented as available.
- The repository contains no testimonials, benchmarks, customer claims, or product artwork; future UI work must not fabricate them.

## Product Principles

1. Keep ownership local: installation state, managed resources, and downloads stay on the user's machine.
2. Make readiness explicit: distinguish missing, outdated, invalid, installed, and selectable depot states before download.
3. Do not imply capabilities outside the implemented scope.

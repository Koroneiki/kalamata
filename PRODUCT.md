# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product purpose

Kalamata lets users inspect public Steam application metadata and install public-branch depot content without signing in to Steam. It stores library records, managed manifests and keys, installation state, and downloaded content on the user's computer.

## Operating context

- Kalamata ships as an Electrobun desktop application for macOS and Windows. Its interface uses a web design language.
- A user starts with a Steam App ID or an application already recorded in the local library.
- Steam product identity remains live metadata. Kalamata keeps only the records and files needed to manage installations.
- The interface must work in narrow, resizable desktop windows.

## Capabilities and constraints

- Kalamata supports application lookup, depot readiness checks, operation previews, installation, updates, verification, and uninstallation.
- Operations use one application-wide queue. `docs/download-behavior.md` defines download, recovery, and persistence behavior.
- Kalamata handles only public-branch content. It does not acquire licenses, entitlements, account credentials, or alternate branches.

## Brand commitments

- The product name is Kalamata.
- `DESIGN.md` defines the approved visual system; no logo, custom typography, or product artwork has been approved.

## Evidence and claims

- The repository contains no testimonials, benchmarks, customer claims, or product artwork. Do not add any without a source.
- Do not present planned or unsupported capabilities as available.

## Product principles

1. Keep installation data and downloaded content on the user's computer.
2. Show depot readiness and recovery requirements before an operation starts.
3. Prefer explicit status and measured values over implied capability.

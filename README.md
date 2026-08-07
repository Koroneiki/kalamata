# Kalamata

Kalamata is an Electrobun desktop application. The current UI uses an anonymous Steam session to look up public app metadata by App ID.

The Bun backend can download Steam depot content from a local manifest and depot key, but downloading is not exposed through the UI or RPC yet. Kalamata does not acquire manifests, depot keys, licenses, or account credentials.

Frontend native operations must go through typed Electrobun RPC. Frontend code must not import backend modules or manage `steam-user` directly. Bun-side Steam operations share one service and session.

## Development

```sh
bun install
bun run dev
```

## Verification

```sh
bun test
bun run type-check
bun run lint
bun run build
```

## Maintenance Constraints

- Keep `steam-user` pinned to `5.3.0` while importing its private `steam-user/components/content_manifest.js` parser. Revalidate the adapter before upgrading the dependency.
- Under Bun, `steam-user@5.3.0` loads `lzma@2.3.2`, which assigns `globalThis.onmessage` and can keep the process alive. Preserve the handler restoration around the `steam-user` import unless clean process exit is verified without it.
- Keep `steam-user` on TCP unless Bun integration tests show that WebSocket connections no longer time out.

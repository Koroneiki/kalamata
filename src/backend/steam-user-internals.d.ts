declare module 'steam-user/components/content_manifest.js' {
  import type { DepotManifest } from './types.ts'

  export function parse(buffer: Buffer): DepotManifest
  export function decryptFilenames(manifest: DepotManifest, key: Buffer): void
}

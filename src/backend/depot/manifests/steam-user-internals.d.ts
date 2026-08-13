declare module 'steam-user/components/content_manifest.js' {
  import type { DepotManifest } from './types.ts'

  export function parse(buffer: Buffer): unknown
  export function decryptFilenames(manifest: DepotManifest, key: Buffer): void
}

declare module 'steam-user/components/cdn_compression.js' {
  const compression: {
    unzip(data: Buffer): Promise<Buffer>
  }
  export default compression
}

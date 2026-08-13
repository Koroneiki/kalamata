import { createHash } from 'node:crypto'
import { SteamSession } from '../../src/backend/steam/steam-session.ts'
import { SteamContentClient } from '../../src/backend/depot/transfer/steam-content-client.ts'
import { ContentServerSelector } from '../../src/backend/depot/transfer/content-server-selector.ts'
import type { ContentServer } from '../../src/backend/depot/transfer/chunk-client.ts'
import type { ManifestFile } from '../../src/backend/depot/manifests/types.ts'

export interface ManifestFileDownloadMetrics {
  sha1: string
  size: number
  networkBytes: number
  compressedBytes: number
  chunkCount: number
  attempts: number
  connectMilliseconds: number
  downloadMilliseconds: number
}

export async function downloadManifestFile(
  appId: number,
  depotId: number,
  depotKey: Buffer,
  file: ManifestFile,
): Promise<ManifestFileDownloadMetrics> {
  const size = Number(file.size)
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error(`Invalid manifest file size: ${file.size}`)

  const session = new SteamSession()
  let client: SteamContentClient | undefined
  const startedAt = performance.now()
  try {
    client = new SteamContentClient(await session.getClient(), depotKey)
    const connectedAt = performance.now()
    const { servers } = await client.getContentServers(appId)
    const selector = new ContentServerSelector(servers)
    const output = Buffer.alloc(size)
    const chunks = Map.groupBy(file.chunks, (chunk) => chunk.sha)
    let networkBytes = 0
    let compressedBytes = 0
    let attempts = 0

    for (const group of chunks.values()) {
      const chunk = group[0]!
      compressedBytes += chunk.cb_compressed
      const attempted = new Set<ContentServer>()
      let downloaded:
        | Awaited<ReturnType<SteamContentClient['downloadChunk']>>
        | undefined
      let lastError: unknown

      for (let attempt = 0; attempt < selector.attemptsPerChunk; attempt++) {
        const server = selector.getConnection(attempted)
        attempted.add(server)
        attempts++
        try {
          downloaded = await client.downloadChunk(
            appId,
            depotId,
            chunk.sha,
            server,
            undefined,
            chunk.cb_original,
          )
          selector.returnConnection(server)
          break
        } catch (error) {
          lastError = error
          selector.returnBrokenConnection(server)
        }
      }

      if (!downloaded)
        throw new Error(`Every content server failed for chunk ${chunk.sha}`, {
          cause: lastError,
        })
      if (downloaded.chunk.length !== chunk.cb_original)
        throw new Error(`Chunk ${chunk.sha} has an unexpected size`)

      networkBytes += downloaded.networkBytes
      for (const destination of group) {
        if (destination.cb_original !== downloaded.chunk.length)
          throw new Error(`Shared chunk ${chunk.sha} has inconsistent sizes`)
        downloaded.chunk.copy(output, Number(destination.offset))
      }
    }

    const completedAt = performance.now()
    const sha1 = createHash('sha1').update(output).digest('hex')
    if (sha1 !== file.sha_content.toLowerCase())
      throw new Error(`SHA1 mismatch for reconstructed file ${file.filename}`)

    return {
      sha1,
      size: output.length,
      networkBytes,
      compressedBytes,
      chunkCount: chunks.size,
      attempts,
      connectMilliseconds: connectedAt - startedAt,
      downloadMilliseconds: completedAt - connectedAt,
    }
  } finally {
    client?.dispose()
    session.dispose()
  }
}

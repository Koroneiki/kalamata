import {
  parseManifest,
  parseManifestEnvelope,
  validateManifest,
  validateManifestEnvelope,
} from '../manifests/manifest-codec.ts'
import { DIRECTORY } from '../manifests/manifest-utils.ts'
import { SteamContentClient } from '../transfer/steam-content-client.ts'
import { ContentServerSelector } from '../transfer/content-server-selector.ts'
import type { SteamSession } from '../../steam/steam-session.ts'
import { abortable } from '../../shared/abortable.ts'

export async function verifyDepotKey(
  session: Pick<SteamSession, 'getClient'>,
  appId: number,
  depotId: number,
  manifestId: string,
  contents: Buffer,
  key: Buffer,
  signal: AbortSignal,
): Promise<boolean> {
  const envelope = parseManifestEnvelope(contents)
  validateManifestEnvelope(envelope, depotId, manifestId)
  if (envelope.filenames_encrypted && envelope.files.length > 0) {
    const manifest = parseManifest(contents, key)
    validateManifest(manifest, depotId, manifestId)
    return true
  }

  validateManifest(envelope, depotId, manifestId)
  const chunk = envelope.files.find(
    (file) => !(file.flags & DIRECTORY) && file.chunks.length > 0,
  )?.chunks[0]
  if (!chunk) return false

  const client = new SteamContentClient(
    await abortable(session.getClient(), signal),
    key,
  )
  try {
    const { servers } = await abortable(client.getContentServers(appId), signal)
    if (!servers.length) return false
    const selector = new ContentServerSelector(servers)
    const attempted = new Set<(typeof servers)[number]>()
    for (let attempt = 0; attempt < selector.attemptsPerChunk; attempt++) {
      signal.throwIfAborted()
      const server = selector.getConnection(attempted)
      attempted.add(server)
      try {
        // The existing chunk decoder verifies both its uncompressed size and SHA-1.
        await client.downloadChunk(
          appId,
          depotId,
          chunk.sha,
          server,
          signal,
          chunk.cb_original,
        )
        selector.returnConnection(server)
        return true
      } catch {
        signal.throwIfAborted()
        selector.returnBrokenConnection(server)
      }
    }
    return false
  } finally {
    client.dispose()
  }
}

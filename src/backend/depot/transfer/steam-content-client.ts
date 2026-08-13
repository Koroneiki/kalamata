import { abortable } from '../../shared/abortable.ts'
import type { ChunkClient, ContentServer } from './chunk-client.ts'
import {
  HttpStatusError,
  buildChunkUrl,
  contentServerVhost,
  downloadChunkData,
} from './chunk-http.ts'
import { DecompressPool } from './decompress-pool.ts'
import type { SteamContentUser } from '../../steam/types.ts'

export class SteamContentClient implements ChunkClient {
  #decompressPool: DecompressPool | undefined
  readonly #cachedTokens = new Map<string, Promise<string>>()
  readonly #tokenRequiredHosts = new Set<string>()

  constructor(
    private readonly user: SteamContentUser,
    private readonly depotKey: Buffer,
  ) {}

  getContentServers(appId: number): Promise<{ servers: ContentServer[] }> {
    return this.user.getContentServers(appId)
  }

  async downloadChunk(
    appId: number,
    depotId: number,
    chunkSha1: string,
    server: ContentServer,
    signal?: AbortSignal,
    expectedSize?: number,
  ): Promise<{ chunk: Buffer; networkBytes: number }> {
    const hostname = contentServerVhost(server)
    const tokenCacheKey = `${depotId}_${hostname}`
    let token =
      server.usetokenauth === 1 || this.#tokenRequiredHosts.has(tokenCacheKey)
        ? await abortable(this.#getToken(appId, depotId, hostname), signal)
        : ''

    let location = buildChunkUrl(server, depotId, chunkSha1, token)
    let encrypted: Buffer
    try {
      encrypted = await downloadChunkData(location.url, location.vhost, signal)
    } catch (error) {
      // Some servers omit token auth metadata, and cached tokens may expire during long downloads.
      if (!(error instanceof HttpStatusError) || error.statusCode !== 403)
        throw error
      this.#tokenRequiredHosts.add(tokenCacheKey)
      token = await abortable(
        this.#getToken(appId, depotId, hostname, token),
        signal,
      )
      location = buildChunkUrl(server, depotId, chunkSha1, token)
      encrypted = await downloadChunkData(location.url, location.vhost, signal)
    }
    this.#decompressPool ??= new DecompressPool(this.depotKey)
    const networkBytes = encrypted.length
    return {
      chunk: await this.#decompressPool.process(
        encrypted,
        chunkSha1,
        expectedSize,
        signal,
      ),
      networkBytes,
    }
  }

  dispose(): void {
    this.#decompressPool?.dispose()
  }

  async #getToken(
    appId: number,
    depotId: number,
    hostname: string,
    staleToken?: string,
  ): Promise<string> {
    const cacheKey = `${depotId}_${hostname}`
    let token = this.#cachedTokens.get(cacheKey)
    if (token && staleToken !== undefined) {
      if ((await token) !== staleToken) return token
      if (this.#cachedTokens.get(cacheKey) === token)
        this.#cachedTokens.delete(cacheKey)
      token = undefined
    }
    if (!token) {
      const requestedToken = this.user
        .getCDNAuthToken(appId, depotId, hostname)
        .then((result) => result.token)
        .catch((error) => {
          if (this.#cachedTokens.get(cacheKey) === requestedToken)
            this.#cachedTokens.delete(cacheKey)
          throw error
        })
      token = requestedToken
      this.#cachedTokens.set(cacheKey, token)
    }
    return token
  }
}

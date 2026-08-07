import http from 'node:http'
import https from 'node:https'
import type { ChunkClient, ContentServer } from './content-client.ts'
import {
  HttpStatusError,
  buildChunkUrl,
  contentServerVhost,
  downloadChunkData,
} from './chunk-download.ts'
import { DecompressPool } from './decompress-pool.ts'
import type { SteamContentUser } from '../steam/types.ts'

export class SteamContentClient implements ChunkClient {
  #decompressPool: DecompressPool | undefined
  // Keep connection reuse local to this download instead of mutating the host process's global agents.
  readonly #httpAgent = new http.Agent({ keepAlive: true })
  readonly #httpsAgent = new https.Agent({ keepAlive: true })
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
  ): Promise<{ chunk: Buffer }> {
    const hostname = contentServerVhost(server)
    const tokenCacheKey = `${depotId}_${hostname}`
    let token =
      server.usetokenauth === 1 || this.#tokenRequiredHosts.has(tokenCacheKey)
        ? await this.#getToken(appId, depotId, hostname)
        : ''

    let location = buildChunkUrl(server, depotId, chunkSha1, token)
    let encrypted: Buffer
    try {
      encrypted = await downloadChunkData(
        location.url,
        location.vhost,
        signal,
        { http: this.#httpAgent, https: this.#httpsAgent },
      )
    } catch (error) {
      // Some servers omit token auth metadata, and cached tokens may expire during long downloads.
      if (!(error instanceof HttpStatusError) || error.statusCode !== 403)
        throw error
      this.#tokenRequiredHosts.add(tokenCacheKey)
      token = await this.#getToken(appId, depotId, hostname, token)
      location = buildChunkUrl(server, depotId, chunkSha1, token)
      encrypted = await downloadChunkData(
        location.url,
        location.vhost,
        signal,
        { http: this.#httpAgent, https: this.#httpsAgent },
      )
    }
    this.#decompressPool ??= new DecompressPool(this.depotKey)
    return {
      chunk: await this.#decompressPool.process(
        encrypted,
        chunkSha1,
        expectedSize,
        signal,
      ),
    }
  }

  dispose(): void {
    this.#decompressPool?.dispose()
    this.#httpAgent.destroy()
    this.#httpsAgent.destroy()
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

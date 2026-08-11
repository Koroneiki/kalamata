import type { ContentServer } from '../steam/types.ts'

export type { ContentServer } from '../steam/types.ts'

export interface ChunkClient {
  getContentServers(appId: number): Promise<{ servers: ContentServer[] }>
  downloadChunk(
    appId: number,
    depotId: number,
    sha: string,
    server: ContentServer,
    signal?: AbortSignal,
    expectedSize?: number,
  ): Promise<{ chunk: Buffer; networkBytes?: number }>
}

export interface ContentServer {
  Host: string
  vhost?: string
  https_support?: string
  usetokenauth?: number
  weightedload?: number
  NumEntriesInClientList?: number
  [key: string]: unknown
}

export interface ChunkClient {
  getContentServers(appId: number): Promise<{ servers: ContentServer[] }>
  downloadChunk(
    appId: number,
    depotId: number,
    sha: string,
    server: ContentServer,
    signal?: AbortSignal,
    expectedSize?: number,
  ): Promise<{ chunk: Buffer }>
}

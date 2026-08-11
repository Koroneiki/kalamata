import type { ContentServer } from '../steam/types.ts'

export class CDNClientPool {
  readonly #servers: ContentServer[]
  #nextServer = 0

  constructor(servers: ContentServer[]) {
    this.#servers = [...servers].sort(
      (left, right) => serverLoad(left) - serverLoad(right),
    )
    if (this.#servers.length === 0)
      throw new Error('No Steam content servers available')
  }

  get attemptsPerChunk(): number {
    return this.#servers.length
  }

  getConnection(excluded: ReadonlySet<ContentServer> = new Set()): ContentServer {
    // Advance on checkout so concurrent workers do not all receive the same initial server.
    for (let checked = 0; checked < this.#servers.length; checked++) {
      const server = this.#servers[this.#nextServer % this.#servers.length]!
      this.#nextServer++
      if (!excluded.has(server)) return server
    }
    throw new Error('No untried Steam content servers remain')
  }

  returnConnection(_server: ContentServer): void {}

  returnBrokenConnection(_server: ContentServer): void {}
}

function serverLoad(server: ContentServer): number {
  return typeof server.weightedload === 'number'
    ? server.weightedload
    : Number.POSITIVE_INFINITY
}

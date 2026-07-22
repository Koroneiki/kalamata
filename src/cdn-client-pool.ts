import type { ContentServer } from "./download-core.ts";

export class CDNClientPool {
  readonly #servers: ContentServer[];
  #nextServer = 0;

  constructor(servers: ContentServer[]) {
    this.#servers = [...servers].sort((left, right) => serverLoad(left) - serverLoad(right));
    if (this.#servers.length === 0) throw new Error("No Steam content servers available");
  }

  get attemptsPerChunk(): number {
    return 5;
  }

  getConnection(): ContentServer {
    // Advance on checkout so concurrent workers do not all receive the same initial server.
    const server = this.#servers[this.#nextServer % this.#servers.length]!;
    this.#nextServer++;
    return server;
  }

  // Rotation already happened at checkout; these remain lifecycle hooks for download-core.
  returnConnection(_server: ContentServer): void {}

  returnBrokenConnection(_server: ContentServer): void {}
}

function serverLoad(server: ContentServer): number {
  return typeof server.weightedload === "number" ? server.weightedload : Number.POSITIVE_INFINITY;
}

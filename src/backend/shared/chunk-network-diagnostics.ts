import { randomUUID } from 'node:crypto'
import {
  createDiagnosticFetch,
  reportNetworkDiagnostic,
  type ChunkTransferSummary,
  type Fetcher,
  type NetworkDiagnostic,
  type NetworkReporter,
} from './network-diagnostics.ts'

// One scope per download, shared across its depots. Chunk events only update
// counters in memory; even repeated failures never produce per-request log spam.
export class ChunkNetworkDiagnostics {
  readonly fetch: Fetcher
  readonly #downloadId = randomUUID()
  readonly #servers = new Map<string, ChunkTransferSummary>()
  readonly #activeServers = new Map<string, number>()

  constructor(
    private readonly appId?: number,
    private readonly report: NetworkReporter = reportNetworkDiagnostic,
    fetcher: Fetcher = fetch,
    private readonly onActiveServers?: (urls: string[]) => void,
  ) {
    this.fetch = createDiagnosticFetch((event) => this.record(event), fetcher)
  }

  flush(): void {
    for (const summary of this.#servers.values())
      reportNetworkDiagnostic(summary, this.report)
    this.#servers.clear()
  }

  private record(event: NetworkDiagnostic): void {
    if (
      event.event === 'outbound.started' ||
      event.event === 'outbound.finished'
    )
      this.recordActiveServer(event)
    if (event.event !== 'outbound.finished') return
    const key = JSON.stringify([
      event.host,
      event.port,
      event.protocol,
      event.vhost,
    ])
    let summary = this.#servers.get(key)
    if (!summary) {
      summary = {
        event: 'download.cdn-summary',
        downloadId: this.#downloadId,
        appId: this.appId,
        host: event.host,
        port: event.port,
        protocol: event.protocol,
        vhost: event.vhost,
        requests: 0,
        receivedBodyBytes: 0,
        outcomes: { success: 0, failed: 0, cancelled: 0, timeout: 0 },
        statusCodes: {},
      }
      this.#servers.set(key, summary)
    }
    summary.requests++
    summary.receivedBodyBytes += event.receivedBodyBytes
    summary.outcomes[event.outcome]++
    if (event.statusCode !== null) {
      const status = String(event.statusCode)
      summary.statusCodes[status] = (summary.statusCodes[status] ?? 0) + 1
    }
  }

  private recordActiveServer(
    event: Extract<
      NetworkDiagnostic,
      { event: 'outbound.started' | 'outbound.finished' }
    >,
  ): void {
    // Expose origins only: chunk paths and query strings may contain credentials.
    const url = new URL(`${event.protocol}://${event.host}:${event.port}`)
      .origin
    const previous = this.#activeServers.get(url) ?? 0
    const count = previous + (event.event === 'outbound.started' ? 1 : -1)
    if (count > 0) this.#activeServers.set(url, count)
    else this.#activeServers.delete(url)
    if (previous > 0 !== count > 0)
      this.onActiveServers?.([...this.#activeServers.keys()].sort())
  }
}

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

  constructor(
    private readonly appId?: number,
    private readonly report: NetworkReporter = reportNetworkDiagnostic,
    fetcher: Fetcher = fetch,
  ) {
    this.fetch = createDiagnosticFetch((event) => this.record(event), fetcher)
  }

  flush(): void {
    for (const summary of this.#servers.values())
      reportNetworkDiagnostic(summary, this.report)
    this.#servers.clear()
  }

  private record(event: NetworkDiagnostic): void {
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
}

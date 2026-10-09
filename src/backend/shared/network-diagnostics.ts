import { randomUUID } from 'node:crypto'

export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface HttpContext {
  requestId: string
  method: string
  host: string
  port: string
  protocol: string
  vhost: string | null
}

export interface ChunkTransferSummary {
  event: 'download.cdn-summary'
  downloadId: string
  appId?: number
  host: string
  port: string
  protocol: string
  vhost: string | null
  requests: number
  receivedBodyBytes: number
  outcomes: Record<RequestOutcome, number>
  statusCodes: Record<string, number>
}

export interface SteamEndpoint {
  host?: string
  port?: string
  protocol?: 'tcp' | 'websocket'
}

type RequestOutcome = 'success' | 'failed' | 'cancelled' | 'timeout'
type FinishRequest = (outcome: RequestOutcome, bodyComplete?: boolean) => void

export type NetworkDiagnostic =
  | ChunkTransferSummary
  | ({ event: 'outbound.started' } & HttpContext)
  | ({
      event: 'outbound.finished'
      durationMs: number
      statusCode: number | null
      finalHost: string | null
      receivedBodyBytes: number
      bodyComplete: boolean
      outcome: RequestOutcome
    } & HttpContext)
  | ({
      event:
        | 'steam.session.started'
        | 'steam.session.connected'
        | 'steam.session.finished'
        | 'steam.server-selected'
      connectionId: string
      durationMs?: number
      outcome?: 'failed' | 'cancelled' | 'disconnected' | 'disposed'
    } & SteamEndpoint)

export type NetworkReporter = (diagnostic: NetworkDiagnostic) => void
let applicationReporter: NetworkReporter | undefined

export function initializeNetworkDiagnostics(report: NetworkReporter): void {
  applicationReporter = report
}

export function reportNetworkDiagnostic(
  diagnostic: NetworkDiagnostic,
  report: NetworkReporter | undefined = applicationReporter,
): void {
  try {
    report?.(diagnostic)
  } catch {
    // A diagnostic sink must not break requests or Steam event handling.
  }
}

const applicationFetch = createDiagnosticFetch(reportNetworkDiagnostic)

export const networkFetch: Fetcher = (input, init) =>
  applicationReporter ? applicationFetch(input, init) : fetch(input, init)

export function createDiagnosticFetch(
  report: NetworkReporter,
  fetcher: Fetcher = fetch,
): Fetcher {
  return async (input, init) => {
    const request = input instanceof Request ? input : null
    const signal = init?.signal === undefined ? request?.signal : init.signal
    const context = describeRequest(input, init)
    const started = performance.now()
    let receivedBodyBytes = 0
    let response: Response | undefined
    let finished = false
    const finish: FinishRequest = (outcome, bodyComplete = false) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', onAbort)
      reportNetworkDiagnostic(
        {
          event: 'outbound.finished',
          ...context,
          durationMs: performance.now() - started,
          statusCode: response?.status ?? null,
          finalHost: response?.url ? new URL(response.url).hostname : null,
          receivedBodyBytes,
          bodyComplete,
          outcome: response && !response.ok ? 'failed' : outcome,
        },
        report,
      )
    }
    const onAbort = () =>
      finish(
        signal?.reason instanceof Error && signal.reason.name === 'TimeoutError'
          ? 'timeout'
          : 'cancelled',
      )
    reportNetworkDiagnostic({ event: 'outbound.started', ...context }, report)

    try {
      response = await fetcher(input, init)
      if (!response.body) {
        finish('success', true)
        return response
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      return trackResponse(
        response,
        (bytes) => {
          receivedBodyBytes += bytes
        },
        finish,
      )
    } catch (error) {
      if (signal?.aborted) onAbort()
      else finish('failed')
      throw error
    }
  }
}

function describeRequest(
  input: string | URL | Request,
  init?: RequestInit,
): HttpContext {
  const request = input instanceof Request ? input : null
  const url = new URL(input instanceof Request ? input.url : input)
  return {
    requestId: randomUUID(),
    method: init?.method ?? request?.method ?? 'GET',
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    protocol: url.protocol.replace(':', ''),
    vhost: new Headers(init?.headers ?? request?.headers).get('host'),
  }
}

function trackResponse(
  response: Response,
  receive: (bytes: number) => void,
  finish: FinishRequest,
): Response {
  const reader = response.body!.getReader()
  // Count the existing stream, not a clone. These are consumed body bytes,
  // after HTTP decompression, not socket/TLS bytes or installed game bytes.
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            finish('success', true)
            reader.releaseLock()
            controller.close()
          } else {
            receive(value.byteLength)
            controller.enqueue(value)
          }
        } catch (error) {
          finish('failed')
          reader.releaseLock()
          controller.error(error)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          finish('cancelled')
          reader.releaseLock()
        }
      },
    },
    // Do not read ahead just to produce logs.
    { highWaterMark: 0 },
  )
  const tracked = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  // Downloads validate redirects using response.url; preserve that metadata.
  Object.defineProperties(tracked, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  })
  return tracked
}

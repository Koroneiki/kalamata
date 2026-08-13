import http from 'node:http'
import https from 'node:https'
import type { ContentServer } from '../../steam/types.ts'
import { MAX_CHUNK_BYTES } from '../manifests/manifest-utils.ts'

const USER_AGENT = 'Valve/Steam HTTP Client 1.0'
const REQUEST_TIMEOUT_MS = 100_000

export interface ChunkDownloadAgents {
  http: http.Agent
  https: https.Agent
}

export interface ChunkLocation {
  url: string
  vhost: string
}

export class HttpStatusError extends Error {
  constructor(
    readonly statusCode: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`HTTP ${statusCode}`)
    this.name = 'HttpStatusError'
  }
}

export function downloadChunkData(
  url: string,
  vhost: string,
  signal?: AbortSignal,
  agents?: ChunkDownloadAgents,
): Promise<Buffer> {
  const parsed = new URL(url)
  const mod = parsed.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    let settled = false
    let response: http.IncomingMessage | undefined
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const fail = (cause: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(cause)
    }
    const cancel = (cause: unknown) => {
      fail(cause)
      response?.destroy()
      req.destroy()
    }
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { Host: vhost, 'User-Agent': USER_AGENT },
        agent: parsed.protocol === 'https:' ? agents?.https : agents?.http,
      },
      (res) => {
        response = res
        if (res.statusCode !== 200) {
          res.resume()
          fail(
            new HttpStatusError(
              res.statusCode ?? 0,
              parseRetryAfter(res.headers['retry-after']),
            ),
          )
          return
        }
        const contentLength = Number(res.headers['content-length'])
        if (Number.isFinite(contentLength) && contentLength > MAX_CHUNK_BYTES) {
          cancel(new Error(`Chunk response exceeds ${MAX_CHUNK_BYTES} bytes`))
          return
        }

        const chunks: Buffer[] = []
        let received = 0

        res.on('data', (chunk: Buffer) => {
          if (settled) return
          received += chunk.length
          if (received > MAX_CHUNK_BYTES) {
            cancel(new Error(`Chunk response exceeds ${MAX_CHUNK_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          cleanup()
          resolve(Buffer.concat(chunks, received))
        })
        res.on('error', fail)
      },
    )

    const onAbort = () => {
      const reason = signal?.reason ?? new DOMException('Aborted', 'AbortError')
      // Destroy both objects so cancellation also closes an active response body.
      cancel(reason)
    }
    req.on('error', fail)
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      cancel(new Error(`HTTP request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
    )
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.end()
  })
}

function parseRetryAfter(value: string | string[] | undefined): number | null {
  const text = Array.isArray(value) ? value[0] : value
  if (!text) return null
  if (/^\d+$/u.test(text))
    return Math.min(Number(text) * 1000, REQUEST_TIMEOUT_MS)
  const date = Date.parse(text)
  return Number.isNaN(date)
    ? null
    : Math.min(Math.max(0, date - Date.now()), REQUEST_TIMEOUT_MS)
}

export function buildChunkUrl(
  server: ContentServer,
  depotId: number,
  chunkSha1: string,
  token?: string,
): ChunkLocation {
  const protocol = server.https_support === 'mandatory' ? 'https://' : 'http://'
  const host = server.Host
  const vhost = contentServerVhost(server)
  const url = `${protocol}${host}/depot/${depotId}/chunk/${chunkSha1.toLowerCase()}${token ?? ''}`
  return { url, vhost }
}

export function contentServerVhost(server: ContentServer): string {
  return server.vhost || server.Host
}

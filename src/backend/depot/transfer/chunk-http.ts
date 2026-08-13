import type { ContentServer } from '../../steam/types.ts'
import { MAX_CHUNK_BYTES } from '../manifests/manifest-utils.ts'

const USER_AGENT = 'Valve/Steam HTTP Client 1.0'
const REQUEST_TIMEOUT_MS = 100_000

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
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  return fetchChunkData(url, vhost, signal, fetcher)
}

async function fetchChunkData(
  url: string,
  vhost: string,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch,
): Promise<Buffer> {
  const controller = new AbortController()
  const onAbort = () =>
    controller.abort(
      signal?.reason ?? new DOMException('Aborted', 'AbortError'),
    )
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  let timeout: ReturnType<typeof setTimeout>
  const resetTimeout = () => {
    clearTimeout(timeout)
    timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`HTTP request timed out after ${REQUEST_TIMEOUT_MS}ms`),
        ),
      REQUEST_TIMEOUT_MS,
    )
  }
  resetTimeout()

  try {
    // Use Bun's native transport; its node:http compatibility path has failed
    // consistently for Steam chunk requests in packaged Windows builds.
    const response = await fetcher(url, {
      headers: { Host: vhost, 'User-Agent': USER_AGENT },
      signal: controller.signal,
    })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new HttpStatusError(
        response.status,
        parseRetryAfter(response.headers.get('retry-after')),
      )
    }

    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_CHUNK_BYTES) {
      await response.body?.cancel()
      throw new Error(`Chunk response exceeds ${MAX_CHUNK_BYTES} bytes`)
    }
    if (!response.body) return Buffer.alloc(0)

    const chunks: Buffer[] = []
    const reader = response.body.getReader()
    let received = 0
    while (true) {
      const result = await reader.read()
      if (result.done) break
      resetTimeout()
      received += result.value.byteLength
      if (received > MAX_CHUNK_BYTES) {
        await reader.cancel()
        throw new Error(`Chunk response exceeds ${MAX_CHUNK_BYTES} bytes`)
      }
      chunks.push(Buffer.from(result.value))
    }
    return Buffer.concat(chunks, received)
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timeout!)
    signal?.removeEventListener('abort', onAbort)
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  if (/^\d+$/u.test(value))
    return Math.min(Number(value) * 1000, REQUEST_TIMEOUT_MS)
  const date = Date.parse(value)
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

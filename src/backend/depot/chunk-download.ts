import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { createRequire } from 'node:module'
import { lzma } from '@napi-rs/lzma'
import type { ContentServer } from '../steam/types.ts'
import { MAX_CHUNK_BYTES } from './manifest-utils.ts'

const USER_AGENT = 'Valve/Steam HTTP Client 1.0'
const REQUEST_TIMEOUT_MS = 100_000

export interface ChunkDownloadAgents {
  http: http.Agent
  https: https.Agent
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

const _require = createRequire(import.meta.url)
const _symmetricDecrypt: (data: Buffer, key: Buffer) => Buffer = _require(
  '@doctormckay/steam-crypto',
).symmetricDecrypt
const AdmZip = _require('adm-zip') as new (data: Buffer) => {
  getEntries(): Array<{ header?: { size?: number } }>
  readFile(entry: unknown): Buffer | null
}

export async function processChunkData(
  encryptedData: Buffer,
  key: Buffer,
  expectedSha1: string,
  expectedSize?: number,
): Promise<Buffer> {
  if (
    expectedSize !== undefined &&
    (!Number.isSafeInteger(expectedSize) ||
      expectedSize < 1 ||
      expectedSize > MAX_CHUNK_BYTES)
  ) {
    throw new Error(`Invalid expected size for chunk ${expectedSha1}`)
  }
  const decrypted = _symmetricDecrypt(encryptedData, key)
  const decompressed = decompress(decrypted, expectedSize)
  if (expectedSize !== undefined && decompressed.length !== expectedSize) {
    throw new Error(
      `Chunk ${expectedSha1} has size ${decompressed.length}, expected ${expectedSize}`,
    )
  }
  const actualSha1 = createHash('sha1').update(decompressed).digest('hex')
  if (actualSha1 !== expectedSha1.toLowerCase()) {
    throw new Error(`SHA1 mismatch for chunk ${expectedSha1}`)
  }
  return decompressed
}

function decompress(data: Buffer, expectedSize?: number): Buffer {
  // Decode each Steam container format directly rather than delegating to
  // steam-user's compression helper.
  if (data.length >= 23 && data.subarray(0, 4).toString('utf8') === 'VSZa') {
    const footerOffset = data.length - 15
    if (data.subarray(data.length - 3).toString('utf8') !== 'zsv') {
      throw new Error("Zstd: Didn't see expected footer")
    }

    const expectedCrc = data.readUInt32LE(footerOffset)
    const declaredSize = data.readUInt32LE(footerOffset + 4)
    validateDeclaredSize('Zstd', declaredSize, expectedSize)
    const result = Bun.zstdDecompressSync(data.subarray(8, footerOffset))
    if (result.length !== declaredSize)
      throw new Error('Zstd: Decompressed size was not valid')
    if (Bun.hash.crc32(result) >>> 0 !== expectedCrc)
      throw new Error('Zstd: CRC check failed on decompressed data')
    return result
  }

  if (data.subarray(0, 3).toString('utf8') === 'VZa')
    return decompressVzip(data, expectedSize)
  if (data.subarray(0, 4).toString('binary') === 'PK\x03\x04')
    return decompressZip(data, expectedSize)
  throw new Error(
    `Unknown compression type: ${data.subarray(0, 4).toString('hex')}`,
  )
}

function decompressZip(data: Buffer, expectedSize?: number): Buffer {
  const archive = new AdmZip(data)
  const entry = archive.getEntries()[0]
  if (!entry) throw new Error('ZIP chunk contains no entries')
  if (typeof entry.header?.size === 'number')
    validateDeclaredSize('ZIP', entry.header.size, expectedSize)
  const result = archive.readFile(entry)
  if (!result) throw new Error('ZIP chunk could not be decompressed')
  return result
}

function decompressVzip(data: Buffer, manifestSize?: number): Buffer {
  if (
    data.length < 22 ||
    data.subarray(data.length - 2).toString('utf8') !== 'zv'
  ) {
    throw new Error("VZip: Didn't see expected footer")
  }

  const footerOffset = data.length - 10
  const expectedCrc = data.readUInt32LE(footerOffset)
  const expectedSize = data.readUInt32LE(footerOffset + 4)
  validateDeclaredSize('VZip', expectedSize, manifestSize)
  // Steam VZip omits the standard LZMA-alone 8-byte size field. Reinsert it
  // between the five property bytes and compressed payload for the native decoder.
  const properties = data.subarray(7, 12)
  // Buffer.alloc leaves the high 32 bits zero; supported chunk sizes fit in the low word.
  const size = Buffer.alloc(8)
  size.writeUInt32LE(expectedSize)
  const compressed = Buffer.concat([
    properties,
    size,
    data.subarray(12, footerOffset),
  ])
  const result = lzma.decompressSync(compressed)
  if (result.length !== expectedSize)
    throw new Error('VZip: Decompressed size was not valid')
  if (Bun.hash.crc32(result) >>> 0 !== expectedCrc) {
    throw new Error('VZip: CRC check failed on decompressed data')
  }
  return result
}

function validateDeclaredSize(
  format: string,
  declaredSize: number,
  expectedSize?: number,
): void {
  if (declaredSize < 1 || declaredSize > MAX_CHUNK_BYTES) {
    throw new Error(
      `${format}: Declared size exceeds the supported chunk limit`,
    )
  }
  if (expectedSize !== undefined && declaredSize !== expectedSize) {
    throw new Error(`${format}: Declared size does not match the manifest`)
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
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const cancel = (error: unknown) => {
      fail(error)
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
): { url: string; vhost: string } {
  const protocol = server.https_support === 'mandatory' ? 'https://' : 'http://'
  const host = server.Host
  const vhost = contentServerVhost(server)
  const url = `${protocol}${host}/depot/${depotId}/chunk/${chunkSha1.toLowerCase()}${token ?? ''}`
  return { url, vhost }
}

export function contentServerVhost(server: ContentServer): string {
  return server.vhost || server.Host
}

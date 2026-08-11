import { afterEach, expect, test } from 'bun:test'
import { createServer, type RequestListener, type Server } from 'node:http'
import {
  HttpStatusError,
  downloadChunkData,
} from '../src/backend/depot/chunk-download.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

test('returns structured HTTP status errors', async () => {
  const url = await listen((_request, response) => {
    response.writeHead(403, { 'Retry-After': '7' })
    response.end()
  })

  const error = await downloadChunkData(url, 'cdn.example.test').catch(
    (reason) => reason,
  )
  expect(error).toBeInstanceOf(HttpStatusError)
  expect((error as HttpStatusError).statusCode).toBe(403)
  expect((error as HttpStatusError).retryAfterMs).toBe(7_000)
})

test('caps Retry-After at the request timeout before rotating servers', async () => {
  const url = await listen((_request, response) => {
    response.writeHead(503, { 'Retry-After': '999999999999' })
    response.end()
  })

  const error = await downloadChunkData(url, 'cdn.example.test').catch(
    (reason) => reason,
  )
  expect(error).toBeInstanceOf(HttpStatusError)
  expect((error as HttpStatusError).retryAfterMs).toBe(100_000)
})

test('honors an already-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort(new DOMException('stopped', 'AbortError'))

  await expect(
    downloadChunkData(
      'http://127.0.0.1:1/chunk',
      'cdn.example.test',
      controller.signal,
    ),
  ).rejects.toThrow('stopped')
})

test('aborts while a response body is still streaming', async () => {
  let responseStarted!: () => void
  const started = new Promise<void>((resolve) => {
    responseStarted = resolve
  })
  const url = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Length': '100' })
    response.write('partial')
    responseStarted()
  })
  const controller = new AbortController()
  const download = downloadChunkData(url, 'cdn.example.test', controller.signal)

  await started
  await Bun.sleep(10)
  controller.abort(new DOMException('cancelled', 'AbortError'))

  await expect(download).rejects.toThrow('cancelled')
})

test('rejects oversized response bodies', async () => {
  const url = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Length': String(64 * 1024 * 1024 + 1) })
    response.end()
  })

  await expect(downloadChunkData(url, 'cdn.example.test')).rejects.toThrow(
    'Chunk response exceeds',
  )
})

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Test server did not bind to TCP')
  return `http://127.0.0.1:${address.port}/chunk`
}

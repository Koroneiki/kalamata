import { expect, test } from 'bun:test'
import { ChunkNetworkDiagnostics } from '../src/backend/shared/chunk-network-diagnostics.ts'
import type { NetworkDiagnostic } from '../src/backend/shared/network-diagnostics.ts'
import { SteamContentClient } from '../src/backend/depot/transfer/steam-content-client.ts'
import type { SteamContentUser } from '../src/backend/steam/types.ts'

test('many parallel chunk requests emit only one summary per server at download end', async () => {
  const events: NetworkDiagnostic[] = []
  const network = new ChunkNetworkDiagnostics(
    440,
    (event) => events.push(event),
    async () => new Response('chunk'),
  )
  // Enough requests to distinguish per-request logging from server aggregation.
  await Promise.all(
    Array.from({ length: 200 }, async (_, index) => {
      const response = await network.fetch(
        `https://cdn${index % 2}.example.com/depot/1/chunk/SECRET?token=SECRET`,
      )
      expect(await response.text()).toBe('chunk')
    }),
  )
  expect(events).toHaveLength(0)
  network.flush()
  expect(events).toHaveLength(2)
  expect(events).toMatchObject([
    {
      event: 'download.cdn-summary',
      appId: 440,
      requests: 100,
      receivedBodyBytes: 500,
      outcomes: { success: 100 },
    },
    {
      event: 'download.cdn-summary',
      appId: 440,
      requests: 100,
      receivedBodyBytes: 500,
      outcomes: { success: 100 },
    },
  ])
  const summaries = events.filter(
    (event) => event.event === 'download.cdn-summary',
  )
  expect(summaries[0]!.downloadId).toBe(summaries[1]!.downloadId)
  expect(JSON.stringify(events)).not.toContain('SECRET')
  network.flush()
  expect(events).toHaveLength(2)
})

test('summaries retain partial bytes, HTTP failures, retries, cancellations and timeouts', async () => {
  const events: NetworkDiagnostic[] = []
  let attempt = 0
  const failure = new Error('SECRET')
  const network = new ChunkNetworkDiagnostics(
    440,
    (event) => events.push(event),
    async () => {
      switch (attempt++) {
        case 0:
          return new Response('unavailable', { status: 503 })
        case 1: {
          let read = false
          return new Response(
            new ReadableStream(
              {
                pull(controller) {
                  if (read) controller.error(failure)
                  else {
                    read = true
                    controller.enqueue(new Uint8Array(3))
                  }
                },
              },
              { highWaterMark: 0 },
            ),
          )
        }
        case 2:
          return new Response('ok')
        case 3:
          throw failure
        default:
          return new Response('unread')
      }
    },
  )
  const url = 'https://cdn.example.com/depot/1/chunk/SECRET'
  await (await network.fetch(url)).body!.cancel()
  await expect((await network.fetch(url)).arrayBuffer()).rejects.toBe(failure)
  await (await network.fetch(url)).text()
  await expect(network.fetch(url)).rejects.toBe(failure)
  const abort = new AbortController()
  const response = await network.fetch(url, { signal: abort.signal })
  abort.abort(new DOMException('SECRET', 'TimeoutError'))
  await response.body!.cancel()
  await (await network.fetch(url)).body!.cancel()
  expect(events).toHaveLength(0)
  network.flush()
  expect(events).toMatchObject([
    {
      event: 'download.cdn-summary',
      requests: 6,
      receivedBodyBytes: 5,
      outcomes: { success: 1, failed: 3, timeout: 1, cancelled: 1 },
      statusCodes: { '200': 4, '503': 1 },
    },
  ])
  expect(JSON.stringify(events)).not.toContain('SECRET')
})

test('content clients share counters across depots and flush failed downloads on disposal', async () => {
  const events: NetworkDiagnostic[] = []
  const network = new ChunkNetworkDiagnostics(
    440,
    (event) => events.push(event),
    async () => new Response(null, { status: 404 }),
  )
  // HTTP failure never reaches the Steam user or chunk decoder.
  const user = {} as SteamContentUser
  const first = new SteamContentClient(user, Buffer.alloc(32), network)
  const second = new SteamContentClient(user, Buffer.alloc(32), network)
  const server = {
    Host: 'cdn.example.com',
    vhost: 'cdn.example.com',
    https_support: 'mandatory' as const,
  }
  await expect(first.downloadChunk(440, 1, 'SECRET', server)).rejects.toThrow(
    'HTTP 404',
  )
  await expect(second.downloadChunk(440, 2, 'SECRET', server)).rejects.toThrow(
    'HTTP 404',
  )
  expect(events).toHaveLength(0)
  first.dispose()
  second.dispose()
  expect(events).toMatchObject([
    {
      event: 'download.cdn-summary',
      requests: 2,
      outcomes: { failed: 2 },
      statusCodes: { '404': 2 },
    },
  ])
})

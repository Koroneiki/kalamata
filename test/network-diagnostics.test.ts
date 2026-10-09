import { expect, test } from 'bun:test'
import {
  createDiagnosticFetch,
  type NetworkDiagnostic,
} from '../src/backend/shared/network-diagnostics.ts'

function finished(events: NetworkDiagnostic[]) {
  return events.filter((event) => event.event === 'outbound.finished')
}

test('logs completion only after consumption and counts UTF-8 body bytes', async () => {
  const events: NetworkDiagnostic[] = []
  const payload = JSON.stringify({ text: 'Grüße' })
  const fetcher = createDiagnosticFetch(
    (event) => events.push(event),
    async () =>
      new Response(payload, {
        headers: { 'content-type': 'application/json' },
      }),
  )

  const response = await fetcher('https://example.com/api')
  expect(finished(events)).toHaveLength(0)
  expect(await response.json()).toEqual({ text: 'Grüße' })
  expect(finished(events)).toMatchObject([
    {
      outcome: 'success',
      receivedBodyBytes: Buffer.byteLength(payload),
      bodyComplete: true,
    },
  ])
  expect(events[0]?.event).toBe('outbound.started')
  expect(events[0]).toMatchObject({ requestId: finished(events)[0]?.requestId })
})

test('counts partial transfers when a stream fails without logging its error payload', async () => {
  const events: NetworkDiagnostic[] = []
  let reads = 0
  const failure = new Error('https://example.com/private?token=SECRET')
  const fetcher = createDiagnosticFetch(
    (event) => events.push(event),
    async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]))
              else controller.error(failure)
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  )
  const response = await fetcher(
    'https://example.com/private/SECRET?token=SECRET',
    {
      headers: { Authorization: 'Bearer SECRET' },
    },
  )
  expect(reads).toBe(0)
  await expect(response.arrayBuffer()).rejects.toBe(failure)
  expect(finished(events)).toMatchObject([
    { outcome: 'failed', receivedBodyBytes: 3, bodyComplete: false },
  ])
  expect(JSON.stringify(events)).not.toContain('SECRET')
})

test('records a single cancellation with the already consumed bytes', async () => {
  const events: NetworkDiagnostic[] = []
  const abort = new AbortController()
  const fetcher = createDiagnosticFetch(
    (event) => events.push(event),
    async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              controller.enqueue(new Uint8Array([1, 2]))
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  )
  const response = await fetcher('https://example.com/download', {
    signal: abort.signal,
  })
  const reader = response.body!.getReader()
  await reader.read()
  abort.abort()
  await reader.cancel()
  expect(finished(events)).toMatchObject([
    { outcome: 'cancelled', receivedBodyBytes: 2, bodyComplete: false },
  ])
})

test('distinguishes timeouts and honors a Request input abort signal', async () => {
  const events: NetworkDiagnostic[] = []
  const abort = new AbortController()
  const fetcher = createDiagnosticFetch(
    (event) => events.push(event),
    async () => new Response('unread'),
  )
  const response = await fetcher(
    new Request('https://example.com/download', {
      signal: abort.signal,
      headers: { Host: 'cdn.example.com', Authorization: 'Bearer SECRET' },
    }),
  )
  abort.abort(new DOMException('SECRET', 'TimeoutError'))
  await response.body!.cancel()
  expect(finished(events)).toMatchObject([
    {
      outcome: 'timeout',
      receivedBodyBytes: 0,
      bodyComplete: false,
      vhost: 'cdn.example.com',
    },
  ])
  expect(JSON.stringify(events)).not.toContain('SECRET')
})

test('reports HTTP failures even when their body is discarded', async () => {
  const events: NetworkDiagnostic[] = []
  const fetcher = createDiagnosticFetch(
    (event) => events.push(event),
    async () => new Response('not available', { status: 503 }),
  )
  const response = await fetcher('https://example.com/download')
  await response.body!.cancel()
  expect(finished(events)).toMatchObject([
    {
      outcome: 'failed',
      statusCode: 503,
      receivedBodyBytes: 0,
      bodyComplete: false,
    },
  ])
})

test('records transport failures and empty responses', async () => {
  const events: NetworkDiagnostic[] = []
  const failure = new Error('connection failed with SECRET')
  const failing = createDiagnosticFetch(
    (event) => events.push(event),
    async () => {
      throw failure
    },
  )
  await expect(failing('https://example.com')).rejects.toBe(failure)
  const empty = createDiagnosticFetch(
    (event) => events.push(event),
    async () => new Response(null, { status: 204 }),
  )
  expect((await empty('https://example.com')).status).toBe(204)
  expect(finished(events)).toMatchObject([
    {
      outcome: 'failed',
      statusCode: null,
      receivedBodyBytes: 0,
      bodyComplete: false,
    },
    {
      outcome: 'success',
      statusCode: 204,
      receivedBodyBytes: 0,
      bodyComplete: true,
    },
  ])
  expect(JSON.stringify(events)).not.toContain('SECRET')
})

test('keeps parallel requests and retries independently identifiable', async () => {
  const events: NetworkDiagnostic[] = []
  let attempt = 0
  const fetcher = createDiagnosticFetch(
    (event) => events.push(event),
    async () =>
      attempt++ === 0
        ? new Response('failure', { status: 500 })
        : new Response('ok'),
  )
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      const response = await fetcher('https://example.com/download')
      await response.text()
    }),
  )
  const ends = finished(events)
  expect(ends).toHaveLength(3)
  expect(new Set(ends.map((event) => event.requestId)).size).toBe(3)
  expect(
    ends.reduce((bytes, event) => bytes + event.receivedBodyBytes, 0),
  ).toBe(11)
})

test('preserves redirect metadata and streaming with native Bun fetch', async () => {
  const events: NetworkDiagnostic[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      return url.pathname === '/redirect'
        ? Response.redirect(`${url.origin}/download?token=SECRET`)
        : new Response('download')
    },
  })
  try {
    const fetcher = createDiagnosticFetch((event) => events.push(event))
    const response = await fetcher(new URL('/redirect', server.url))
    expect(response.redirected).toBe(true)
    expect(response.url).toContain('/download?token=SECRET')
    expect(await response.text()).toBe('download')
    expect(finished(events)).toMatchObject([
      {
        outcome: 'success',
        receivedBodyBytes: 8,
        finalHost: server.url.hostname,
      },
    ])
    expect(JSON.stringify(events)).not.toContain('SECRET')
  } finally {
    await server.stop(true)
  }
})

test('native streaming abort keeps the partial byte count and original read failure', async () => {
  const events: NetworkDiagnostic[] = []
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'))
          },
        }),
      )
    },
  })
  try {
    const abort = new AbortController()
    const fetcher = createDiagnosticFetch((event) => events.push(event))
    const response = await fetcher(server.url, { signal: abort.signal })
    const reader = response.body!.getReader()
    expect((await reader.read()).value?.byteLength).toBe(7)
    const pending = reader.read()
    abort.abort()
    await expect(pending).rejects.toThrow()
    expect(finished(events)).toMatchObject([
      { outcome: 'cancelled', receivedBodyBytes: 7, bodyComplete: false },
    ])
  } finally {
    await server.stop(true)
  }
})

test('an explicit null signal overrides the Request signal', async () => {
  const events: NetworkDiagnostic[] = []
  const abort = new AbortController()
  abort.abort()
  const fetcher = createDiagnosticFetch(
    (event) => events.push(event),
    async () => new Response('ok'),
  )
  const response = await fetcher(
    new Request('https://example.com', {
      signal: abort.signal,
    }),
    { signal: null },
  )
  expect(await response.text()).toBe('ok')
  expect(finished(events)).toMatchObject([
    { outcome: 'success', bodyComplete: true },
  ])
})

test('a failing diagnostic sink cannot interrupt a transfer', async () => {
  const fetcher = createDiagnosticFetch(
    () => {
      throw new Error('log unavailable')
    },
    async () => new Response('ok'),
  )
  expect(await (await fetcher('https://example.com')).text()).toBe('ok')
})

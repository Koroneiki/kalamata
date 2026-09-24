import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHttpTransfer } from '../../src/backend/downloads/http-transfer.ts'

test('cancels the response stream when a transfer exceeds its allowed size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'http-transfer-'))
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(20))
    },
    cancel() {
      cancelled = true
    },
  })
  try {
    await expect(
      writeHttpTransfer({
        response: new Response(body),
        workspace: root,
        filename: 'download',
        signal: new AbortController().signal,
        maxBytes: 1,
      }),
    ).rejects.toThrow('Download is too large')
    expect(cancelled).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

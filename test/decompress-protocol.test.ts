import { expect, test } from 'bun:test'
import {
  workerRequestSchema,
  workerResponseSchema,
} from '../src/backend/depot/transfer/decompress-protocol.ts'

test('validates worker buffers without replacing them', () => {
  const encrypted = new ArrayBuffer(4)
  const request = workerRequestSchema.parse({
    type: 'process',
    id: 1,
    encrypted,
    expectedSha1: 'hash',
  })

  expect(request.type === 'process' && request.encrypted).toBe(encrypted)
})

test('rejects ambiguous and malformed worker messages', () => {
  expect(
    workerResponseSchema.safeParse({
      id: 1,
      data: new ArrayBuffer(1),
      error: { name: 'Error', message: 'failure' },
    }).success,
  ).toBe(false)
  expect(workerRequestSchema.safeParse({ type: 'unknown' }).success).toBe(false)
})

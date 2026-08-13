import { z } from 'zod'

export interface SerializedError {
  name: string
  message: string
  stack?: string
}

export type WorkerRequest =
  | { type: 'init'; key: Uint8Array }
  | {
      type: 'process'
      id: number
      encrypted: ArrayBuffer
      expectedSha1: string
      expectedSize?: number
    }

export type WorkerResponse =
  | { id: number; data: ArrayBuffer; error?: never }
  | { id: number; data?: never; error: SerializedError }

export const workerRequestSchema: z.ZodType<WorkerRequest> =
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('init'), key: z.instanceof(Uint8Array) }),
    z.strictObject({
      type: z.literal('process'),
      id: z.number().int(),
      encrypted: z.instanceof(ArrayBuffer),
      expectedSha1: z.string(),
      expectedSize: z.number().optional(),
    }),
  ])
const serializedErrorSchema: z.ZodType<SerializedError> = z.strictObject({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
})
export const workerResponseSchema: z.ZodType<WorkerResponse> = z.union([
  z.strictObject({ id: z.number().int(), data: z.instanceof(ArrayBuffer) }),
  z.strictObject({ id: z.number().int(), error: serializedErrorSchema }),
])

export function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  // Transfer only visible bytes because Buffers may be views into a larger shared slab.
  if (data.buffer instanceof ArrayBuffer) {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
      return data.buffer
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
  return Uint8Array.from(data).buffer
}

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error))
    return { name: 'Error', message: String(error) }
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  }
}

export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name
  if (serialized.stack) error.stack = serialized.stack
  return error
}

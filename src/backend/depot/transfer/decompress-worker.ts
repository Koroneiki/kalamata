import { processChunkData } from './chunk-codec.ts'
import {
  exactArrayBuffer,
  serializeError,
  workerRequestSchema,
  type WorkerResponse,
} from './decompress-protocol.ts'

let key: Buffer | undefined

onmessage = async (event: MessageEvent<unknown>) => {
  const message = workerRequestSchema.parse(event.data)
  if (message.type === 'init') {
    key = Buffer.from(message.key)
    return
  }

  try {
    if (!key) throw new Error('Initialize the worker before sending chunks')
    const chunk = await processChunkData(
      Buffer.from(message.encrypted),
      key,
      message.expectedSha1,
      message.expectedSize,
    )
    const data = exactArrayBuffer(chunk)
    postMessage({ id: message.id, data } satisfies WorkerResponse, [data])
  } catch (error) {
    postMessage({
      id: message.id,
      error: serializeError(error),
    } satisfies WorkerResponse)
  }
}

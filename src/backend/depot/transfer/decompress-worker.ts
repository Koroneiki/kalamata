import { processChunkData } from './chunk-codec.ts'
import {
  exactArrayBuffer,
  serializeError,
  type WorkerRequest,
  type WorkerResponse,
} from './decompress-protocol.ts'

let key: Buffer | undefined

onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  if (message.type === 'init') {
    key = Buffer.from(message.key)
    return
  }

  try {
    if (!key) throw new Error('Worker was not initialized')
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

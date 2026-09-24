import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename, join } from 'node:path'

export async function writeHttpTransfer(options: {
  response: Response
  workspace: string
  filename: string
  signal: AbortSignal
  maxBytes?: number
  hash?: 'sha256'
  progress?: (transferred: number, total: number | null) => void
}): Promise<{ path: string; bytes: number; digest: string | null }> {
  const { response, signal } = options
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status})`)
  if (
    basename(options.filename) !== options.filename ||
    options.filename === '..'
  )
    throw new Error('Invalid download filename')
  const path = join(options.workspace, options.filename)
  const handle = await open(path, 'wx')
  const reader = response.body.getReader()
  const stop = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', stop, { once: true })
  const digest = options.hash ? createHash(options.hash) : null
  let bytes = 0
  const length = Number(response.headers.get('content-length'))
  const total =
    Number.isSafeInteger(length) &&
    length >= 0 &&
    response.headers.has('content-length')
      ? length
      : null
  let completed = false
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (
        options.maxBytes !== undefined &&
        bytes + value.byteLength > options.maxBytes
      )
        throw new Error('Download is too large')
      let offset = 0
      while (offset < value.byteLength) {
        signal.throwIfAborted()
        const { bytesWritten } = await handle.write(
          value,
          offset,
          value.byteLength - offset,
        )
        if (!bytesWritten) throw new Error('Download could not be written')
        digest?.update(value.subarray(offset, offset + bytesWritten))
        offset += bytesWritten
        bytes += bytesWritten
        options.progress?.(bytes, total)
      }
    }
    signal.throwIfAborted()
    await handle.sync()
    completed = true
    return { path, bytes, digest: digest?.digest('hex') ?? null }
  } finally {
    signal.removeEventListener('abort', stop)
    if (!completed) await reader.cancel().catch(() => {})
    await handle.close()
  }
}

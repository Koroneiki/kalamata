import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  depotKeyHexSchema,
  steamIdStringSchema,
} from '../../../types/schemas.ts'
import type { JobContext } from '../../downloads/background-download-coordinator.ts'
import { writeHttpTransfer } from '../../downloads/http-transfer.ts'
import { abortable } from '../../shared/abortable.ts'

const SOURCE_URL = 'https://api.993499094.xyz/depotkeys.json'
type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export class DepotKeyCache {
  readonly #path: string
  #contents: Record<string, string> | undefined
  #initialization: Promise<void> | undefined

  constructor(
    dataRoot: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly signal?: AbortSignal,
  ) {
    this.#path = join(dataRoot, 'depot-keys', '993499094.json')
  }

  initialize(context?: JobContext): Promise<void> {
    if (!this.#initialization)
      this.#initialization = this.refresh(context).catch((error) => {
        this.#initialization = undefined
        throw error
      })
    return this.#initialization
  }

  async getKeys(
    depotIds: Iterable<number>,
    context?: JobContext,
  ): Promise<Map<number, string>> {
    await this.initialize(context)
    const keys = new Map<number, string>()
    for (const id of depotIds) {
      const key = this.#contents?.[String(id)]
      if (key) keys.set(id, key)
    }
    return keys
  }

  private async refresh(context?: JobContext): Promise<void> {
    try {
      const existing = await readFile(this.#path, 'utf8')
      this.#contents = parseKeys(existing)
    } catch {
      // A missing or malformed local snapshot must not prevent a fresh download.
    }

    const signal = context?.signal ?? this.signal
    try {
      signal?.throwIfAborted()
      const response = await this.fetcher(SOURCE_URL, { signal })
      if (!response.ok)
        throw new Error(`993499094 download failed (${response.status})`)
      const text =
        context && signal
          ? await writeHttpTransfer({
              response,
              workspace: context.workspace,
              filename: '993499094.json',
              signal,
              progress: (bytes, total) =>
                context.progress('downloading', bytes, total),
            }).then(({ path }) => readFile(path, 'utf8'))
          : await abortable(response.text(), signal)
      const contents = parseKeys(text)
      const temporary = `${this.#path}.tmp`
      try {
        await mkdir(dirname(this.#path), { recursive: true })
        await writeFile(temporary, JSON.stringify(contents), { signal })
        signal?.throwIfAborted()
        context?.beginPublish()
        await rename(temporary, this.#path)
        this.#contents = contents
      } finally {
        await rm(temporary, { force: true })
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (!this.#contents) throw error
    }
  }
}

function parseKeys(text: string) {
  const raw = z.record(z.string(), z.json()).parse(JSON.parse(text))
  const keys: Record<string, string> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!steamIdStringSchema.safeParse(id).success) continue
    const parsed = depotKeyHexSchema.safeParse(value)
    if (parsed.success) keys[id] = parsed.data
  }
  // A provider error payload is not an empty key snapshot.
  if (Object.keys(raw).length > 0 && Object.keys(keys).length === 0)
    throw new Error('993499094 response contains no valid keys')
  return keys
}

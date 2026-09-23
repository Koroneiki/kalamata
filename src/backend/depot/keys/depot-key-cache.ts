import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { depotKeyHexSchema } from '../../../types/schemas.ts'
import type { JobContext } from '../../downloads/background-download-coordinator.ts'
import { writeHttpTransfer } from '../../downloads/http-transfer.ts'

type DepotKeyObject = z.infer<typeof depotKeyObjectSchema>

const DEPOT_KEYS_URL =
  'https://raw.githubusercontent.com/dvahana2424-web/sojogamesdatabase1/main/depotkeys.json'

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export class DepotKeyCache {
  readonly #directory: string
  readonly #path: string
  readonly #metadataPath: string
  readonly #temporaryPath: string
  #initialization: Promise<void> | undefined
  #contents: DepotKeyObject | undefined

  constructor(
    dataRoot: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly signal?: AbortSignal,
  ) {
    this.#directory = join(dataRoot, 'depot-keys')
    this.#path = join(this.#directory, 'depotkeys.json')
    this.#metadataPath = join(this.#directory, 'depotkeys.metadata.json')
    this.#temporaryPath = join(this.#directory, 'depotkeys.json.tmp')
  }

  initialize(context?: JobContext): Promise<void> {
    if (!this.#initialization) {
      this.#initialization = this.ensureFile(context).catch((error) => {
        this.#initialization = undefined
        throw error
      })
    }
    return this.#initialization
  }

  async getKeys(
    depotIds: Iterable<number>,
    context?: JobContext,
  ): Promise<Map<number, string>> {
    await this.initialize(context)
    let contents: DepotKeyObject
    try {
      contents = await this.loadContents()
    } catch (error) {
      if (this.signal?.aborted) throw error
      await rm(this.#path, { force: true })
      this.#contents = undefined
      this.#initialization = undefined
      await this.initialize(context)
      contents = await this.loadContents()
    }

    const keys = new Map<number, string>()
    for (const depotId of depotIds) {
      const value = contents[String(depotId)]
      const result = depotKeyHexSchema.safeParse(value)
      if (result.success) keys.set(depotId, result.data)
    }
    return keys
  }

  private async ensureFile(context?: JobContext): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
    if (context) await rm(this.#temporaryPath, { force: true })
    const exists = await access(this.#path).then(
      () => true,
      () => false,
    )
    const metadata = exists ? await this.loadMetadata() : {}
    const headers: Record<string, string> = {}
    if (metadata.etag) headers['If-None-Match'] = metadata.etag
    if (metadata.lastModified)
      headers['If-Modified-Since'] = metadata.lastModified

    try {
      const signal = context?.signal ?? this.signal
      signal?.throwIfAborted()
      const response = await this.fetcher(DEPOT_KEYS_URL, {
        headers,
        signal,
      })
      if (response.status === 304 && exists) return
      if (!response.ok) {
        throw new Error(`Depot key cache download failed (${response.status})`)
      }
      await this.publishResponse(response, context, signal)
    } catch (error) {
      // A failed refresh must not make an existing validated cache unavailable.
      if (!exists || context?.signal.aborted || this.signal?.aborted)
        throw error
    }
  }

  private async publishResponse(
    response: Response,
    context?: JobContext,
    signal?: AbortSignal,
  ) {
    const temporaryPath = context
      ? join(context.workspace, 'depotkeys.json')
      : this.#temporaryPath
    const text =
      context && signal
        ? await writeHttpTransfer({
            response,
            workspace: context.workspace,
            filename: 'depotkeys.json',
            signal,
            progress: (bytes, total) =>
              context.progress('downloading', bytes, total),
          }).then(({ path }) => readFile(path, 'utf8'))
        : await response.text()
    parseDepotKeyObject(text)
    try {
      if (!context) await writeFile(temporaryPath, text, { signal })
      signal?.throwIfAborted()
      context?.beginPublish()
      await rename(temporaryPath, this.#path)
      await writeFile(
        this.#metadataPath,
        JSON.stringify({
          etag: response.headers.get('etag') ?? undefined,
          lastModified: response.headers.get('last-modified') ?? undefined,
        }),
        { signal },
      )
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private async loadMetadata(): Promise<CacheMetadata> {
    try {
      const value: unknown = JSON.parse(
        await readFile(this.#metadataPath, 'utf8'),
      )
      const result = cacheMetadataSchema.safeParse(value)
      return result.success ? result.data : {}
    } catch {
      return {}
    }
  }

  private async loadContents(): Promise<DepotKeyObject> {
    if (!this.#contents) {
      this.#contents = parseDepotKeyObject(
        await readFile(this.#path, { encoding: 'utf8', signal: this.signal }),
      )
    }
    return this.#contents
  }
}

interface CacheMetadata {
  etag?: string
  lastModified?: string
}

function parseDepotKeyObject(source: string): DepotKeyObject {
  return depotKeyObjectSchema.parse(JSON.parse(source))
}

const depotKeyObjectSchema = z.record(z.string(), z.json())
const optionalMetadataString = z
  .union([z.string(), z.undefined()])
  .catch(undefined)
const cacheMetadataSchema: z.ZodType<CacheMetadata> = z.object({
  etag: optionalMetadataString,
  lastModified: optionalMetadataString,
})

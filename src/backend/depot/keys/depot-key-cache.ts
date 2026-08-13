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
  #contents: Record<string, unknown> | undefined

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

  initialize(): Promise<void> {
    if (!this.#initialization) {
      this.#initialization = this.ensureFile().catch((error) => {
        this.#initialization = undefined
        throw error
      })
    }
    return this.#initialization
  }

  async getKeys(depotIds: Iterable<number>): Promise<Map<number, string>> {
    await this.initialize()
    let contents: Record<string, unknown>
    try {
      contents = await this.loadContents()
    } catch (error) {
      if (this.signal?.aborted) throw error
      await rm(this.#path, { force: true })
      this.#contents = undefined
      this.#initialization = undefined
      await this.initialize()
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

  private async ensureFile(): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
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
      this.signal?.throwIfAborted()
      const response = await this.fetcher(DEPOT_KEYS_URL, {
        headers,
        signal: this.signal,
      })
      if (response.status === 304 && exists) return
      if (!response.ok) {
        throw new Error(`Depot key cache download failed (${response.status})`)
      }
      const text = await response.text()
      parseDepotKeyObject(text)
      try {
        await writeFile(this.#temporaryPath, text, { signal: this.signal })
        this.signal?.throwIfAborted()
        await rename(this.#temporaryPath, this.#path)
        await writeFile(
          this.#metadataPath,
          JSON.stringify({
            etag: response.headers.get('etag') ?? undefined,
            lastModified: response.headers.get('last-modified') ?? undefined,
          }),
          { signal: this.signal },
        )
      } finally {
        await rm(this.#temporaryPath, { force: true })
      }
    } catch (error) {
      // A failed refresh must not make an existing validated cache unavailable.
      if (!exists || this.signal?.aborted) throw error
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

  private async loadContents(): Promise<Record<string, unknown>> {
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

function parseDepotKeyObject(source: string): Record<string, unknown> {
  return depotKeyObjectSchema.parse(JSON.parse(source))
}

const depotKeyObjectSchema = z.record(z.string(), z.unknown())
const optionalMetadataString = z
  .union([z.string(), z.undefined()])
  .catch(undefined)
const cacheMetadataSchema: z.ZodType<CacheMetadata> = z.object({
  etag: optionalMetadataString,
  lastModified: optionalMetadataString,
})

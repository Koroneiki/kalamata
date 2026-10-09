import { createRequire } from 'node:module'
import type { HubcapUsage } from '../../../types/rpc.ts'
import { abortable } from '../../shared/abortable.ts'
import { HubcapClient } from './hubcap-client.ts'

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
interface Source {
  promise: Promise<{ archive: Buffer; usage: HubcapUsage }>
  controller: AbortController
  users: number
}
type ArchiveResult = { archive: Buffer; usage: HubcapUsage }

const require = createRequire(import.meta.url)
// SAFETY: adm-zip is a CommonJS constructor with these methods; archive entries are validated before use.
const AdmZip = require('adm-zip') as new (data: Buffer) => {
  getEntries(): Array<{
    entryName: string
    isDirectory: boolean
  }>
  readFile(entry: { entryName: string }): Buffer | null
}

export class HubcapArchive {
  readonly #client: HubcapClient
  readonly #sources = new Map<string, Source>()
  #recent: { key: string; result: ArchiveResult } | undefined

  constructor(fetcher: Fetcher = fetch) {
    this.#client = new HubcapClient(fetcher)
  }

  has(appId: number, apiKey: string): boolean {
    const key = `${appId}:${apiKey}`
    return this.#sources.has(key) || this.#recent?.key === key
  }

  async get(
    appId: number,
    apiKey: string,
    usage: HubcapUsage | undefined,
    signal: AbortSignal,
  ) {
    const cacheKey = `${appId}:${apiKey}`
    signal.throwIfAborted()
    if (this.#recent?.key === cacheKey) return this.#recent.result
    let source = this.#sources.get(cacheKey)
    if (!source) {
      if (!usage) throw new Error('Hubcap ZIP requires a quota preflight')
      const controller = new AbortController()
      source = {
        controller,
        users: 0,
        promise: (async () => {
          const archive = await this.#client.getManifestZip(
            appId,
            apiKey,
            controller.signal,
          )
          // Do not retain a paid response as a reusable source if it is not a ZIP.
          new AdmZip(archive).getEntries()
          const updated = await this.#client.getUsageAfterRequest(
            apiKey,
            usage,
            controller.signal,
          )
          controller.signal.throwIfAborted()
          const result = { archive, usage: updated }
          // Retain only the last ZIP for the immediate keys-to-manifest handoff.
          this.#recent = { key: cacheKey, result }
          return result
        })().finally(() => {
          if (this.#sources.get(cacheKey)?.controller === controller)
            this.#sources.delete(cacheKey)
        }),
      }
      this.#sources.set(cacheKey, source)
    }
    source.users++
    try {
      return await abortable(source.promise, signal)
    } finally {
      source.users--
      if (source.users === 0 && this.#sources.get(cacheKey) === source) {
        source.controller.abort()
        this.#sources.delete(cacheKey)
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const source of this.#sources.values()) source.controller.abort()
    await Promise.allSettled([...this.#sources.values()].map((x) => x.promise))
    this.#sources.clear()
    this.#recent = undefined
  }
}

export function extractHubcapLua(
  data: Buffer,
  appId: number,
  signal: AbortSignal,
): string | null {
  signal.throwIfAborted()
  const zip = new AdmZip(data)
  const entries = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && entry.entryName === `${appId}.lua`)
  if (entries.length !== 1) return null
  const [entry] = entries
  const body = zip.readFile(entry)
  return body?.toString('utf8') ?? null
}

import type { KalamataDatabase } from '../../../db/database.ts'
import { depotKeyFromHex, validateId } from '../../../db/validation.ts'
import { DepotKeyCache } from './depot-key-cache.ts'
import { parseDepotKeysLua } from './depot-key-lua-parser.ts'

const REPOSITORY_RAW_URL =
  'https://raw.githubusercontent.com/dvahana2424-web/sojogamesdatabase1'

export interface AcquireDepotKeysRequest {
  appId: number
  depotIds: number[]
}

export interface AcquiredDepotKeys {
  acquiredDepotIds: number[]
  missingDepotIds: number[]
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export class DepotKeyAcquisitionService {
  readonly #abortController = new AbortController()
  readonly #cache: DepotKeyCache
  readonly #luaSources = new Map<number, Promise<string | null>>()
  #accepting = true

  constructor(
    private readonly database: KalamataDatabase,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.#cache = new DepotKeyCache(
      database.dataRoot,
      fetcher,
      this.#abortController.signal,
    )
  }

  initializeCache(): Promise<void> {
    return this.#cache.initialize()
  }

  async acquire(request: AcquireDepotKeysRequest): Promise<AcquiredDepotKeys> {
    if (!this.#accepting) {
      throw new Error('Depot key acquisition is shutting down')
    }
    validateId(request.appId, 'appId')
    const depotIds = [...new Set(request.depotIds)]
    for (const depotId of depotIds) validateId(depotId, 'depotId')

    const acquiredDepotIds: number[] = []
    const pending = depotIds.filter((depotId) => {
      const existing = this.database.getDepotKey(depotId)
      if (existing === null) return true
      try {
        depotKeyFromHex(existing)
        acquiredDepotIds.push(depotId)
        return false
      } catch {
        return true
      }
    })

    if (pending.length > 0) {
      const requested = new Set(pending)
      // The base-app Lua source includes keys for its DLC depots as well.
      const lua = await this.getLuaSource(request.appId)
      const luaKeys = lua ? parseDepotKeysLua(lua, requested) : new Map()
      for (const [depotId, key] of luaKeys) {
        this.database.setDepotKey(depotId, key)
        acquiredDepotIds.push(depotId)
        requested.delete(depotId)
      }

      if (requested.size > 0) {
        const cachedKeys = await this.#cache.getKeys(requested)
        for (const [depotId, key] of cachedKeys) {
          this.database.setDepotKey(depotId, key)
          acquiredDepotIds.push(depotId)
          requested.delete(depotId)
        }
      }
    }

    const acquired = new Set(acquiredDepotIds)
    return {
      acquiredDepotIds: depotIds.filter((depotId) => acquired.has(depotId)),
      missingDepotIds: depotIds.filter((depotId) => !acquired.has(depotId)),
    }
  }

  async shutdown(): Promise<void> {
    this.#accepting = false
    this.#abortController.abort(
      new Error('Depot key acquisition was cancelled'),
    )
    await Promise.allSettled(this.#luaSources.values())
  }

  private getLuaSource(appId: number): Promise<string | null> {
    let source = this.#luaSources.get(appId)
    if (!source) {
      source = this.fetchLuaSource(appId)
      this.#luaSources.set(appId, source)
    }
    return source
  }

  private async fetchLuaSource(appId: number): Promise<string | null> {
    try {
      const response = await this.fetcher(
        `${REPOSITORY_RAW_URL}/${appId}/${appId}.lua`,
        { signal: this.#abortController.signal },
      )
      if (!response.ok) return null
      return await response.text()
    } catch (error) {
      if (this.#abortController.signal.aborted) throw error
      return null
    }
  }
}

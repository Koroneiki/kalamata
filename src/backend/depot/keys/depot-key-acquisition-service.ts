import type { KalamataDatabase } from '../../../db/database.ts'
import { depotKeyFromHex, validateId } from '../../../db/validation.ts'
import { acquiredDepotKeysResult } from '../../../utils/depot-key-results.ts'
import type {
  AcquiredDepotKeys,
  AcquireDepotKeysRequest,
  HubcapUsage,
  HubcapUsageResult,
} from '../../../types/rpc.ts'
import { DepotKeyCache } from './depot-key-cache.ts'
import { parseDepotKeysLua } from './depot-key-lua-parser.ts'
import { HubcapClient } from './hubcap-client.ts'

const REPOSITORY_RAW_URL =
  'https://raw.githubusercontent.com/dvahana2424-web/sojogamesdatabase1'

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export class DepotKeyAcquisitionService {
  readonly #abortController = new AbortController()
  readonly #cache: DepotKeyCache
  readonly #luaSources = new Map<number, Promise<string | null>>()
  readonly #hubcapLuaSources = new Map<
    number,
    Promise<{ source: string; usage: HubcapUsage }>
  >()
  readonly #hubcap: HubcapClient
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
    this.#hubcap = new HubcapClient(fetcher)
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

    let hubcap: AcquiredDepotKeys['hubcap']
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

      if (requested.size > 0) {
        const hubcapResult = await this.acquireFromHubcap(request, requested)
        hubcap = hubcapResult.outcome
        for (const [depotId, key] of hubcapResult.keys) {
          this.database.setDepotKey(depotId, key)
          acquiredDepotIds.push(depotId)
          requested.delete(depotId)
        }
      }
    }

    return acquiredDepotKeysResult(depotIds, acquiredDepotIds, hubcap)
  }

  async shutdown(): Promise<void> {
    this.#accepting = false
    this.#abortController.abort(
      new Error('Depot key acquisition was cancelled'),
    )
    await Promise.allSettled([
      ...this.#luaSources.values(),
      ...this.#hubcapLuaSources.values(),
    ])
  }

  // The usage RPC reaches this through SteamService, which Fallow cannot trace.
  // fallow-ignore-next-line unused-class-member
  async getHubcapUsage(): Promise<HubcapUsageResult> {
    const apiKey = this.database.getHubcapApiKey()
    if (!apiKey) return { status: 'missing-key' }
    return this.#hubcap.getUsage(apiKey, this.#abortController.signal)
  }

  private async acquireFromHubcap(
    request: AcquireDepotKeysRequest,
    requested: Set<number>,
  ): Promise<{
    keys: Map<number, string>
    outcome?: NonNullable<AcquiredDepotKeys['hubcap']>
  }> {
    const cached = this.#hubcapLuaSources.get(request.appId)
    if (cached) return this.useHubcapSource(cached, requested)

    const apiKey = this.database.getHubcapApiKey()
    if (!apiKey) return { keys: new Map(), outcome: { status: 'missing-key' } }

    const depotIdsResult = await this.#hubcap.getDepotIds(
      apiKey,
      this.#abortController.signal,
    )
    const availableSource = this.#hubcapLuaSources.get(request.appId)
    if (availableSource) return this.useHubcapSource(availableSource, requested)
    if (depotIdsResult.status === 'invalid-key')
      return { keys: new Map(), outcome: { status: 'invalid-key' } }
    if (depotIdsResult.status === 'unavailable')
      return { keys: new Map(), outcome: { status: 'stats-unavailable' } }

    const availableDepotIds = new Set(
      [...requested].filter((depotId) => depotIdsResult.depotIds.has(depotId)),
    )
    if (availableDepotIds.size === 0) return { keys: new Map() }

    const usageResult = await this.#hubcap.getUsage(
      apiKey,
      this.#abortController.signal,
    )

    const inFlight = this.#hubcapLuaSources.get(request.appId)
    if (inFlight) return this.useHubcapSource(inFlight, requested)

    if (usageResult.status !== 'available')
      return { keys: new Map(), outcome: usageResult }

    const { usage } = usageResult
    if (!usage.canMakeRequests || usage.remaining === 0) {
      return {
        keys: new Map(),
        outcome: { status: 'quota-exhausted', usage },
      }
    }
    if (usage.remaining <= 10 && !request.approveLowQuotaHubcap) {
      return {
        keys: new Map(),
        outcome: { status: 'approval-required', usage },
      }
    }

    const sourcePromise = this.fetchHubcapLua(request.appId, apiKey, usage)
    this.#hubcapLuaSources.set(request.appId, sourcePromise)
    sourcePromise.catch(() => {
      if (this.#hubcapLuaSources.get(request.appId) === sourcePromise)
        this.#hubcapLuaSources.delete(request.appId)
    })
    const result = await sourcePromise
    const keys = parseDepotKeysLua(result.source, availableDepotIds)
    return {
      keys,
      outcome: {
        status: 'fetched',
        usage: result.usage,
        acquiredDepotIds: [...keys.keys()],
      },
    }
  }

  private async useHubcapSource(
    source: Promise<{ source: string; usage: HubcapUsage }>,
    requested: ReadonlySet<number>,
  ): Promise<{
    keys: Map<number, string>
    outcome: NonNullable<AcquiredDepotKeys['hubcap']>
  }> {
    const result = await source
    const keys = parseDepotKeysLua(result.source, requested)
    return {
      keys,
      outcome: {
        status: 'fetched',
        usage: result.usage,
        acquiredDepotIds: [...keys.keys()],
      },
    }
  }

  private async fetchHubcapLua(
    appId: number,
    apiKey: string,
    preflightUsage: HubcapUsage,
  ): Promise<{ source: string; usage: HubcapUsage }> {
    const source = await this.#hubcap.getLua(
      appId,
      apiKey,
      this.#abortController.signal,
    )
    const refreshed = await this.#hubcap.getUsage(
      apiKey,
      this.#abortController.signal,
    )
    const usage =
      refreshed.status === 'available'
        ? refreshed.usage
        : {
            ...preflightUsage,
            dailyUsage: preflightUsage.dailyUsage + 1,
            remaining: Math.max(0, preflightUsage.remaining - 1),
          }
    return { source, usage }
  }

  private getLuaSource(appId: number): Promise<string | null> {
    let source = this.#luaSources.get(appId)
    if (!source) {
      source = this.fetchLuaSource(appId).then(
        (value) => {
          if (value === null && this.#luaSources.get(appId) === source)
            this.#luaSources.delete(appId)
          return value
        },
        (error) => {
          if (this.#luaSources.get(appId) === source)
            this.#luaSources.delete(appId)
          throw error
        },
      )
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

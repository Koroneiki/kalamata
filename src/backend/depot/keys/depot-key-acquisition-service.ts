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
import type { JobContext } from '../../downloads/background-download-coordinator.ts'
import { abortable } from '../../shared/abortable.ts'
import type { BackgroundDownloadCoordinator } from '../../downloads/background-download-coordinator.ts'

const REPOSITORY_RAW_URL =
  'https://raw.githubusercontent.com/dvahana2424-web/sojogamesdatabase1'

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface SharedSource<T> {
  promise: Promise<T>
  controller: AbortController
  users: number
  settled: boolean
}

export class DepotKeyAcquisitionService {
  readonly #abortController = new AbortController()
  readonly #cache: DepotKeyCache
  readonly #luaSources = new Map<number, SharedSource<string | null>>()
  readonly #hubcapLuaSources = new Map<
    number,
    SharedSource<{ source: string; usage: HubcapUsage }>
  >()
  readonly #hubcap: HubcapClient
  #accepting = true

  constructor(
    private readonly database: KalamataDatabase,
    private readonly fetcher: Fetcher = fetch,
    private readonly backgroundDownloads?: BackgroundDownloadCoordinator,
  ) {
    this.#cache = new DepotKeyCache(
      database.dataRoot,
      fetcher,
      this.#abortController.signal,
    )
    this.#hubcap = new HubcapClient(fetcher)
  }

  initializeCache(): Promise<void> {
    return this.backgroundDownloads
      ? this.backgroundDownloads.enqueue({
          key: 'depot-key-cache',
          kind: 'depot-keys',
          title: 'Depot key cache',
          source: 'GitHub: dvahana2424-web/sojogamesdatabase1',
          run: (context) => this.#cache.initialize(context),
        })
      : this.#cache.initialize()
  }

  async acquire(request: AcquireDepotKeysRequest): Promise<AcquiredDepotKeys> {
    return this.acquireWithContext(request)
  }

  async acquireWithContext(
    request: AcquireDepotKeysRequest,
    context?: JobContext,
  ): Promise<AcquiredDepotKeys> {
    if (!this.#accepting) {
      throw new Error('Depot key acquisition is shutting down')
    }
    validateId(request.appId, 'appId')
    const depotIds = [...new Set(request.depotIds)]
    for (const depotId of depotIds) validateId(depotId, 'depotId')

    const acquiredDepotIds: number[] = []
    const signal = context?.signal ?? this.#abortController.signal
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
      context?.setSource('GitHub: dvahana2424-web/sojogamesdatabase1')
      context?.progress('downloading')
      const lua = await this.getLuaSource(request.appId, signal)
      signal.throwIfAborted()
      const luaKeys = lua ? parseDepotKeysLua(lua, requested) : new Map()
      for (const [depotId, key] of luaKeys) {
        this.database.setDepotKey(depotId, key)
        acquiredDepotIds.push(depotId)
        requested.delete(depotId)
      }

      if (requested.size > 0) {
        context?.setSource('GitHub: dvahana2424-web/sojogamesdatabase1')
        const cachedKeys = await abortable(
          this.#cache.getKeys(requested, context),
          signal,
        )
        signal.throwIfAborted()
        for (const [depotId, key] of cachedKeys) {
          this.database.setDepotKey(depotId, key)
          acquiredDepotIds.push(depotId)
          requested.delete(depotId)
        }
      }

      if (requested.size > 0) {
        context?.setSource('Hubcap API')
        const hubcapResult = await this.acquireFromHubcap(
          request,
          requested,
          signal,
        )
        signal.throwIfAborted()
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
    for (const source of [
      ...this.#luaSources.values(),
      ...this.#hubcapLuaSources.values(),
    ])
      source.controller.abort()
    await Promise.allSettled([
      ...[...this.#luaSources.values()].map(({ promise }) => promise),
      ...[...this.#hubcapLuaSources.values()].map(({ promise }) => promise),
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
    signal: AbortSignal,
  ): Promise<{
    keys: Map<number, string>
    outcome?: NonNullable<AcquiredDepotKeys['hubcap']>
  }> {
    const cached = this.#hubcapLuaSources.get(request.appId)
    if (cached)
      return this.useHubcapSource(request.appId, cached, requested, signal)

    const apiKey = this.database.getHubcapApiKey()
    if (!apiKey) return { keys: new Map(), outcome: { status: 'missing-key' } }

    const depotIdsResult = await this.#hubcap.getDepotIds(apiKey, signal)
    const availableSource = this.#hubcapLuaSources.get(request.appId)
    if (availableSource)
      return this.useHubcapSource(
        request.appId,
        availableSource,
        requested,
        signal,
      )
    if (depotIdsResult.status === 'invalid-key')
      return { keys: new Map(), outcome: { status: 'invalid-key' } }
    if (depotIdsResult.status === 'unavailable')
      return { keys: new Map(), outcome: { status: 'stats-unavailable' } }

    const availableDepotIds = new Set(
      [...requested].filter((depotId) => depotIdsResult.depotIds.has(depotId)),
    )
    if (availableDepotIds.size === 0) return { keys: new Map() }

    const usageResult = await this.#hubcap.getUsage(apiKey, signal)

    const inFlight = this.#hubcapLuaSources.get(request.appId)
    if (inFlight)
      return this.useHubcapSource(request.appId, inFlight, requested, signal)

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

    const source = this.sharedSource(
      this.#hubcapLuaSources,
      request.appId,
      (sourceSignal) =>
        this.fetchHubcapLua(request.appId, apiKey, usage, sourceSignal),
    )
    const result = await this.useSource(
      this.#hubcapLuaSources,
      request.appId,
      source,
      signal,
    )
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
    appId: number,
    source: SharedSource<{ source: string; usage: HubcapUsage }>,
    requested: ReadonlySet<number>,
    signal: AbortSignal,
  ): Promise<{
    keys: Map<number, string>
    outcome: NonNullable<AcquiredDepotKeys['hubcap']>
  }> {
    const result = await this.useSource(
      this.#hubcapLuaSources,
      appId,
      source,
      signal,
    )
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
    signal: AbortSignal,
  ): Promise<{ source: string; usage: HubcapUsage }> {
    const source = await this.#hubcap.getLua(appId, apiKey, signal)
    const usage = await this.#hubcap.getUsageAfterRequest(
      apiKey,
      preflightUsage,
      signal,
    )
    return { source, usage }
  }

  private getLuaSource(
    appId: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    let source = this.#luaSources.get(appId)
    if (!source) {
      source = this.sharedSource(this.#luaSources, appId, (sourceSignal) =>
        this.fetchLuaSource(appId, sourceSignal),
      )
    }
    return this.useSource(this.#luaSources, appId, source, signal)
  }

  private async fetchLuaSource(
    appId: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    try {
      const response = await this.fetcher(
        `${REPOSITORY_RAW_URL}/${appId}/${appId}.lua`,
        { signal },
      )
      if (!response.ok) return null
      return await response.text()
    } catch (error) {
      if (signal.aborted) throw error
      return null
    }
  }

  private sharedSource<T>(
    sources: Map<number, SharedSource<T>>,
    appId: number,
    fetchSource: (signal: AbortSignal) => Promise<T>,
  ): SharedSource<T> {
    const controller = new AbortController()
    const source: SharedSource<T> = {
      controller,
      users: 0,
      settled: false,
      promise: fetchSource(controller.signal),
    }
    sources.set(appId, source)
    void source.promise.then(
      (value) => {
        source.settled = true
        if (value === null && sources.get(appId) === source)
          sources.delete(appId)
      },
      () => {
        source.settled = true
        if (sources.get(appId) === source) sources.delete(appId)
      },
    )
    return source
  }

  private async useSource<T>(
    sources: Map<number, SharedSource<T>>,
    appId: number,
    source: SharedSource<T>,
    signal: AbortSignal,
  ): Promise<T> {
    source.users++
    try {
      return await abortable(source.promise, signal)
    } finally {
      source.users--
      if (source.users === 0 && !source.settled) {
        source.controller.abort()
        if (sources.get(appId) === source) sources.delete(appId)
      }
    }
  }
}

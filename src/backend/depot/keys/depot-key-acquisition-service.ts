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
import { GITHUB_REPOSITORIES, githubAppFile } from './github-sources.ts'
import { HubcapArchive, extractHubcapLua } from './hubcap-archive.ts'
import type { JobContext } from '../../downloads/background-download-coordinator.ts'
import { abortable } from '../../shared/abortable.ts'
import { networkFetch } from '../../shared/network-diagnostics.ts'
import type { BackgroundDownloadCoordinator } from '../../downloads/background-download-coordinator.ts'

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface LuaSource {
  promise: Promise<string | null>
  controller: AbortController
  users: number
  settled: boolean
}

export class DepotKeyAcquisitionService {
  readonly #abortController = new AbortController()
  readonly #remote: DepotKeyCache
  readonly #luaSources = new Map<string, LuaSource>()
  readonly #hubcap: HubcapClient
  readonly #archive: HubcapArchive
  #accepting = true

  constructor(
    private readonly database: KalamataDatabase,
    private readonly fetcher: Fetcher = networkFetch,
    private readonly backgroundDownloads?: BackgroundDownloadCoordinator,
    private readonly verifyCandidate: (
      appId: number,
      depotId: number,
      key: Buffer,
      signal: AbortSignal,
    ) => Promise<boolean> = async () => false,
    archive?: HubcapArchive,
  ) {
    this.#remote = new DepotKeyCache(
      database.dataRoot,
      fetcher,
      this.#abortController.signal,
    )
    this.#hubcap = new HubcapClient(fetcher)
    this.#archive = archive ?? new HubcapArchive(fetcher)
  }

  initializeCache(): Promise<void> {
    return this.backgroundDownloads
      ? this.backgroundDownloads.enqueue({
          key: 'depot-key-cache',
          kind: 'depot-keys',
          title: 'Depot key cache',
          source: '993499094',
          run: (context) => this.#remote.initialize(context),
        })
      : this.#remote.initialize()
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
      await this.acquireFromLocal(
        request.appId,
        requested,
        acquiredDepotIds,
        signal,
        context,
      )
      await this.acquireFromGithub(
        request.appId,
        requested,
        acquiredDepotIds,
        signal,
        context,
      )

      if (requested.size > 0) {
        context?.setSource('Hubcap API')
        const hubcapResult = await this.acquireFromHubcap(
          request,
          requested,
          signal,
        )
        signal.throwIfAborted()
        hubcap = hubcapResult.outcome
        await this.publishVerifiedKeys(
          request.appId,
          hubcapResult.keys,
          requested,
          acquiredDepotIds,
          signal,
        )
        if (hubcap?.status === 'fetched') {
          hubcap = {
            ...hubcap,
            acquiredDepotIds: hubcap.acquiredDepotIds.filter((id) =>
              acquiredDepotIds.includes(id),
            ),
          }
        }
      }
    }

    return acquiredDepotKeysResult(depotIds, acquiredDepotIds, hubcap)
  }

  private async acquireFromLocal(
    appId: number,
    requested: Set<number>,
    acquiredDepotIds: number[],
    signal: AbortSignal,
    context?: JobContext,
  ): Promise<void> {
    context?.setSource('993499094')
    try {
      await this.publishVerifiedKeys(
        appId,
        await abortable(this.#remote.getKeys(requested, context), signal),
        requested,
        acquiredDepotIds,
        signal,
      )
    } catch {
      signal.throwIfAborted()
    }
  }

  private async acquireFromGithub(
    appId: number,
    requested: Set<number>,
    acquiredDepotIds: number[],
    signal: AbortSignal,
    context?: JobContext,
  ): Promise<void> {
    // A branch can declare several unrelated depot IDs; never infer depotId = appId + 1.
    for (const repo of GITHUB_REPOSITORIES) {
      if (requested.size === 0) break
      context?.setSource(`GitHub: ${repo}`)
      context?.progress('downloading')
      const lua = await this.getLuaSource(repo, appId, signal)
      signal.throwIfAborted()
      const luaKeys = lua
        ? parseDepotKeysLua(lua, requested)
        : new Map<number, string>()
      await this.publishVerifiedKeys(
        appId,
        luaKeys,
        requested,
        acquiredDepotIds,
        signal,
      )
    }
  }

  private async publishVerifiedKeys(
    appId: number,
    keys: Map<number, string>,
    requested: Set<number>,
    acquiredDepotIds: number[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const [depotId, key] of keys) {
      if (!(await this.isVerified(appId, depotId, key, signal))) continue
      this.database.setDepotKey(depotId, key)
      acquiredDepotIds.push(depotId)
      requested.delete(depotId)
    }
  }

  private async isVerified(
    appId: number,
    depotId: number,
    key: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const verified = await this.verifyCandidate(
        appId,
        depotId,
        depotKeyFromHex(key),
        signal,
      )
      signal.throwIfAborted()
      return verified
    } catch {
      signal.throwIfAborted()
      return false
    }
  }

  async shutdown(): Promise<void> {
    this.#accepting = false
    this.#abortController.abort(
      new Error('Depot key acquisition was cancelled'),
    )
    for (const source of this.#luaSources.values()) source.controller.abort()
    await Promise.allSettled(
      Array.from(this.#luaSources.values(), ({ promise }) => promise),
    )
    await this.#archive.shutdown()
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
    const apiKey = this.database.getHubcapApiKey()
    if (!apiKey) return { keys: new Map(), outcome: { status: 'missing-key' } }

    if (this.#archive.has(request.appId, apiKey))
      return this.useHubcapArchive(request.appId, apiKey, requested, signal)

    const depotIdsResult = await this.#hubcap.getDepotIds(apiKey, signal)
    if (this.#archive.has(request.appId, apiKey))
      return this.useHubcapArchive(request.appId, apiKey, requested, signal)
    if (depotIdsResult.status === 'invalid-key')
      return { keys: new Map(), outcome: { status: 'invalid-key' } }
    if (depotIdsResult.status === 'unavailable')
      return { keys: new Map(), outcome: { status: 'stats-unavailable' } }

    const availableDepotIds = new Set(
      [...requested].filter((depotId) => depotIdsResult.depotIds.has(depotId)),
    )
    if (availableDepotIds.size === 0) return { keys: new Map() }

    const usageResult = await this.#hubcap.getUsage(apiKey, signal)

    if (this.#archive.has(request.appId, apiKey))
      return this.useHubcapArchive(request.appId, apiKey, requested, signal)

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

    return this.useHubcapArchive(
      request.appId,
      apiKey,
      availableDepotIds,
      signal,
      usage,
    )
  }

  private async useHubcapArchive(
    appId: number,
    apiKey: string,
    requested: ReadonlySet<number>,
    signal: AbortSignal,
    usage?: HubcapUsage,
  ): Promise<{
    keys: Map<number, string>
    outcome: NonNullable<AcquiredDepotKeys['hubcap']>
  }> {
    const result = await this.#archive.get(appId, apiKey, usage, signal)
    const lua = extractHubcapLua(result.archive, appId, signal)
    const keys = lua
      ? parseDepotKeysLua(lua, requested)
      : new Map<number, string>()
    return {
      keys,
      outcome: {
        status: 'fetched',
        usage: result.usage,
        acquiredDepotIds: [...keys.keys()],
      },
    }
  }

  private async getLuaSource(
    repo: string,
    appId: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    const cacheKey = `${repo}:${appId}`
    let source = this.#luaSources.get(cacheKey)
    if (!source) {
      const controller = new AbortController()
      source = {
        controller,
        users: 0,
        settled: false,
        promise: this.fetchLuaSource(repo, appId, controller.signal),
      }
      this.#luaSources.set(cacheKey, source)
      const active = source
      void source.promise.then(
        (value) => {
          active.settled = true
          if (value === null && this.#luaSources.get(cacheKey) === active)
            this.#luaSources.delete(cacheKey)
        },
        () => {
          active.settled = true
          if (this.#luaSources.get(cacheKey) === active)
            this.#luaSources.delete(cacheKey)
        },
      )
    }
    source.users++
    try {
      return await abortable(source.promise, signal)
    } finally {
      source.users--
      if (source.users === 0 && !source.settled) {
        source.controller.abort()
        if (this.#luaSources.get(cacheKey) === source)
          this.#luaSources.delete(cacheKey)
      }
    }
  }

  private async fetchLuaSource(
    repo: string,
    appId: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    try {
      const response = await this.fetcher(
        githubAppFile(repo, appId, `${appId}.lua`),
        { signal },
      )
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return null
      }
      return await abortable(response.text(), signal)
    } catch (error) {
      if (signal.aborted) throw error
      return null
    }
  }
}

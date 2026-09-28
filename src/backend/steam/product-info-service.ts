import type { SteamSession } from './steam-session.ts'
import type { ProductInfo, ProductInfoResult } from './types.ts'
import { StoreBrowseClient } from './store-browse-client.ts'
import type SteamUser from 'steam-user'
import { z } from 'zod'
import { steamIdSchema, steamIdStringSchema } from '../../types/schemas.ts'

interface PackageGrant {
  appIds: number[]
  depotIds: number[]
}

interface PackageDiscovery {
  packageIdsByApp: Map<number, number[]>
  grants: Map<number, PackageGrant>
  failedPackageIds: Set<number>
}

// Reuse startup metadata across UI consumers, not indefinitely across a Steam session.
const PRODUCT_REUSE_MS = 60_000

class ProductBatch<T> {
  private readonly pending = new Map<number, Promise<T>>()
  private readonly pendingFresh = new Map<number, Promise<T>>()
  private readonly queue = new Map<
    number,
    { resolve: (value: T) => void; reject: (error: Error) => void }
  >()
  private readonly freshQueue = new Map<
    number,
    { resolve: (value: T) => void; reject: (error: Error) => void }
  >()

  constructor(
    private readonly fetch: (
      ids: number[],
      fresh: boolean,
      epoch: number,
    ) => Promise<Map<number, T>>,
    private readonly currentEpoch: () => number,
  ) {}

  getPending(id: number): Promise<T> | undefined {
    return this.pendingFresh.get(id) ?? this.pending.get(id)
  }

  clear(id?: number): void {
    for (const queue of [this.queue, this.freshQueue]) {
      for (const [queuedId, handlers] of queue) {
        if (id !== undefined && queuedId !== id) continue
        queue.delete(queuedId)
        handlers.reject(new Error('Steam metadata request was invalidated'))
      }
    }
    for (const pending of [this.pending, this.pendingFresh]) {
      if (id === undefined) pending.clear()
      else pending.delete(id)
    }
  }

  request(id: number, fresh: boolean): Promise<T> {
    const existing =
      this.pendingFresh.get(id) ?? (fresh ? undefined : this.pending.get(id))
    if (existing) return existing
    const pending = fresh ? this.pendingFresh : this.pending
    const queue = fresh ? this.freshQueue : this.queue
    const request = new Promise<T>((resolve, reject) => {
      queue.set(id, { resolve, reject })
    })
    pending.set(id, request)
    if (queue.size === 1)
      queueMicrotask(() => {
        const waiting = [...queue]
        queue.clear()
        if (!waiting.length) return
        const requests = new Map(waiting.map(([id]) => [id, pending.get(id)]))
        const epoch = this.currentEpoch()
        void this.fetch(
          waiting.map(([appId]) => appId),
          fresh,
          epoch,
        ).then(
          (results) => {
            for (const [appId, handlers] of waiting) {
              if (pending.get(appId) === requests.get(appId))
                pending.delete(appId)
              const result = results.get(appId)
              if (result) handlers.resolve(result)
              else
                handlers.reject(
                  new Error(
                    `Steam returned no product information for app ${appId}`,
                  ),
                )
            }
          },
          (cause) => {
            for (const [appId, handlers] of waiting) {
              if (pending.get(appId) === requests.get(appId))
                pending.delete(appId)
              handlers.reject(asError(cause))
            }
          },
        )
      })
    return request
  }
}

export class ProductInfoService {
  private readonly base = new Map<number, ProductInfo>()
  private readonly enriched = new Map<number, ProductInfoResult>()
  private readonly baseExpires = new Map<number, number>()
  private readonly enrichedExpires = new Map<number, number>()
  private readonly baseRequestVersion = new Map<number, number>()
  private readonly baseBatch = new ProductBatch(
    (ids: number[], _fresh: boolean, epoch: number) =>
      this.fetchBaseBatch(ids, epoch),
    () => this.epoch,
  )
  private readonly enrichedBatch = new ProductBatch(
    (ids: number[], fresh: boolean, epoch: number) =>
      this.fetchEnrichedBatch(ids, fresh, epoch),
    () => this.epoch,
  )
  private epoch = 0

  constructor(
    private readonly session: Pick<SteamSession, 'getClient'> &
      Partial<Pick<SteamSession, 'onDisconnect'>>,
    private readonly store: Pick<
      StoreBrowseClient,
      'getPackageIds'
    > = new StoreBrowseClient(),
    private readonly reportPackageFailure: (
      appIds: number[],
      countryCode: string,
      error: Error,
    ) => void = () => {},
  ) {
    session.onDisconnect?.(() => this.clear())
  }

  clear(appId?: number): void {
    if (appId === undefined) {
      this.epoch++
      this.base.clear()
      this.enriched.clear()
      this.baseExpires.clear()
      this.enrichedExpires.clear()
      this.baseRequestVersion.clear()
    } else {
      // Keep other apps' in-flight work alive while invalidating this app's response.
      this.baseRequestVersion.set(
        appId,
        (this.baseRequestVersion.get(appId) ?? 0) + 1,
      )
      this.base.delete(appId)
      this.enriched.delete(appId)
      this.baseExpires.delete(appId)
      this.enrichedExpires.delete(appId)
    }
    this.baseBatch.clear(appId)
    this.enrichedBatch.clear(appId)
  }

  async getProductInfo(appId: number, fresh = false): Promise<ProductInfo> {
    validateAppId(appId)
    if (!fresh) {
      const pending = this.baseBatch.getPending(appId)
      if (pending) return pending
      const cached = this.base.get(appId)
      if (cached && (this.baseExpires.get(appId) ?? 0) > Date.now())
        return cached
    }
    return this.baseBatch.request(appId, fresh)
  }

  private async fetchBaseBatch(
    appIds: number[],
    epoch: number,
  ): Promise<Map<number, ProductInfo>> {
    const versions = new Map(
      appIds.map((id) => {
        const version = (this.baseRequestVersion.get(id) ?? 0) + 1
        this.baseRequestVersion.set(id, version)
        return [id, version] as const
      }),
    )
    const client = await this.session.getClient()
    const result = await client.getProductInfo(appIds, [], true)
    const products = new Map<number, ProductInfo>()
    for (const id of appIds) {
      const product = validProductInfo(result, id)
      if (!product) continue
      const previous = this.base.get(id)
      if (
        epoch === this.epoch &&
        versions.get(id) === this.baseRequestVersion.get(id)
      ) {
        if (previous && previous.changenumber !== product.changenumber)
          this.enriched.delete(id)
        this.base.set(id, product)
        this.baseExpires.set(id, Date.now() + PRODUCT_REUSE_MS)
      }
      products.set(id, product)
    }
    return products
  }

  getProductInfoWithDlc(
    appId: number,
    fresh = false,
  ): Promise<ProductInfoResult> {
    validateAppId(appId)
    if (!fresh) {
      const pending = this.enrichedBatch.getPending(appId)
      if (pending) return pending
      const cached = this.enriched.get(appId)
      if (cached && (this.enrichedExpires.get(appId) ?? 0) > Date.now())
        return Promise.resolve(cached)
    }
    return this.enrichedBatch.request(appId, fresh)
  }

  async getProductInfoWithDlcBatch(
    appIds: number[],
    fresh = false,
  ): Promise<Map<number, ProductInfoResult>> {
    for (const appId of appIds) validateAppId(appId)
    const results = await Promise.all(
      appIds.map(async (appId) => {
        try {
          return [
            appId,
            await this.getProductInfoWithDlc(appId, fresh),
          ] as const
        } catch {
          return null
        }
      }),
    )
    return new Map(
      results.filter(
        (result): result is readonly [number, ProductInfoResult] =>
          result !== null,
      ),
    )
  }

  private async fetchEnrichedBatch(
    appIds: number[],
    fresh: boolean,
    epoch: number,
  ): Promise<Map<number, ProductInfoResult>> {
    const basePackageBranch = this.getPackageDiscovery(appIds)
    const baseResult = await Promise.all(
      appIds.map(async (appId) => {
        try {
          return await this.getProductInfo(appId, fresh)
        } catch {
          return null
        }
      }),
    )
    const baseProducts = new Map<number, ProductInfo>()
    const directDlcIds = new Map<number, number[]>()
    const allDlcIds = new Set<number>()

    for (const [index, appId] of appIds.entries()) {
      const baseProduct = baseResult[index]
      if (!baseProduct) continue
      const dlcIds = directDlcAppIds(baseProduct)
      baseProducts.set(appId, baseProduct)
      directDlcIds.set(appId, dlcIds)
      for (const dlcId of dlcIds) allDlcIds.add(dlcId)
    }

    const [fetchedDlcProducts, basePackages, dlcPackages] = await Promise.all([
      this.getDlcProducts([...allDlcIds], fresh),
      basePackageBranch,
      this.getPackageDiscovery([...allDlcIds]),
    ])
    const dlcProducts = new Map(
      fetchedDlcProducts.map((product) => [product.appId, product]),
    )
    const results = new Map(
      appIds.flatMap((appId) => {
        const baseProduct = baseProducts.get(appId)
        if (!baseProduct) return []
        const dlcIds = directDlcIds.get(appId) ?? []
        const appDlcProducts = dlcIds.flatMap((dlcId) => {
          const product = dlcProducts.get(dlcId)
          return product ? [product] : []
        })
        return [
          [
            appId,
            {
              baseProduct,
              listedDlcAppIds: dlcIds,
              dlcProducts: appDlcProducts,
              eligibleBaseDepotIds: eligibleBaseDepotIds(appId, basePackages),
              eligibleDlcDepotIds: eligibleDlcDepotIds(
                baseProduct,
                dlcIds,
                appDlcProducts,
                basePackages,
                dlcPackages,
              ),
            },
          ] as const,
        ]
      }),
    )
    for (const [appId, result] of results) {
      // Incomplete enrichment must remain retryable, without losing valid base data.
      if (
        epoch === this.epoch &&
        this.base.get(appId) === result.baseProduct &&
        basePackages &&
        !hasPackageFailure(appId, basePackages) &&
        dlcPackages &&
        result.listedDlcAppIds.every(
          (id) => !hasPackageFailure(id, dlcPackages),
        ) &&
        result.listedDlcAppIds.length === result.dlcProducts.length
      ) {
        this.enriched.set(appId, result)
        this.enrichedExpires.set(appId, Date.now() + PRODUCT_REUSE_MS)
      }
    }
    return results
  }

  private async getDlcProducts(
    appIds: number[],
    fresh: boolean,
  ): Promise<ProductInfo[]> {
    const products = await Promise.all(
      appIds.map((id) => this.getProductInfo(id, fresh).catch(() => null)),
    )
    // DLC enrichment must not make otherwise valid base metadata unusable.
    return products.filter(
      (product): product is ProductInfo => product !== null,
    )
  }

  private async getPackageDiscovery(
    appIds: number[],
    countryCode = 'US',
  ): Promise<PackageDiscovery | null> {
    if (!appIds.length)
      return {
        packageIdsByApp: new Map(),
        grants: new Map(),
        failedPackageIds: new Set(),
      }
    try {
      const packageIdsByApp = await this.store.getPackageIds(
        appIds,
        countryCode,
      )
      const packageIds = [
        ...new Set([...packageIdsByApp.values()].flatMap((ids) => ids)),
      ]
      if (!packageIds.length)
        return {
          packageIdsByApp,
          grants: new Map(),
          failedPackageIds: new Set(),
        }

      const client = await this.session.getClient()
      const result = await client.getProductInfo([], packageIds, true)
      const grants = new Map<number, PackageGrant>()
      const failedPackageIds = new Set<number>()
      for (const packageId of packageIds) {
        const parsed = packageInfoSchema.safeParse(result.packages[packageId])
        if (!parsed.success || parsed.data.missingToken) {
          failedPackageIds.add(packageId)
          const affected = appIds.filter((appId) =>
            packageIdsByApp.get(appId)?.includes(packageId),
          )
          this.reportPackageFailure(
            affected,
            countryCode,
            new Error(
              `Steam returned incomplete package information for package ${packageId}`,
            ),
          )
          continue
        }
        grants.set(packageId, {
          appIds: parsed.data.packageinfo.appids,
          depotIds: parsed.data.packageinfo.depotids,
        })
      }
      return { packageIdsByApp, grants, failedPackageIds }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      this.reportPackageFailure(appIds, countryCode, error)
      return null
    }
  }
}

function eligibleBaseDepotIds(
  appId: number,
  discovery: PackageDiscovery | null,
): ReadonlySet<number> | null {
  if (!discovery?.packageIdsByApp.has(appId)) return null
  if (hasPackageFailure(appId, discovery)) return null
  const depotIds = new Set<number>()
  for (const packageId of discovery.packageIdsByApp.get(appId) ?? []) {
    const grant = discovery.grants.get(packageId)
    if (!grant?.appIds.includes(appId)) continue
    for (const depotId of grant.depotIds) depotIds.add(depotId)
  }
  return depotIds
}

function hasPackageFailure(
  appId: number,
  discovery: PackageDiscovery,
): boolean {
  return (discovery.packageIdsByApp.get(appId) ?? []).some((id) =>
    discovery.failedPackageIds.has(id),
  )
}

function eligibleDlcDepotIds(
  baseProduct: ProductInfo,
  dlcAppIds: number[],
  dlcProducts: ProductInfo[],
  baseDiscovery: PackageDiscovery | null,
  dlcDiscovery: PackageDiscovery | null,
): ReadonlyMap<number, ReadonlySet<number>> {
  const linkedDepots = dlcDepotsByApp(baseProduct, dlcProducts)
  const result = new Map<number, ReadonlySet<number>>()
  for (const dlcAppId of dlcAppIds) {
    const grants = qualifyingDlcGrants(
      baseProduct.appId,
      dlcAppId,
      baseDiscovery,
      dlcDiscovery,
    )
    if (!grants) continue
    const depotIds = grantedDlcDepots(
      dlcAppId,
      linkedDepots.get(dlcAppId) ?? new Set(),
      grants,
    )
    result.set(dlcAppId, depotIds)
  }
  return result
}

function qualifyingDlcGrants(
  baseAppId: number,
  dlcAppId: number,
  baseDiscovery: PackageDiscovery | null,
  dlcDiscovery: PackageDiscovery | null,
): PackageGrant[] | null {
  // A DLC may only be granted through a base package and have no direct package.
  if (
    !baseDiscovery?.packageIdsByApp.has(baseAppId) ||
    !dlcDiscovery ||
    hasPackageFailure(baseAppId, baseDiscovery) ||
    hasPackageFailure(dlcAppId, dlcDiscovery)
  )
    return null
  const packageIds = new Set([
    ...(baseDiscovery?.packageIdsByApp.get(baseAppId) ?? []),
    ...(dlcDiscovery.packageIdsByApp.get(dlcAppId) ?? []),
  ])
  const grants = [...packageIds].flatMap((packageId) => {
    const grant =
      dlcDiscovery.grants.get(packageId) ?? baseDiscovery?.grants.get(packageId)
    return grant?.appIds.includes(dlcAppId) ? [grant] : []
  })
  return grants.length ? grants : null
}

function grantedDlcDepots(
  dlcAppId: number,
  candidates: ReadonlySet<number>,
  grants: PackageGrant[],
): Set<number> {
  const depotIds = new Set<number>()
  // Steam grants the default DLC depot through the identically numbered app.
  if (candidates.has(dlcAppId)) depotIds.add(dlcAppId)
  for (const grant of grants)
    for (const depotId of grant.depotIds)
      if (candidates.has(depotId)) depotIds.add(depotId)
  return depotIds
}

function dlcDepotsByApp(
  baseProduct: ProductInfo,
  dlcProducts: ProductInfo[],
): Map<number, Set<number>> {
  const result = linkedDlcDepots(baseProduct)
  for (const product of dlcProducts) {
    const current = result.get(product.appId) ?? new Set<number>()
    for (const depotId of productDepotIds(product)) current.add(depotId)
    if (current.size) result.set(product.appId, current)
  }
  return result
}

function linkedDlcDepots(product: ProductInfo): Map<number, Set<number>> {
  const result = new Map<number, Set<number>>()
  const depots = productAppInfoSchema.parse(product.appinfo).depots
  for (const [rawDepotId, rawDepot] of Object.entries(depots ?? {})) {
    const depotId = steamIdStringSchema.safeParse(rawDepotId)
    const depot = dlcDepotSchema.safeParse(rawDepot)
    if (!depotId.success || !depot.success) continue
    const current = result.get(depot.data.dlcappid) ?? new Set<number>()
    current.add(depotId.data)
    result.set(depot.data.dlcappid, current)
  }
  return result
}

function productDepotIds(product: ProductInfo): number[] {
  const depots = productAppInfoSchema.parse(product.appinfo).depots
  return Object.keys(depots ?? {}).flatMap((rawDepotId) => {
    const depotId = steamIdStringSchema.safeParse(rawDepotId)
    return depotId.success ? [depotId.data] : []
  })
}

function requiredProductInfo(
  result: SteamUser.ProductInfo,
  appId: number,
): ProductInfo {
  if (result.unknownApps.includes(appId)) {
    throw new Error(`Steam app ${appId} does not exist`)
  }
  const product = result.apps[appId]
  if (!product) {
    throw new Error(`Steam returned no product information for app ${appId}`)
  }
  return productInfo(appId, product)
}

function validProductInfo(
  result: SteamUser.ProductInfo,
  appId: number,
): ProductInfo | null {
  try {
    return requiredProductInfo(result, appId)
  } catch {
    return null
  }
}

function directDlcAppIds(product: ProductInfo): number[] {
  const parsed = dlcListSchema.safeParse(product.appinfo)
  if (!parsed.success || !parsed.data.extended?.listofdlc) return []
  const listOfDlc = parsed.data.extended.listofdlc

  const result: number[] = []
  const seen = new Set<number>()
  for (const value of listOfDlc.split(',')) {
    const trimmed = value.trim()
    const parsedAppId = steamIdStringSchema.safeParse(trimmed)
    if (!parsedAppId.success || seen.has(parsedAppId.data)) continue
    const appId = parsedAppId.data
    seen.add(appId)
    result.push(appId)
  }
  return result
}

const dlcListSchema = z.looseObject({
  extended: z
    .looseObject({
      listofdlc: z.string().optional(),
    })
    .optional(),
})

function productInfo(
  appId: number,
  product: {
    changenumber: number
    missingToken: boolean
    appinfo: ProductInfo['appinfo']
  },
): ProductInfo {
  if (
    product.missingToken ||
    !productAppInfoSchema.safeParse(product.appinfo).success
  ) {
    throw new Error(
      `Steam returned incomplete product information for app ${appId}`,
    )
  }
  return {
    appId,
    changenumber: product.changenumber,
    missingToken: product.missingToken,
    appinfo: product.appinfo,
  }
}

const productAppInfoSchema = z.looseObject({
  depots: z.record(z.string(), z.json()).optional(),
})
const dlcDepotSchema = z.looseObject({ dlcappid: steamIdStringSchema })
const packageInfoSchema = z.object({
  missingToken: z.boolean(),
  packageinfo: z.object({
    appids: z.array(steamIdSchema),
    depotids: z.array(steamIdSchema),
  }),
})

function validateAppId(appId: number): void {
  if (!steamIdSchema.safeParse(appId).success) {
    throw new Error('appId must be a positive 32-bit integer')
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

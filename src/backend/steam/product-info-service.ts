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
}

export class ProductInfoService {
  constructor(
    private readonly session: Pick<SteamSession, 'getClient'>,
    private readonly store: Pick<
      StoreBrowseClient,
      'getPackageIds'
    > = new StoreBrowseClient(),
    private readonly reportPackageFailure: (
      appIds: number[],
      countryCode: string,
      error: Error,
    ) => void = () => {},
  ) {}

  async getProductInfo(appId: number): Promise<ProductInfo> {
    validateAppId(appId)
    const client = await this.session.getClient()
    const result = await client.getProductInfo([appId], [], true)
    return requiredProductInfo(result, appId)
  }

  async getProductInfoWithDlc(appId: number): Promise<ProductInfoResult> {
    validateAppId(appId)
    const basePackageBranch = this.getPackageDiscovery([appId])
    const baseProduct = await this.getProductInfo(appId)
    const dlcAppIds = directDlcAppIds(baseProduct)
    const [dlcProducts, basePackages, dlcPackages] = await Promise.all([
      this.getDlcProducts(dlcAppIds),
      basePackageBranch,
      this.getPackageDiscovery(dlcAppIds),
    ])
    return {
      baseProduct,
      listedDlcAppIds: dlcAppIds,
      dlcProducts,
      eligibleBaseDepotIds: eligibleBaseDepotIds(appId, basePackages),
      eligibleDlcDepotIds: eligibleDlcDepotIds(
        baseProduct,
        dlcAppIds,
        dlcProducts,
        basePackages,
        dlcPackages,
      ),
    }
  }

  async getProductInfoWithDlcBatch(
    appIds: number[],
  ): Promise<Map<number, ProductInfoResult>> {
    for (const appId of appIds) validateAppId(appId)
    const basePackageBranch = this.getPackageDiscovery(appIds)
    const client = await this.session.getClient()
    const baseResult = await client.getProductInfo(appIds, [], true)
    const baseProducts = new Map<number, ProductInfo>()
    const directDlcIds = new Map<number, number[]>()
    const allDlcIds = new Set<number>()

    for (const appId of appIds) {
      const baseProduct = validProductInfo(baseResult, appId)
      if (!baseProduct) continue
      const dlcIds = directDlcAppIds(baseProduct)
      baseProducts.set(appId, baseProduct)
      directDlcIds.set(appId, dlcIds)
      for (const dlcId of dlcIds) allDlcIds.add(dlcId)
    }

    const [fetchedDlcProducts, basePackages, dlcPackages] = await Promise.all([
      this.getDlcProducts([...allDlcIds]),
      basePackageBranch,
      this.getPackageDiscovery([...allDlcIds]),
    ])
    const dlcProducts = new Map(
      fetchedDlcProducts.map((product) => [product.appId, product]),
    )
    return new Map(
      appIds.flatMap((appId) => {
        const baseProduct = baseProducts.get(appId)
        if (!baseProduct) return []
        const dlcIds = directDlcIds.get(appId) ?? []
        return [
          [
            appId,
            {
              baseProduct,
              listedDlcAppIds: dlcIds,
              dlcProducts: dlcIds.flatMap((dlcId) => {
                const product = dlcProducts.get(dlcId)
                return product ? [product] : []
              }),
              eligibleBaseDepotIds: eligibleBaseDepotIds(appId, basePackages),
              eligibleDlcDepotIds: eligibleDlcDepotIds(
                baseProduct,
                dlcIds,
                dlcIds.flatMap((dlcId) => {
                  const product = dlcProducts.get(dlcId)
                  return product ? [product] : []
                }),
                basePackages,
                dlcPackages,
              ),
            },
          ] as const,
        ]
      }),
    )
  }

  private async getDlcProducts(appIds: number[]): Promise<ProductInfo[]> {
    if (!appIds.length) return []
    const client = await this.session.getClient()
    let result: SteamUser.ProductInfo
    try {
      result = await client.getProductInfo(appIds, [], true)
    } catch {
      // DLC enrichment must not make otherwise valid base metadata unusable.
      return []
    }
    return appIds.flatMap((appId) => {
      const product = validProductInfo(result, appId)
      return product ? [product] : []
    })
  }

  private async getPackageDiscovery(
    appIds: number[],
    countryCode = 'US',
  ): Promise<PackageDiscovery | null> {
    if (!appIds.length) return { packageIdsByApp: new Map(), grants: new Map() }
    try {
      const packageIdsByApp = await this.store.getPackageIds(
        appIds,
        countryCode,
      )
      const packageIds = [
        ...new Set([...packageIdsByApp.values()].flatMap((ids) => ids)),
      ]
      if (!packageIds.length) return { packageIdsByApp, grants: new Map() }

      const client = await this.session.getClient()
      const result = await client.getProductInfo([], packageIds, true)
      const grants = new Map<number, PackageGrant>()
      for (const packageId of packageIds) {
        const parsed = packageInfoSchema.safeParse(result.packages[packageId])
        if (!parsed.success || parsed.data.missingToken)
          throw new Error(
            `Steam returned incomplete package information for package ${packageId}`,
          )
        grants.set(packageId, {
          appIds: parsed.data.packageinfo.appids,
          depotIds: parsed.data.packageinfo.depotids,
        })
      }
      return { packageIdsByApp, grants }
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
  const depotIds = new Set<number>()
  for (const packageId of discovery.packageIdsByApp.get(appId) ?? []) {
    const grant = discovery.grants.get(packageId)
    if (!grant?.appIds.includes(appId)) continue
    for (const depotId of grant.depotIds) depotIds.add(depotId)
  }
  return depotIds.size ? depotIds : null
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
    if (depotIds.size) result.set(dlcAppId, depotIds)
  }
  return result
}

function qualifyingDlcGrants(
  baseAppId: number,
  dlcAppId: number,
  baseDiscovery: PackageDiscovery | null,
  dlcDiscovery: PackageDiscovery | null,
): PackageGrant[] | null {
  if (
    !baseDiscovery?.packageIdsByApp.has(baseAppId) ||
    !dlcDiscovery?.packageIdsByApp.has(dlcAppId)
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

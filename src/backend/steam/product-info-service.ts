import type { SteamSession } from './steam-session.ts'
import type { ProductInfo, ProductInfoResult } from './types.ts'
import type SteamUser from 'steam-user'
import { z } from 'zod'
import { steamIdSchema, steamIdStringSchema } from '../../types/schemas.ts'

export class ProductInfoService {
  constructor(private readonly session: Pick<SteamSession, 'getClient'>) {}

  async getProductInfo(appId: number): Promise<ProductInfo> {
    validateAppId(appId)
    const client = await this.session.getClient()
    const result = await client.getProductInfo([appId], [], true)
    return requiredProductInfo(result, appId)
  }

  async getProductInfoWithDlc(appId: number): Promise<ProductInfoResult> {
    const baseProduct = await this.getProductInfo(appId)
    const dlcAppIds = directDlcAppIds(baseProduct)
    if (!dlcAppIds.length) return { baseProduct, dlcProducts: [] }

    const client = await this.session.getClient()
    const result = await client.getProductInfo(dlcAppIds, [], true)
    return {
      baseProduct,
      dlcProducts: dlcAppIds.map((dlcAppId) =>
        requiredProductInfo(result, dlcAppId),
      ),
    }
  }

  async getProductInfoWithDlcBatch(
    appIds: number[],
  ): Promise<Map<number, ProductInfoResult>> {
    for (const appId of appIds) validateAppId(appId)
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

    const dlcProducts = new Map<number, ProductInfo>()
    const unavailableDlcIds = new Set<number>()
    if (allDlcIds.size) {
      const result = await client.getProductInfo([...allDlcIds], [], true)
      for (const dlcId of allDlcIds) {
        const product = validProductInfo(result, dlcId)
        if (!product) {
          unavailableDlcIds.add(dlcId)
          continue
        }
        dlcProducts.set(dlcId, product)
      }
    }

    return new Map(
      appIds.flatMap((appId) => {
        const baseProduct = baseProducts.get(appId)
        if (!baseProduct) return []
        const dlcIds = directDlcIds.get(appId) ?? []
        if (dlcIds.some((dlcId) => unavailableDlcIds.has(dlcId))) return []
        return [
          [
            appId,
            {
              baseProduct,
              dlcProducts: dlcIds.flatMap((dlcId) => {
                const product = dlcProducts.get(dlcId)
                return product ? [product] : []
              }),
            },
          ] as const,
        ]
      }),
    )
  }
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

const productAppInfoSchema = z.record(z.string(), z.json())

function validateAppId(appId: number): void {
  if (!steamIdSchema.safeParse(appId).success) {
    throw new Error('appId must be a positive 32-bit integer')
  }
}

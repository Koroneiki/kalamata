import type { SteamSession } from './steam-session.ts'
import type { ProductInfo, ProductInfoResult } from './types.ts'

export class ProductInfoService {
  constructor(private readonly session: Pick<SteamSession, 'getClient'>) {}

  async getProductInfo(appId: number): Promise<ProductInfo> {
    validateAppId(appId)
    const client = await this.session.getClient()
    const result = await client.getProductInfo([appId], [], true)

    if (result.unknownApps.includes(appId)) {
      throw new Error(`Steam app ${appId} does not exist`)
    }

    const product = result.apps[appId]
    if (!product) {
      throw new Error(`Steam returned no product information for app ${appId}`)
    }

    return productInfo(appId, product)
  }

  async getProductInfoWithDlc(appId: number): Promise<ProductInfoResult> {
    const baseProduct = await this.getProductInfo(appId)
    const dlcAppIds = directDlcAppIds(baseProduct)
    if (!dlcAppIds.length) return { baseProduct, dlcProducts: [] }

    const client = await this.session.getClient()
    const result = await client.getProductInfo(dlcAppIds, [], true)
    return {
      baseProduct,
      dlcProducts: dlcAppIds.flatMap((dlcAppId) => {
        const product = result.apps[dlcAppId]
        return product ? [productInfo(dlcAppId, product)] : []
      }),
    }
  }
}

function directDlcAppIds(product: ProductInfo): number[] {
  const listOfDlc = (
    product.appinfo as unknown as { extended?: { listofdlc?: unknown } }
  ).extended?.listofdlc
  if (typeof listOfDlc !== 'string') return []

  const result: number[] = []
  const seen = new Set<number>()
  for (const value of listOfDlc.split(',')) {
    const trimmed = value.trim()
    if (!/^[1-9]\d*$/u.test(trimmed)) continue
    const appId = Number(trimmed)
    if (!Number.isInteger(appId) || appId > 0xffffffff || seen.has(appId))
      continue
    seen.add(appId)
    result.push(appId)
  }
  return result
}

function productInfo(
  appId: number,
  product: {
    changenumber: number
    missingToken: boolean
    appinfo: ProductInfo['appinfo']
  },
): ProductInfo {
  return {
    appId,
    changenumber: product.changenumber,
    missingToken: product.missingToken,
    appinfo: product.appinfo,
  }
}

function validateAppId(appId: number): void {
  if (!Number.isInteger(appId) || appId <= 0 || appId > 0xffffffff) {
    throw new Error('appId must be a positive 32-bit integer')
  }
}

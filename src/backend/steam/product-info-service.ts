import type { SteamSession } from './steam-session.ts'
import type { ProductInfo } from './types.ts'

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

    return {
      appId,
      changenumber: product.changenumber,
      missingToken: product.missingToken,
      appinfo: product.appinfo,
    }
  }
}

function validateAppId(appId: number): void {
  if (!Number.isInteger(appId) || appId <= 0 || appId > 0xffffffff) {
    throw new Error('appId must be a positive 32-bit integer')
  }
}

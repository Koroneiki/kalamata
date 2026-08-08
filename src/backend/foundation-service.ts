import type { AppDetails, AppSummary } from '../types/rpc.ts'
import type { KalamataDatabase } from '../db/database.ts'
import type { SteamService } from './index.ts'
import {
  normalizeAppDetails,
  normalizeAppSummary,
} from './steam/product-normalizer.ts'

export class FoundationService {
  constructor(
    readonly steam: Pick<
      SteamService,
      'getProductInfo' | 'getProductInfoWithDlc'
    >,
    readonly database: KalamataDatabase,
  ) {}

  async getAppSummary(appId: number): Promise<AppSummary> {
    return normalizeAppSummary(await this.steam.getProductInfo(appId))
  }

  async getAppDetails(appId: number): Promise<AppDetails> {
    return normalizeAppDetails(
      await this.steam.getProductInfoWithDlc(appId),
      this.database,
    )
  }
}

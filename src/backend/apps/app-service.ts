import type {
  AppDetails,
  AppSummary,
  AvailableUpdateResult,
} from '../../types/rpc.ts'
import type { KalamataDatabase } from '../../db/database.ts'
import type { SteamService } from '../index.ts'
import {
  normalizeAppDetails,
  normalizeAppSummary,
} from './product-normalizer.ts'
import { AvailableUpdateService } from './available-update-service.ts'

export class AppService {
  constructor(
    readonly steam: Pick<
      SteamService,
      'getProductInfo' | 'getProductInfoWithDlc' | 'getProductInfoWithDlcBatch'
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

  async checkAvailableUpdate(appId: number): Promise<AvailableUpdateResult> {
    return new AvailableUpdateService(this.steam, this.database).check(appId)
  }

  async checkAvailableUpdates(
    appIds: number[],
  ): Promise<AvailableUpdateResult[]> {
    return new AvailableUpdateService(this.steam, this.database).checkBatch(
      appIds,
    )
  }
}

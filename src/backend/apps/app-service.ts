import type { AppDetails, AppSummary } from '../../types/rpc.ts'
import type { KalamataDatabase } from '../../db/database.ts'
import type { SteamService } from '../index.ts'
import {
  normalizeAppDetails,
  normalizeAppSummary,
} from './product-normalizer.ts'

export class AppService {
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

  async setSelectedDepots(appId: number, depotIds: number[]): Promise<number[]> {
    const details = await this.getAppDetails(appId)
    const eligibleDepotIds = new Set(
      details.depots
        .filter((depot) => depot.eligible)
        .map((depot) => depot.depotId),
    )
    if (depotIds.some((depotId) => !eligibleDepotIds.has(depotId))) {
      throw new Error('Depot is not available for this app')
    }
    const selected = new Set(depotIds)
    return this.database.replaceSelectedDepotIds(
      appId,
      details.depots
        .map(({ depotId }) => depotId)
        .filter((depotId) => selected.has(depotId)),
    )
  }
}

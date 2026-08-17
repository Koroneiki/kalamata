import type { InstallRow } from '../../db/database.ts'
import type {
  AvailableUpdateCandidate,
  AvailableUpdateResult,
} from '../../types/rpc.ts'
import type { ProductInfoResult } from '../steam/types.ts'
import {
  extractPublicDepots,
  normalizeAppSummary,
} from './product-normalizer.ts'

interface AvailableUpdateMetadata {
  getProductInfoWithDlc(appId: number): Promise<ProductInfoResult>
  getProductInfoWithDlcBatch(
    appIds: number[],
  ): Promise<Map<number, ProductInfoResult>>
}

interface AvailableUpdateDatabase {
  getInstalls(appId: number): InstallRow[]
}

export class AvailableUpdateService {
  constructor(
    private readonly metadata: AvailableUpdateMetadata,
    private readonly database: AvailableUpdateDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async check(appId: number): Promise<AvailableUpdateResult> {
    try {
      const installed = this.database.getInstalls(appId)
      if (!installed.length) return this.current(appId)
      const products = await this.metadata.getProductInfoWithDlc(appId)
      return this.compare(products, installed)
    } catch {
      return this.error(appId)
    }
  }

  async checkBatch(appIds: number[]): Promise<AvailableUpdateResult[]> {
    const installsByApp = new Map<number, InstallRow[]>()
    try {
      for (const appId of appIds) {
        const installed = this.database.getInstalls(appId)
        if (installed.length) installsByApp.set(appId, installed)
      }
    } catch {
      return appIds.map((appId) => this.error(appId))
    }

    const installedAppIds = appIds.filter((appId) => installsByApp.has(appId))
    if (!installedAppIds.length)
      return appIds.map((appId) => this.current(appId))

    let productsByApp: Map<number, ProductInfoResult>
    try {
      productsByApp =
        await this.metadata.getProductInfoWithDlcBatch(installedAppIds)
    } catch {
      return appIds.map((appId) =>
        installsByApp.has(appId) ? this.error(appId) : this.current(appId),
      )
    }
    return appIds.map((appId) => {
      const installed = installsByApp.get(appId)
      if (!installed) return this.current(appId)
      const products = productsByApp.get(appId)
      if (!products) return this.error(appId)
      try {
        return this.compare(products, installed)
      } catch {
        return this.error(appId)
      }
    })
  }

  private compare(
    products: ProductInfoResult,
    installed: InstallRow[],
  ): AvailableUpdateResult {
    const appId = products.baseProduct.appId
    const installsByDepot = new Map(installed.map((row) => [row.depotId, row]))
    const outdatedDepots: AvailableUpdateCandidate['outdatedDepots'] = []

    for (const depot of extractPublicDepots(
      products,
      new Set(installsByDepot.keys()),
    )) {
      const install = installsByDepot.get(depot.depotId)
      if (
        !install ||
        install.pinned ||
        (depot.group !== 'Base Game' && depot.group !== 'DLC') ||
        depot.manifestId === null ||
        install.installedManifestId === depot.manifestId
      ) {
        continue
      }
      outdatedDepots.push({
        depotId: depot.depotId,
        ownerAppId: depot.ownerAppId,
        installedManifestId: install.installedManifestId,
        targetManifestId: depot.manifestId,
        sizeBytes: depot.sizeBytes,
        downloadBytes: depot.downloadBytes,
      })
    }

    const checkedAt = this.now()
    if (!outdatedDepots.length) return { status: 'current', appId, checkedAt }

    return {
      status: 'available',
      candidate: {
        app: normalizeAppSummary(products.baseProduct),
        installedDepotIds: installed.map(({ depotId }) => depotId),
        outdatedDepots,
        totalDownloadBytes: totalDownloadBytes(outdatedDepots),
      },
      checkedAt,
    }
  }

  private current(appId: number): AvailableUpdateResult {
    return { status: 'current', appId, checkedAt: this.now() }
  }

  private error(appId: number): AvailableUpdateResult {
    return {
      status: 'error',
      appId,
      message: 'Could not check this app for updates.',
      checkedAt: this.now(),
    }
  }
}

function totalDownloadBytes(
  depots: AvailableUpdateCandidate['outdatedDepots'],
): string | null {
  if (depots.some(({ downloadBytes }) => downloadBytes === null)) return null
  return depots
    .reduce((total, { downloadBytes }) => total + BigInt(downloadBytes!), 0n)
    .toString()
}

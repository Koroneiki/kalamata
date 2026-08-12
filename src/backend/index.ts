import { DepotDownloadService } from './depot/depot-download-service.ts'
import type { ReconcileApplicationOptions } from './depot/depot-download-service.ts'
import type { ApplicationTransactionResult } from './depot/install/transaction/types.ts'
import {
  ManifestAcquisitionService,
  type AcquiredManifest,
  type AcquireManifestRequest,
} from './depot/manifests/manifest-acquisition-service.ts'
import { previewApplicationOperation } from './operations/application-preview.ts'
import type { ApplicationPlan } from './operations/application-planner.ts'
import type { ApplicationOperationPreview } from '../types/rpc.ts'
import { ProductInfoService } from './steam/product-info-service.ts'
import { SteamSession } from './steam/steam-session.ts'
import type { ProductInfo, ProductInfoResult } from './steam/types.ts'
import type { KalamataDatabase } from '../db/database.ts'

export type { ProductInfo, ProductInfoResult } from './steam/types.ts'

export class SteamService {
  readonly #session: SteamSession
  readonly #downloads: DepotDownloadService
  readonly #products: ProductInfoService
  readonly #manifestAcquisitions = new Map<
    KalamataDatabase,
    ManifestAcquisitionService
  >()

  constructor() {
    this.#session = new SteamSession()
    this.#downloads = new DepotDownloadService(this.#session)
    this.#products = new ProductInfoService(this.#session)
  }

  connect(): Promise<void> {
    return this.#session.connect()
  }

  reconcileApplication(
    options: ReconcileApplicationOptions,
  ): Promise<ApplicationTransactionResult> {
    return this.#downloads.reconcileApplication(options)
  }

  previewApplicationOperation(
    appId: number,
    plan: ApplicationPlan,
  ): Promise<ApplicationOperationPreview> {
    return previewApplicationOperation(appId, plan, this.#downloads)
  }

  getProductInfo(appId: number): Promise<ProductInfo> {
    return this.#products.getProductInfo(appId)
  }

  getProductInfoWithDlc(appId: number): Promise<ProductInfoResult> {
    return this.#products.getProductInfoWithDlc(appId)
  }

  acquireManifest(
    database: KalamataDatabase,
    request: AcquireManifestRequest,
  ): Promise<AcquiredManifest> {
    let service = this.#manifestAcquisitions.get(database)
    if (!service) {
      service = new ManifestAcquisitionService(this.#session, database)
      this.#manifestAcquisitions.set(database, service)
    }
    return service.acquire(request)
  }

  async shutdownManifestAcquisitions(): Promise<void> {
    await Promise.all(
      [...this.#manifestAcquisitions.values()].map((service) =>
        service.shutdown(),
      ),
    )
  }

  dispose(): void {
    this.#session.dispose()
  }
}

export function createSteamService(): SteamService {
  return new SteamService()
}

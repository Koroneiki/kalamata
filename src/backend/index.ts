import { DepotDownloadService } from './depot/depot-download-service.ts'
import type { ReconcileApplicationOptions } from './depot/depot-download-service.ts'
import type { ApplicationTransactionResult } from './depot/install/transaction/types.ts'
import { DepotKeyAcquisitionService } from './depot/keys/depot-key-acquisition-service.ts'
import { ManifestAcquisitionService } from './depot/manifests/manifest-acquisition-service.ts'
import { previewApplicationOperation } from './operations/application-preview.ts'
import type { ApplicationPlan } from './operations/application-planner.ts'
import type {
  AcquiredDepotKeys,
  AcquiredManifest,
  AcquireDepotKeysRequest,
  AcquireManifestRequest,
  ApplicationOperationPreview,
} from '../types/rpc.ts'
import { ProductInfoService } from './steam/product-info-service.ts'
import { SteamSession } from './steam/steam-session.ts'
import type { ProductInfo, ProductInfoResult } from './steam/types.ts'
import type { KalamataDatabase } from '../db/database.ts'

export type { ProductInfo, ProductInfoResult } from './steam/types.ts'

export class SteamService {
  readonly #session: SteamSession
  readonly #downloads: DepotDownloadService
  readonly #products: ProductInfoService
  readonly #depotKeyAcquisitions = new Map<
    KalamataDatabase,
    DepotKeyAcquisitionService
  >()
  readonly #manifestAcquisitions = new Map<
    KalamataDatabase,
    ManifestAcquisitionService
  >()

  constructor() {
    this.#session = new SteamSession()
    this.#downloads = new DepotDownloadService(this.#session)
    this.#products = new ProductInfoService(this.#session)
  }

  // Fallow cannot trace calls to these methods through structural service interfaces.
  // fallow-ignore-next-line unused-class-member
  connect(): Promise<void> {
    return this.#session.connect()
  }

  // fallow-ignore-next-line unused-class-member
  reconcileApplication(
    options: ReconcileApplicationOptions,
  ): Promise<ApplicationTransactionResult> {
    return this.#downloads.reconcileApplication(options)
  }

  // fallow-ignore-next-line unused-class-member
  previewApplicationOperation(
    appId: number,
    plan: ApplicationPlan,
    outputDirectory?: string,
  ): Promise<ApplicationOperationPreview> {
    return previewApplicationOperation(
      appId,
      plan,
      this.#downloads,
      outputDirectory,
    )
  }

  // fallow-ignore-next-line unused-class-member
  getProductInfo(appId: number): Promise<ProductInfo> {
    return this.#products.getProductInfo(appId)
  }

  // fallow-ignore-next-line unused-class-member
  getProductInfoWithDlc(appId: number): Promise<ProductInfoResult> {
    return this.#products.getProductInfoWithDlc(appId)
  }

  // AppService calls this method through a structural Pick that Fallow cannot trace.
  // fallow-ignore-next-line unused-class-member
  getProductInfoWithDlcBatch(
    appIds: number[],
  ): Promise<Map<number, ProductInfoResult>> {
    return this.#products.getProductInfoWithDlcBatch(appIds)
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

  initializeDepotKeyCache(database: KalamataDatabase): Promise<void> {
    return this.getDepotKeyAcquisitionService(database).initializeCache()
  }

  acquireDepotKeys(
    database: KalamataDatabase,
    request: AcquireDepotKeysRequest,
  ): Promise<AcquiredDepotKeys> {
    return this.getDepotKeyAcquisitionService(database).acquire(request)
  }

  async shutdownManifestAcquisitions(): Promise<void> {
    await Promise.all(
      [...this.#manifestAcquisitions.values()].map((service) =>
        service.shutdown(),
      ),
    )
  }

  async shutdownDepotKeyAcquisitions(): Promise<void> {
    await Promise.all(
      [...this.#depotKeyAcquisitions.values()].map((service) =>
        service.shutdown(),
      ),
    )
  }

  private getDepotKeyAcquisitionService(
    database: KalamataDatabase,
  ): DepotKeyAcquisitionService {
    let service = this.#depotKeyAcquisitions.get(database)
    if (!service) {
      service = new DepotKeyAcquisitionService(database)
      this.#depotKeyAcquisitions.set(database, service)
    }
    return service
  }

  dispose(): void {
    this.#session.dispose()
  }
}

export function createSteamService(): SteamService {
  return new SteamService()
}

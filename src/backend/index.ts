import { DepotDownloadService } from './depot/depot-download-service.ts'
import type { ReconcileApplicationOptions } from './depot/depot-download-service.ts'
import type { ApplicationTransactionResult } from './depot/install/transaction/types.ts'
import { DepotKeyAcquisitionService } from './depot/keys/depot-key-acquisition-service.ts'
import { ManifestAcquisitionService } from './depot/manifests/manifest-acquisition-service.ts'
import { previewApplicationOperation } from './operations/application-preview.ts'
import type { ApplicationPlan } from './operations/application-planner.ts'
import type {
  AcquiredDepotKeys,
  AcquireDepotKeysRequest,
  AcquireManifestRequest,
  ApplicationOperationPreview,
  HubcapUsageResult,
  ManifestAcquisitionResult,
} from '../types/rpc.ts'
import { ProductInfoService } from './steam/product-info-service.ts'
import { SteamSession } from './steam/steam-session.ts'
import type { BackgroundDownloadCoordinator } from './downloads/background-download-coordinator.ts'
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

  constructor(
    reportPackageFailure?: (
      appIds: number[],
      countryCode: string,
      error: Error,
    ) => void,
    private readonly backgroundDownloads?: BackgroundDownloadCoordinator,
  ) {
    this.#session = new SteamSession()
    this.#downloads = new DepotDownloadService(this.#session)
    this.#products = new ProductInfoService(
      this.#session,
      undefined,
      reportPackageFailure,
    )
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
  ): Promise<ApplicationOperationPreview> {
    return previewApplicationOperation(appId, plan, this.#downloads)
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
  ): Promise<ManifestAcquisitionResult> {
    let service = this.#manifestAcquisitions.get(database)
    if (!service) {
      service = new ManifestAcquisitionService(this.#session, database)
      this.#manifestAcquisitions.set(database, service)
    }
    if (!this.backgroundDownloads) return service.acquire(request)
    const parentAppId = request.parentAppId ?? request.appId
    return this.backgroundDownloads.enqueue({
      key: `manifest:${request.depotId}:${request.manifestId}`,
      groupKey: `manifest-app:${parentAppId}`,
      kind: 'manifest',
      title: `Manifests for app ${parentAppId}`,
      appId: parentAppId,
      depotId: request.depotId,
      run: (context) => service.acquireWithContext(request, context),
    })
  }

  initializeDepotKeyCache(database: KalamataDatabase): Promise<void> {
    return this.getDepotKeyAcquisitionService(database).initializeCache()
  }

  acquireDepotKeys(
    database: KalamataDatabase,
    request: AcquireDepotKeysRequest,
  ): Promise<AcquiredDepotKeys> {
    const service = this.getDepotKeyAcquisitionService(database)
    if (!this.backgroundDownloads) return service.acquire(request)
    return this.backgroundDownloads.enqueue({
      key: `depot-keys:${request.appId}:${[...request.depotIds].sort((a, b) => a - b).join(',')}:${!!request.approveLowQuotaHubcap}`,
      kind: 'depot-keys',
      title: `Depot keys for ${request.appId}`,
      appId: request.appId,
      run: (context) => service.acquireWithContext(request, context),
    })
  }

  getHubcapUsage(database: KalamataDatabase): Promise<HubcapUsageResult> {
    return this.getDepotKeyAcquisitionService(database).getHubcapUsage()
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
      service = new DepotKeyAcquisitionService(
        database,
        fetch,
        this.backgroundDownloads,
      )
      this.#depotKeyAcquisitions.set(database, service)
    }
    return service
  }

  dispose(): void {
    this.#session.dispose()
  }
}

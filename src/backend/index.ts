import { DepotDownloadService } from './depot/depot-download-service.ts'
import type { ReconcileApplicationOptions } from './depot/depot-download-service.ts'
import type { ApplicationTransactionResult } from './depot/application-transaction.ts'
import type { DownloadDepotOptions, DownloadResult } from './depot/types.ts'
import { ProductInfoService } from './steam/product-info-service.ts'
import { SteamSession } from './steam/steam-session.ts'
import type { ProductInfo, ProductInfoResult } from './steam/types.ts'

export type {
  DownloadDepotOptions,
  DownloadEvent,
  DownloadResult,
} from './depot/types.ts'
export type { ProductInfo, ProductInfoResult } from './steam/types.ts'

export class SteamService {
  readonly #session: SteamSession
  readonly #downloads: DepotDownloadService
  readonly #products: ProductInfoService

  constructor() {
    this.#session = new SteamSession()
    this.#downloads = new DepotDownloadService(this.#session)
    this.#products = new ProductInfoService(this.#session)
  }

  connect(): Promise<void> {
    return this.#session.connect()
  }

  downloadDepot(options: DownloadDepotOptions): Promise<DownloadResult> {
    return this.#downloads.download(options)
  }

  reconcileApplication(
    options: ReconcileApplicationOptions,
  ): Promise<ApplicationTransactionResult> {
    return this.#downloads.reconcileApplication(options)
  }

  getProductInfo(appId: number): Promise<ProductInfo> {
    return this.#products.getProductInfo(appId)
  }

  getProductInfoWithDlc(appId: number): Promise<ProductInfoResult> {
    return this.#products.getProductInfoWithDlc(appId)
  }

  dispose(): void {
    this.#session.dispose()
  }
}

export function createSteamService(): SteamService {
  return new SteamService()
}

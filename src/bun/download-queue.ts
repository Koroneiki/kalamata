import type {
  DownloadQueueState,
  RunningDownloadQueue,
  StartDownloadRequest,
} from '../types/rpc.ts'
import type {
  DownloadDepotOptions,
  DownloadEvent,
  DownloadResult,
} from '../backend/depot/types.ts'
import type { ProductInfoResult } from '../backend/steam/types.ts'
import { normalizeAppDetails } from '../backend/steam/product-normalizer.ts'
import type { KalamataDatabase } from '../db/database.ts'
import { validateManagedManifest } from '../db/manifest-files.ts'
import { depotKeyFromHex, validateId } from '../db/validation.ts'

interface QueueSteamService {
  getProductInfoWithDlc(appId: number): Promise<ProductInfoResult>
  downloadDepot(options: DownloadDepotOptions): Promise<DownloadResult>
}

interface PlannedDepot {
  depotId: number
  ownerAppId: number
  manifestId: string
  manifestPath: string
  depotKey: Buffer
}

export class DownloadQueueCoordinator {
  #state: DownloadQueueState = { status: 'idle' }
  #starting = false
  #progressEmissionHandle: ReturnType<typeof setImmediate> | undefined

  constructor(
    private readonly steam: QueueSteamService,
    private readonly database: KalamataDatabase,
    private readonly emit: (state: DownloadQueueState) => void = () => {},
  ) {}

  getState(): DownloadQueueState {
    return structuredClone(this.#state)
  }

  async start(request: StartDownloadRequest): Promise<RunningDownloadQueue> {
    if (this.#starting || this.#state.status === 'running') {
      throw new Error('Another download queue is already running')
    }
    this.#starting = true
    try {
      validateId(request.appId, 'appId')
      if (!request.depotIds.length) {
        throw new Error('At least one depot must be selected')
      }
      const uniqueDepotIds = new Set(request.depotIds)
      if (uniqueDepotIds.size !== request.depotIds.length) {
        throw new Error('Depot IDs must not contain duplicates')
      }
      for (const depotId of request.depotIds) validateId(depotId, 'depotId')

      const installPath = await this.database.assertInstallPathAvailable(
        request.appId,
        request.installPath,
      )
      const products = await this.steam.getProductInfoWithDlc(request.appId)
      const details = await normalizeAppDetails(products, this.database)
      const detailsById = new Map(
        details.depots.map((depot) => [depot.depotId, depot]),
      )
      const plan: PlannedDepot[] = []
      for (const depotId of request.depotIds) {
        const detailsDepot = detailsById.get(depotId)
        if (!detailsDepot?.eligible) {
          throw new Error(`Depot ${depotId} is not available for download`)
        }
        if (!detailsDepot?.manifestId) {
          throw new Error(`Depot ${depotId} has no public manifest`)
        }
        if (!detailsDepot.selectable) {
          throw new Error(`Depot ${depotId} is not available for download`)
        }
        const row = this.database
          .getManifestRows(depotId)
          .find((candidate) => candidate.manifestId === detailsDepot.manifestId)
        if (!row) throw new Error(`Depot ${depotId} manifest is unavailable`)
        const keyText = this.database.getDepotKey(depotId)
        if (keyText === null)
          throw new Error(`Depot ${depotId} key is unavailable`)
        const depotKey = depotKeyFromHex(keyText)
        const manifestPath = await validateManagedManifest(
          this.database.dataRoot,
          depotId,
          detailsDepot.manifestId,
          row.relativePath,
          depotKey,
        )
        plan.push({
          depotId,
          ownerAppId: detailsDepot.ownerAppId,
          manifestId: detailsDepot.manifestId,
          manifestPath,
          depotKey,
        })
      }

      const initial: RunningDownloadQueue = {
        status: 'running',
        appId: request.appId,
        installPath,
        depotIds: [...request.depotIds],
        completedDepotIds: [],
        currentDepotId: plan[0]!.depotId,
        position: 1,
        total: plan.length,
        downloadedBytes: '0',
        totalBytes: '0',
        operation: null,
      }
      this.#state = initial
      this.emitState()
      void this.run(plan)
      return structuredClone(initial)
    } finally {
      this.#starting = false
    }
  }

  private async run(plan: PlannedDepot[]): Promise<void> {
    let aggregateDownloaded = 0n
    let aggregateReused = 0n
    for (const [index, depot] of plan.entries()) {
      if (this.#state.status !== 'running') return
      this.#state = {
        ...this.#state,
        currentDepotId: depot.depotId,
        position: index + 1,
        downloadedBytes: '0',
        totalBytes: '0',
        operation: null,
      }
      if (index > 0) this.emitState()
      let failureKind: 'download' | 'persistence' = 'download'
      try {
        const result = await this.steam.downloadDepot({
          appId: depot.ownerAppId,
          depotId: depot.depotId,
          manifestPath: depot.manifestPath,
          depotKey: depot.depotKey,
          outputDirectory: this.#state.installPath,
          onEvent: (event) => this.handleEvent(depot.depotId, event),
        })
        if (result.manifestId !== depot.manifestId) {
          throw new Error(
            `Depot ${depot.depotId} returned an unexpected manifest`,
          )
        }
        const downloadedBytes = parseByteCount(result.downloadedBytes)
        const reusedBytes = parseByteCount(result.reusedBytes)
        failureKind = 'persistence'
        this.database.recordInstalledDepot(
          this.#state.appId,
          this.#state.installPath,
          depot.depotId,
          depot.manifestId,
        )
        aggregateDownloaded += downloadedBytes
        aggregateReused += reusedBytes
        this.#state = {
          ...this.#state,
          completedDepotIds: [...this.#state.completedDepotIds, depot.depotId],
        }
        this.emitState()
      } catch {
        this.#state = {
          status: 'failed',
          appId: this.#state.appId,
          installPath: this.#state.installPath,
          depotIds: [...this.#state.depotIds],
          completedDepotIds: [...this.#state.completedDepotIds],
          failedDepotId: depot.depotId,
          failureKind,
          error: failureMessage(failureKind),
        }
        this.emitState()
        return
      }
    }
    if (this.#state.status !== 'running') return
    this.#state = {
      status: 'completed',
      appId: this.#state.appId,
      installPath: this.#state.installPath,
      depotIds: [...this.#state.depotIds],
      completedDepotIds: [...this.#state.completedDepotIds],
      downloadedBytes: aggregateDownloaded.toString(),
      reusedBytes: aggregateReused.toString(),
    }
    this.emitState()
  }

  private handleEvent(depotId: number, event: DownloadEvent): void {
    if (
      this.#state.status !== 'running' ||
      this.#state.currentDepotId !== depotId
    ) {
      return
    }
    if (event.type === 'progress') {
      this.#state = {
        ...this.#state,
        downloadedBytes: event.downloaded,
        totalBytes: event.total,
      }
      this.scheduleProgressEmission()
      return
    }
    const operation =
      event.type === 'file-validating'
        ? `Validating ${event.path}`
        : event.type === 'file-complete'
          ? `Completed ${event.path}`
          : event.type === 'file-deleted'
            ? `Removed ${event.path}`
            : `Retrying chunk ${event.chunk} (attempt ${event.attempt})`
    this.#state = { ...this.#state, operation }
    this.emitState()
  }

  private scheduleProgressEmission(): void {
    if (this.#state.status !== 'running') return
    if (this.#progressEmissionHandle) return
    const depotId = this.#state.currentDepotId
    this.#progressEmissionHandle = setImmediate(() => {
      this.#progressEmissionHandle = undefined
      if (
        this.#state.status === 'running' &&
        this.#state.currentDepotId === depotId
      ) {
        this.emitState()
      }
    })
  }

  private emitState(): void {
    if (this.#progressEmissionHandle) {
      clearImmediate(this.#progressEmissionHandle)
      this.#progressEmissionHandle = undefined
    }
    this.emit(structuredClone(this.#state))
  }
}

function parseByteCount(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new Error('Downloader returned an invalid byte count')
  }
  return BigInt(value)
}

function failureMessage(kind: 'download' | 'persistence'): string {
  return kind === 'download'
    ? 'The depot could not be downloaded. Start the download again to resume it.'
    : 'The depot files were downloaded, but the installation could not be recorded. Start the download again to reconcile it.'
}

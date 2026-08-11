import {
  ApplicationTransactionError,
  archiveUnresolvedApplicationTransaction,
  clearRepairFallback,
  discardPrecommitApplicationTransaction,
  getResumableApplicationTransaction,
  hasCommitReadyApplicationTransaction,
  type ApplicationDepotRecord,
  type ApplicationTransactionEvent,
  type ApplicationTransactionResult,
} from '../backend/depot/application-transaction.ts'
import { abortable } from '../backend/depot/abortable.ts'
import type {
  ApplicationDepotInput,
  ReconcileApplicationOptions,
} from '../backend/depot/depot-download-service.ts'
import { extractPublicDepots } from '../backend/steam/product-normalizer.ts'
import type { ProductInfoResult } from '../backend/steam/types.ts'
import type { KalamataDatabase } from '../db/database.ts'
import { validateManagedManifest } from '../db/manifest-files.ts'
import { depotKeyFromHex, validateId } from '../db/validation.ts'
import type {
  ActiveOperationState,
  CancelOperationResult,
  DownloadQueueState,
  OperationErrorKind,
  OperationKind,
  OperationState,
  PauseOperationResult,
  QueueDepotUpdateRequest,
  RepairApplicationRequest,
  ResumeOperationResult,
  RunningDownloadQueue,
  StartDownloadRequest,
} from '../types/rpc.ts'

interface QueueSteamService {
  getProductInfoWithDlc(appId: number): Promise<ProductInfoResult>
  reconcileApplication(
    options: ReconcileApplicationOptions,
  ): Promise<ApplicationTransactionResult>
}

interface OperationRequest {
  kind: OperationKind
  appId: number
  installPath: string
  requestedDepotIds?: number[]
  desiredDepotIds?: number[]
  fixedDesired?: ApplicationDepotRecord[]
}

export class DownloadQueueCoordinator {
  #state: OperationState = { status: 'idle' }
  #controller: AbortController | undefined
  #runPromise: Promise<void> | undefined
  #commitStarted = false
  #shuttingDown = false
  #acceptingAppId: number | null = null
  #acceptanceDone: Promise<void> | undefined
  #resolveAcceptance: (() => void) | undefined
  #operationId = 0
  #progressQueued = false
  #currentRequest: OperationRequest | undefined
  #pausing = false
  #cancelRequested = false
  readonly #repairRequirements = new Map<number, string>()

  constructor(
    private readonly steam: QueueSteamService,
    private readonly database: KalamataDatabase,
    private readonly emitDownload: (
      state: DownloadQueueState,
    ) => void = () => {},
    private readonly emitOperation: (state: OperationState) => void = () => {},
  ) {}

  getState(): DownloadQueueState {
    return toDownloadState(this.#state)
  }

  getOperationState(): OperationState {
    return structuredClone(this.#state)
  }

  isBusyForApp(appId: number): boolean {
    return (
      this.#repairRequirements.has(appId) ||
      this.#acceptingAppId === appId ||
      (this.#state.status !== 'idle' &&
        'appId' in this.#state &&
        this.#state.appId === appId &&
        ['active', 'paused', 'resumable', 'repair-required'].includes(
          this.#state.status,
        ))
    )
  }

  async start(request: StartDownloadRequest): Promise<RunningDownloadQueue> {
    validateId(request.appId, 'appId')
    validateDepotIds(request.depotIds, false)
    this.claimAcceptance(request.appId)
    try {
      const installPath = await this.database.assertInstallPathAvailable(
        request.appId,
        request.installPath,
      )
      if (this.#shuttingDown) throw new Error('Application is shutting down')
      this.database.reserveInstallPath(request.appId, installPath)
      const active = this.begin(
        {
          kind: 'download',
          appId: request.appId,
          installPath,
          requestedDepotIds: request.depotIds,
        },
        true,
      )
      return toDownloadState(active) as RunningDownloadQueue
    } finally {
      this.releaseAcceptance()
    }
  }

  async queueDepotUpdate(
    request: QueueDepotUpdateRequest,
  ): Promise<ActiveOperationState> {
    validateId(request.appId, 'appId')
    validateDepotIds(request.desiredDepotIds, true)
    this.claimAcceptance(request.appId)
    try {
      const entry = this.database.getLibraryEntry(request.appId)
      if (!entry?.installPath) throw new Error('App has no installation path')
      const installPath = await this.database.assertInstallPathAvailable(
        request.appId,
        entry.installPath,
      )
      if (this.#shuttingDown) throw new Error('Application is shutting down')
      return this.begin(
        {
          kind: 'reconcile',
          appId: request.appId,
          installPath,
          desiredDepotIds: request.desiredDepotIds,
        },
        true,
      )
    } finally {
      this.releaseAcceptance()
    }
  }

  async repairApplication(
    request: RepairApplicationRequest,
  ): Promise<ActiveOperationState> {
    validateId(request.appId, 'appId')
    const entry = this.database.getLibraryEntry(request.appId)
    if (!entry?.installPath) throw new Error('App has no installation path')
    const repairRequired = this.#repairRequirements.has(request.appId)
    this.claimAcceptance(request.appId, true)
    try {
      const fixedDesired = repairRequired
        ? ((await archiveUnresolvedApplicationTransaction(entry.installPath)) ??
          undefined)
        : undefined
      if (
        repairRequired &&
        this.#state.status === 'repair-required' &&
        this.#state.appId === request.appId
      )
        this.#state = { status: 'idle' }
      const installPath = await this.database.assertInstallPathAvailable(
        request.appId,
        entry.installPath,
      )
      return this.begin(
        {
          kind: 'repair',
          appId: request.appId,
          installPath,
          desiredDepotIds: this.database
            .getInstalls(request.appId)
            .map(({ depotId }) => depotId),
          ...(fixedDesired ? { fixedDesired } : {}),
        },
        true,
      )
    } finally {
      this.releaseAcceptance()
    }
  }

  async cancel(): Promise<CancelOperationResult> {
    if (
      (this.#state.status === 'paused' || this.#state.status === 'resumable') &&
      this.#currentRequest
    ) {
      const state = this.#state
      const request = this.#currentRequest
      this.#currentRequest = undefined
      try {
        await discardPrecommitApplicationTransaction(state.installPath)
      } catch (error) {
        this.#currentRequest = request
        throw error
      }
      this.#state = {
        status: 'cancelled',
        kind: state.kind,
        appId: state.appId,
        installPath: state.installPath,
        desiredDepotIds: [...state.desiredDepotIds],
        error: {
          kind: 'cancellation',
          message: 'The operation was cancelled before commit.',
        },
      }
      this.database.clearUnusedInstallPath(state.appId)
      this.emitState()
      return { accepted: true }
    }
    if (this.#state.status !== 'active' || !this.#controller)
      return { accepted: false, reason: 'no-active-operation' }
    if (this.#commitStarted)
      return { accepted: false, reason: 'commit-in-progress' }
    this.#cancelRequested = true
    this.#pausing = false
    this.#controller.abort(
      new DOMException('Operation cancelled by request', 'AbortError'),
    )
    return { accepted: true }
  }

  pause(): PauseOperationResult {
    if (this.#state.status !== 'active' || !this.#controller)
      return { accepted: false, reason: 'no-active-operation' }
    if (
      this.#commitStarted ||
      !['staging', 'downloading', 'verifying'].includes(this.#state.phase)
    )
      return { accepted: false, reason: 'invalid-phase' }
    const reason = new Error('Operation paused by request')
    reason.name = 'PauseError'
    this.#pausing = true
    this.#controller.abort(reason)
    return { accepted: true }
  }

  resume(): ResumeOperationResult {
    if (
      (this.#state.status !== 'paused' &&
        this.#state.status !== 'resumable') ||
      !this.#currentRequest
    )
      return { accepted: false, reason: 'no-resumable-operation' }
    this.begin(this.#currentRequest, true)
    return { accepted: true }
  }

  async restoreInterrupted(): Promise<void> {
    for (const entry of this.database.getLibrary()) {
      if (!entry.installPath) continue
      const resumable = await getResumableApplicationTransaction(
        entry.installPath,
        entry.appId,
      ).catch(() => null)
      if (!resumable) continue
      const request: OperationRequest = {
        kind: resumable.kind,
        appId: resumable.appId,
        installPath: resumable.installPath,
        desiredDepotIds: resumable.desiredDepotIds,
        fixedDesired: resumable.desired,
        ...(resumable.kind === 'download'
          ? { requestedDepotIds: resumable.desiredDepotIds }
          : {}),
      }
      this.#currentRequest = request
      if (!resumable.paused) {
        this.begin(request)
        return
      }
      this.#state = {
        status: 'paused',
        kind: resumable.kind,
        phase: 'downloading',
        appId: resumable.appId,
        installPath: resumable.installPath,
        desiredDepotIds: resumable.desiredDepotIds,
        installedBytesCompleted: resumable.installedBytesCompleted,
        installedBytesTotal: resumable.installedBytesTotal,
        reusedLocalBytes: resumable.reusedLocalBytes,
        networkBytes: resumable.networkBytes,
      }
      this.emitState()
      return
    }
  }

  markRepairRequired(appId: number, installPath: string): void {
    this.#repairRequirements.set(appId, installPath)
    if (this.#state.status !== 'idle') return
    this.showNextRepairRequired()
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true
    if (!this.#commitStarted && this.#controller) {
      const reason = new Error('Application is shutting down')
      reason.name = 'ShutdownError'
      this.#controller.abort(reason)
    }
    await this.#acceptanceDone
    await this.#runPromise
  }

  private begin(
    request: OperationRequest,
    acceptanceClaimed = false,
  ): ActiveOperationState {
    if (this.#shuttingDown) throw new Error('Application is shutting down')
    if (!acceptanceClaimed) this.assertAvailable()
    const desiredDepotIds = [
      ...(request.desiredDepotIds ?? request.requestedDepotIds ?? []),
    ]
    const active: ActiveOperationState = {
      status: 'active',
      kind: request.kind,
      phase: 'planning',
      appId: request.appId,
      installPath: request.installPath,
      desiredDepotIds,
      installedBytesCompleted: '0',
      installedBytesTotal: '0',
      reusedLocalBytes: '0',
      networkBytes: '0',
    }
    this.#state = active
    this.#controller = new AbortController()
    this.#commitStarted = false
    this.#pausing = false
    this.#cancelRequested = false
    this.#currentRequest = request
    const operationId = ++this.#operationId
    this.#progressQueued = false
    this.emitState()
    this.#runPromise = this.runSafely(request, this.#controller.signal).finally(
      () => {
        if (this.#operationId !== operationId) return
        this.#controller = undefined
        this.#runPromise = undefined
        this.#commitStarted = false
      },
    )
    return structuredClone(active)
  }

  private assertAvailable(): void {
    if (this.#shuttingDown) throw new Error('Application is shutting down')
    // Operations are globally serialized; repair requirements block only their app.
    if (
      this.#acceptingAppId !== null ||
      ['active', 'paused', 'resumable'].includes(this.#state.status)
    )
      throw new Error('Another application operation is already running')
  }

  private claimAcceptance(appId: number, allowRepair = false): void {
    if (
      !(
        allowRepair &&
        this.#state.status === 'repair-required' &&
        this.#state.appId === appId
      )
    )
      this.assertAvailable()
    if (!allowRepair && this.#repairRequirements.has(appId))
      throw new Error('The application must be repaired before another operation')
    this.#acceptingAppId = appId
    this.#acceptanceDone = new Promise((resolve) => {
      this.#resolveAcceptance = resolve
    })
  }

  private releaseAcceptance(): void {
    this.#acceptingAppId = null
    this.#resolveAcceptance?.()
    this.#resolveAcceptance = undefined
    this.#acceptanceDone = undefined
  }

  private async run(
    request: OperationRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const installedRows = this.database.getInstalls(request.appId)
      // Desired selection drives reconciliation; legacy starts are additive.
      const desiredIds =
        request.kind === 'download'
          ? new Set([
              ...installedRows.map(({ depotId }) => depotId),
              ...(request.requestedDepotIds ?? []),
            ])
          : new Set(request.desiredDepotIds ?? [])
      if (request.fixedDesired)
        for (const { depotId } of request.fixedDesired) desiredIds.add(depotId)
      const pureRemoval =
        request.kind === 'reconcile' &&
        desiredIds.size < installedRows.length &&
        [...desiredIds].every((depotId) =>
          installedRows.some((row) => row.depotId === depotId),
        )
      const needsOwnershipMetadata = installedRows.some(
        (row) => desiredIds.has(row.depotId) && row.ownerAppId === null,
      )
      const canPlanLocally =
        request.fixedDesired !== undefined ||
        ((request.kind === 'repair' || pureRemoval) &&
          !needsOwnershipMetadata)
      const publicDepots =
        canPlanLocally
          ? []
          : extractPublicDepots(
              await abortable(
                this.steam
                  .getProductInfoWithDlc(request.appId)
                  .catch((error) => {
                    throw new ApplicationTransactionError(
                      'steam',
                      'Steam product metadata is unavailable',
                      { cause: error },
                    )
                  }),
                signal,
              ),
            )
      signal.throwIfAborted()
      const metadata = new Map(
        publicDepots.map((depot) => [depot.depotId, depot]),
      )
      const metadataOrder = publicDepots.map(({ depotId }) => depotId)
      const requested = new Set(request.requestedDepotIds ?? [])
      const installedDepots = await Promise.all(
        installedRows.map((row) =>
          this.planDepot(
            row.depotId,
            row.installedManifestId,
            metadata,
            signal,
            row.ownerAppId ?? metadata.get(row.depotId)?.ownerAppId ?? request.appId,
          ),
        ),
      )
      const unavailableDesired = [...desiredIds].filter(
        (depotId) =>
          !installedRows.some((row) => row.depotId === depotId) &&
          !metadata.has(depotId),
      )
      if (unavailableDesired.length > 0)
        throw new ApplicationTransactionError(
          'unavailable-resource',
          `Depots are unavailable for this application: ${unavailableDesired.join(', ')}`,
        )
      if (
        needsOwnershipMetadata &&
        installedRows.some(
          (row) => desiredIds.has(row.depotId) && !metadata.has(row.depotId),
        )
      )
        throw new ApplicationTransactionError(
          'unavailable-resource',
          'Legacy depot ownership could not be resolved from Steam metadata',
        )
      const desiredOrder =
        request.fixedDesired
          ? request.fixedDesired.map(({ depotId }) => depotId)
          : request.kind === 'repair' || pureRemoval
          ? installedRows.map(({ depotId }) => depotId)
              .filter((depotId) => desiredIds.has(depotId))
          : [
              ...metadataOrder.filter((depotId) => desiredIds.has(depotId)),
              // Keep unavailable installed depots after published depots without
              // disturbing their persisted relative mount order.
              ...installedRows
                .map(({ depotId }) => depotId)
                .filter(
                  (depotId) =>
                    desiredIds.has(depotId) && !metadata.has(depotId),
                ),
            ]
      if (this.#state.status === 'active')
        this.#state = { ...this.#state, desiredDepotIds: desiredOrder }
      const desiredDepots = await Promise.all(
        desiredOrder
          .map((depotId) => {
            const installed = installedRows.find(
              (row) => row.depotId === depotId,
            )
            const publicManifestId = metadata.get(depotId)?.manifestId
            const fixedManifestId = request.fixedDesired?.find(
              (record) => record.depotId === depotId,
            )?.manifestId
            const useInstalled =
              pureRemoval ||
              request.kind === 'repair' ||
              (request.kind === 'download' &&
                installed !== undefined &&
                !requested.has(depotId))
            const manifestId =
              fixedManifestId ??
              (useInstalled ? installed?.installedManifestId : publicManifestId)
            if (!manifestId)
              throw new ApplicationTransactionError(
                'unavailable-resource',
                `Depot ${depotId} has no available target manifest`,
              )
            return this.planDepot(
              depotId,
              manifestId,
              metadata,
              signal,
              request.fixedDesired?.find(
                (record) => record.depotId === depotId,
              )?.ownerAppId ??
                installed?.ownerAppId ??
                metadata.get(depotId)?.ownerAppId ??
                request.appId,
            )
          }),
      )
      signal.throwIfAborted()
      // Selection is user intent and persists before transactional file changes.
      if (request.kind === 'reconcile')
        this.database.replaceSelectedDepotIds(request.appId, desiredOrder)
      const result = await this.steam.reconcileApplication({
        kind: request.kind,
        appId: request.appId,
        outputDirectory: request.installPath,
        installedDepots,
        desiredDepots,
        signal,
        onEvent: (event) => this.handleEvent(event),
        reconcile: async (desired) => this.reconcileDatabase(request, desired),
      })
      const completedState: OperationState = {
        status: 'completed',
        kind: request.kind,
        appId: request.appId,
        installPath: request.installPath,
        desiredDepotIds: desiredDepots.map(({ depotId }) => depotId),
        installedBytes: result.logicalInstalledBytes,
        reusedLocalBytes: result.reusedLocalBytes,
        networkBytes: result.networkBytes,
      }
      if (request.kind === 'repair')
        await clearRepairFallback(request.installPath)
      this.#repairRequirements.delete(request.appId)
      this.#currentRequest = undefined
      this.#state = completedState
    } catch (error) {
      const serialized = serializeError(error)
      const shuttingDown = isShutdown(error, signal)
      const recoverable =
        (isRecoverable(serialized.kind) || shuttingDown) &&
        (await getResumableApplicationTransaction(
          request.installPath,
          request.appId,
        ).catch(() => null)) !== null
      const commitReady = await hasCommitReadyApplicationTransaction(
        request.installPath,
      ).catch(() => true)
      const paused = this.#pausing && !this.#cancelRequested
      const cancelled =
        !shuttingDown &&
        (this.#cancelRequested ||
          (!paused && (signal.aborted || isCancellation(error))))
      if (cancelled && !commitReady) {
        await discardPrecommitApplicationTransaction(request.installPath)
        this.#currentRequest = undefined
        this.database.clearUnusedInstallPath(request.appId)
      }
      const nextState: OperationState = paused
        ? {
            ...(this.#state as ActiveOperationState),
            status: 'paused',
          }
        : cancelled
        ? {
            status: 'cancelled',
            kind: request.kind,
            appId: request.appId,
            installPath: request.installPath,
            desiredDepotIds:
              this.#state.status === 'active'
                ? this.#state.desiredDepotIds
                : [],
            error: {
              kind: 'cancellation',
              message: 'The operation was cancelled before commit.',
            },
          }
        : commitReady
          ? {
              status: 'repair-required',
              appId: request.appId,
              installPath: request.installPath,
              error: {
                kind: 'recovery',
                message:
                  'The interrupted commit cannot be proven correct. Repair is required.',
              },
            }
        : recoverable
          ? {
              ...(this.#state as ActiveOperationState),
              status: 'resumable',
              error: serialized,
            }
          : {
            status: 'failed',
            kind: request.kind,
            appId: request.appId,
            installPath: request.installPath,
            desiredDepotIds:
              this.#state.status === 'active'
                ? this.#state.desiredDepotIds
                : [],
            error: serialized,
          }
      if (commitReady)
        this.#repairRequirements.set(request.appId, request.installPath)
      if (!cancelled && !paused && !recoverable && !commitReady) {
        this.#currentRequest = undefined
        const pending = await getResumableApplicationTransaction(
          request.installPath,
          request.appId,
        ).catch(() => null)
        if (!pending) this.database.clearUnusedInstallPath(request.appId)
      }
      this.#state = nextState
    }
    this.#progressQueued = false
    this.emitState()
    this.showNextRepairRequired()
  }

  private async runSafely(
    request: OperationRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.run(request, signal)
    } catch {
      this.#currentRequest = undefined
      this.#repairRequirements.set(request.appId, request.installPath)
      this.#state = repairRequiredState(request.appId, request.installPath)
      this.#progressQueued = false
      this.emitState()
    }
  }

  private showNextRepairRequired(): void {
    if (
      ['active', 'paused', 'resumable', 'repair-required'].includes(
        this.#state.status,
      )
    )
      return
    const next = this.#repairRequirements.entries().next().value
    if (!next) return
    this.#state = repairRequiredState(...next)
    this.emitState()
  }

  private async planDepot(
    depotId: number,
    manifestId: string,
    metadata: Map<number, ReturnType<typeof extractPublicDepots>[number]>,
    signal: AbortSignal,
    fallbackOwnerAppId: number,
  ): Promise<ApplicationDepotInput> {
    signal.throwIfAborted()
    const depot = metadata.get(depotId)
    if (depot && depot.group !== 'Base Game' && depot.group !== 'DLC')
      throw new ApplicationTransactionError(
        'planning',
        `Depot ${depotId} is not eligible for this application`,
      )
    const row = this.database
      .getManifestRows(depotId)
      .find((candidate) => candidate.manifestId === manifestId)
    const keyText = this.database.getDepotKey(depotId)
    if (!row || keyText === null)
      throw new ApplicationTransactionError(
        'unavailable-resource',
        `Depot ${depotId} requires a manually supplied manifest and key`,
      )
    let depotKey: Buffer
    let manifestPath: string
    try {
      depotKey = depotKeyFromHex(keyText)
      manifestPath = await validateManagedManifest(
        this.database.dataRoot,
        depotId,
        manifestId,
        row.relativePath,
        depotKey,
      )
    } catch (error) {
      throw new ApplicationTransactionError(
        'unavailable-resource',
        `Depot ${depotId} manifest or key is invalid`,
        { cause: error },
      )
    }
    return {
      depotId,
      ownerAppId: depot?.ownerAppId ?? fallbackOwnerAppId,
      manifestId,
      manifestPath,
      depotKey,
    }
  }

  private async reconcileDatabase(
    request: OperationRequest,
    desired: ApplicationDepotRecord[],
  ): Promise<void> {
    this.database.reconcileInstalledDepots(
      request.appId,
      request.installPath,
      desired.map(({ depotId, manifestId, mountIndex, ownerAppId }) => ({
        depotId,
        manifestId,
        mountIndex,
        ownerAppId,
      })),
    )
  }

  private handleEvent(event: ApplicationTransactionEvent): void {
    if (this.#state.status !== 'active') return
    if (event.type === 'progress') {
      this.#state = {
        ...this.#state,
        installedBytesCompleted: event.logicalInstalledCompleted,
        installedBytesTotal: event.logicalInstalledTotal,
        reusedLocalBytes: event.reusedLocal,
        networkBytes: event.actualNetwork,
      }
      if (!this.#progressQueued) {
        this.#progressQueued = true
        queueMicrotask(() => {
          if (!this.#progressQueued) return
          this.#progressQueued = false
          this.emitState()
        })
      }
      return
    } else {
      const phase =
        event.phase === 'persisting-local' || event.phase === 'reconciling'
          ? 'reconciling'
          : event.phase === 'completed'
            ? this.#state.phase
            : event.phase
      if (phase === 'committing' || phase === 'reconciling')
        this.#commitStarted = true
      this.#state = { ...this.#state, phase }
    }
    this.#progressQueued = false
    this.emitState()
  }

  private emitState(): void {
    const operation = structuredClone(this.#state)
    this.emitOperation(operation)
    this.emitDownload(toDownloadState(operation))
  }
}

function validateDepotIds(depotIds: number[], allowEmpty: boolean): void {
  if (!allowEmpty && depotIds.length === 0)
    throw new Error('At least one depot must be selected')
  if (new Set(depotIds).size !== depotIds.length)
    throw new Error('Depot IDs must not contain duplicates')
  for (const depotId of depotIds) validateId(depotId, 'depotId')
}

function serializeError(error: unknown): {
  kind: OperationErrorKind
  message: string
} {
  const kind =
    error instanceof ApplicationTransactionError ? error.kind : 'planning'
  const messages: Record<OperationErrorKind, string> = {
    planning: 'The installation plan is invalid.',
    'unavailable-resource': 'A required manifest or depot key is unavailable.',
    'insufficient-space':
      'There is not enough space to stage the installation.',
    steam: 'Steam could not be reached or did not authorize the request.',
    'unavailable-content': 'Required depot content is unavailable.',
    'transfer-exhausted': 'All eligible content servers failed.',
    integrity: 'Downloaded or staged content failed integrity verification.',
    filesystem: 'The installation filesystem operation failed.',
    cancellation: 'The operation was cancelled.',
    recovery: 'The interrupted installation could not be recovered safely.',
    persistence: 'Installation metadata could not be reconciled.',
  }
  return { kind, message: messages[kind] }
}

function isCancellation(error: unknown): boolean {
  return (
    (error instanceof ApplicationTransactionError &&
      error.kind === 'cancellation') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function isShutdown(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    signal.reason instanceof Error &&
    signal.reason.name === 'ShutdownError' &&
    (error instanceof ApplicationTransactionError
      ? error.kind === 'cancellation'
      : error === signal.reason)
  )
}

function isRecoverable(kind: OperationErrorKind): boolean {
  return [
    'unavailable-resource',
    'insufficient-space',
    'steam',
    'unavailable-content',
    'transfer-exhausted',
    'integrity',
    'filesystem',
  ].includes(kind)
}

function repairRequiredState(
  appId: number,
  installPath: string,
): OperationState {
  return {
    status: 'repair-required',
    appId,
    installPath,
    error: {
      kind: 'recovery',
      message:
        'The interrupted commit cannot be proven correct. Repair is required.',
    },
  }
}

function toDownloadState(state: OperationState): DownloadQueueState {
  if (state.status === 'idle') return state
  if (
    state.status === 'active' ||
    state.status === 'paused' ||
    state.status === 'resumable'
  ) {
    return {
      status: 'running',
      appId: state.appId,
      installPath: state.installPath,
      depotIds: [...state.desiredDepotIds],
      completedDepotIds: [],
      currentDepotId: state.desiredDepotIds[0] ?? 0,
      position: state.desiredDepotIds.length ? 1 : 0,
      total: state.desiredDepotIds.length,
      downloadedBytes: state.installedBytesCompleted,
      totalBytes: state.installedBytesTotal,
      operation: state.status === 'active' ? state.phase : state.status,
    }
  }
  if (state.status === 'completed') {
    return {
      status: 'completed',
      appId: state.appId,
      installPath: state.installPath,
      depotIds: [...state.desiredDepotIds],
      completedDepotIds: [...state.desiredDepotIds],
      downloadedBytes: state.installedBytes,
      reusedBytes: state.reusedLocalBytes,
    }
  }
  if (state.status === 'repair-required') {
    return {
      status: 'failed',
      appId: state.appId,
      installPath: state.installPath,
      depotIds: [],
      completedDepotIds: [],
      failedDepotId: 0,
      failureKind: 'persistence',
      error: state.error.message,
    }
  }
  return {
    status: 'failed',
    appId: state.appId,
    installPath: state.installPath,
    depotIds: [...state.desiredDepotIds],
    completedDepotIds: [],
    failedDepotId: state.desiredDepotIds[0] ?? 0,
    failureKind:
      state.status === 'failed' && state.error.kind === 'persistence'
        ? 'persistence'
        : 'download',
    error: state.error.message,
  }
}

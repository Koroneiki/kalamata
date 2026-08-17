import { randomUUID } from 'node:crypto'
import type {
  ApplicationDepotInput,
  ReconcileApplicationOptions,
} from '../depot/depot-download-service.ts'
import type {
  ApplicationDepotRecord,
  ApplicationTransactionEvent,
  ApplicationTransactionResult,
} from '../depot/install/transaction/types.ts'
import {
  archiveUnresolvedApplicationTransaction,
  clearRepairFallback,
  discardPrecommitApplicationTransaction,
  getResumableApplicationTransaction,
  hasCommitReadyApplicationTransaction,
} from '../depot/install/transaction/recovery.ts'
import type { ProductInfoResult } from '../steam/types.ts'
import type {
  ApplicationQueueItem,
  KalamataDatabase,
} from '../../db/database.ts'
import { validateId, validateManifestId } from '../../db/validation.ts'
import type {
  ActiveOperationState,
  ApplicationOperationPreview,
  CancelOperationResult,
  DownloadQueueSnapshot,
  OperationState,
  PauseOperationResult,
  PreviewApplicationOperationRequest,
  QueueDepotUpdateRequest,
  RepairApplicationRequest,
  ResumeOperationResult,
  StartDownloadRequest,
} from '../../types/rpc.ts'
import {
  planApplication,
  type ApplicationPlanRequest,
} from './application-planner.ts'
import {
  isOperationCancellation,
  isOperationShutdown,
  isRecoverableOperationError,
  operationError,
  repairRequiredState,
  serializeOperationError,
  validateDepotIds,
} from './operation-state.ts'

interface QueueSteamService {
  getProductInfoWithDlc(appId: number): Promise<ProductInfoResult>
  reconcileApplication(
    options: ReconcileApplicationOptions,
  ): Promise<ApplicationTransactionResult>
  previewApplicationOperation?(
    appId: number,
    plan: Awaited<ReturnType<typeof planApplication>>,
    outputDirectory?: string,
  ): Promise<ApplicationOperationPreview>
}

interface OperationFailureDisposition {
  serialized: ReturnType<typeof serializeOperationError>
  shuttingDown: boolean
  recoverable: boolean
  commitReady: boolean
  paused: boolean
  cancelled: boolean
}

interface QueuePreparationFailure {
  itemId: string
  error: Error
}

export class DownloadQueueCoordinator {
  #state: OperationState = { status: 'idle' }
  #controller: AbortController | undefined
  #runPromise: Promise<void> | undefined
  #commitStarted = false
  #shuttingDown = false
  #acceptanceQueue: Promise<void> = Promise.resolve()
  #pumpPromise: Promise<QueuePreparationFailure | undefined> | undefined
  #controlPromise: Promise<unknown> | undefined
  #operationId = 0
  #progressQueued = false
  #currentRequest: ApplicationPlanRequest | undefined
  #pausing = false
  #cancelRequested = false
  readonly #repairRequirements = new Map<number, string>()
  readonly #queuePreparationFailures = new Set<string>()

  constructor(
    private readonly steam: QueueSteamService,
    private readonly database: KalamataDatabase,
    private readonly emitOperation: (
      snapshot: DownloadQueueSnapshot,
    ) => void = () => {},
    private readonly reportError: (
      error: Error,
      context: { appId: number; kind: ApplicationPlanRequest['kind'] },
    ) => void = () => {},
  ) {}

  getOperationState(): OperationState {
    return structuredClone(this.#state)
  }

  getDownloadQueue(): DownloadQueueSnapshot {
    return {
      operation: this.getOperationState(),
      pending: this.database.getApplicationQueueItems().map(queueItemSnapshot),
      repairRequiredAppIds: [...this.#repairRequirements.keys()],
    }
  }

  isBusyForApp(appId: number): boolean {
    return (
      this.#repairRequirements.has(appId) ||
      this.database.hasQueuedApplication(appId) ||
      (this.#state.status !== 'idle' &&
        'appId' in this.#state &&
        this.#state.appId === appId &&
        ['active', 'paused', 'resumable', 'repair-required'].includes(
          this.#state.status,
        ))
    )
  }

  async start(request: StartDownloadRequest): Promise<DownloadQueueSnapshot> {
    validateId(request.appId, 'appId')
    validateDepotIds(request.depotIds, false)
    validateManifestTargets(request.manifestTargets, request.depotIds)
    return this.serializeAcceptance(async () => {
      this.assertAppAvailable(request.appId)
      const installPath = await this.database.assertInstallPathAvailable(
        request.appId,
        request.installPath,
      )
      if (this.#shuttingDown) throw new Error('Application is shutting down')
      const item = {
        id: randomUUID(),
        kind: 'download' as const,
        appId: request.appId,
        installPath,
        depotIds: request.depotIds,
        manifestTargets: request.manifestTargets,
        createdAt: Date.now(),
      }
      return this.acceptQueueItem(item, true)
    })
  }

  async queueDepotUpdate(
    request: QueueDepotUpdateRequest,
  ): Promise<DownloadQueueSnapshot> {
    validateId(request.appId, 'appId')
    validateDepotIds(request.desiredDepotIds, true)
    validateManifestTargets(request.manifestTargets, request.desiredDepotIds)
    return this.serializeAcceptance(async () => {
      this.assertAppAvailable(request.appId)
      const entry = this.database.getLibraryEntry(request.appId)
      if (!entry?.installPath) throw new Error('App has no installation path')
      const installPath = await this.database.assertInstallPathAvailable(
        request.appId,
        entry.installPath,
      )
      if (this.#shuttingDown) throw new Error('Application is shutting down')
      const item = {
        id: randomUUID(),
        kind: 'reconcile' as const,
        appId: request.appId,
        installPath,
        depotIds: request.desiredDepotIds,
        manifestTargets: request.manifestTargets,
        createdAt: Date.now(),
      }
      return this.acceptQueueItem(item)
    })
  }

  async previewApplicationOperation(
    request: PreviewApplicationOperationRequest,
  ): Promise<ApplicationOperationPreview> {
    // Preview plans without claiming the queue, reserving a path, or persisting selection.
    validateId(request.appId, 'appId')
    validateDepotIds(request.desiredDepotIds, true)
    validateManifestTargets(request.manifestTargets, request.desiredDepotIds)
    const entry = this.database.getLibraryEntry(request.appId)
    const installed = this.database.getInstalls(request.appId).length > 0
    const controller = new AbortController()
    const plan = await planApplication(
      installed
        ? {
            kind: 'reconcile',
            appId: request.appId,
            installPath: entry?.installPath ?? '',
            desiredDepotIds: request.desiredDepotIds,
            manifestTargets: request.manifestTargets,
          }
        : {
            kind: 'download',
            appId: request.appId,
            installPath: request.installPath ?? '',
            requestedDepotIds: request.desiredDepotIds,
            manifestTargets: request.manifestTargets,
          },
      this.steam,
      this.database,
      controller.signal,
      () => {},
    )
    if (!this.steam.previewApplicationOperation)
      throw new Error('Application operation preview is unavailable')
    return this.steam.previewApplicationOperation(
      request.appId,
      plan,
      installed ? (entry?.installPath ?? undefined) : request.installPath,
    )
  }

  async repairApplication(
    request: RepairApplicationRequest,
  ): Promise<DownloadQueueSnapshot> {
    validateId(request.appId, 'appId')
    const entry = this.database.getLibraryEntry(request.appId)
    if (!entry?.installPath) throw new Error('App has no installation path')
    const existingInstallPath = entry.installPath
    return this.serializeAcceptance(async () => {
      this.assertAppAvailable(request.appId, true)
      const installPath = await this.database.assertInstallPathAvailable(
        request.appId,
        existingInstallPath,
      )
      if (this.#shuttingDown) throw new Error('Application is shutting down')
      if (
        this.#state.status === 'repair-required' &&
        this.#state.appId === request.appId
      )
        this.#state = { status: 'idle' }
      const item = {
        id: randomUUID(),
        kind: 'repair' as const,
        appId: request.appId,
        installPath,
        depotIds: [],
        createdAt: Date.now(),
      }
      return this.acceptQueueItem(item)
    })
  }

  async removeQueuedOperation(id: string): Promise<DownloadQueueSnapshot> {
    return this.serializeAcceptance(async () => {
      if (this.#shuttingDown) throw new Error('Application is shutting down')
      const removed = this.database.removeApplicationQueueItem(id)
      if (!removed) throw new Error('Queued operation was not found')
      this.#queuePreparationFailures.delete(id)
      this.emitState()
      await this.pump()
      return this.getDownloadQueue()
    })
  }

  async startPending(): Promise<void> {
    await this.pump()
  }

  async cancel(): Promise<CancelOperationResult> {
    if (
      (this.#state.status === 'paused' || this.#state.status === 'resumable') &&
      this.#currentRequest
    ) {
      const state = this.#state
      const request = this.#currentRequest
      this.#currentRequest = undefined
      const cancellation = (async (): Promise<CancelOperationResult> => {
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
        await this.pump()
        return { accepted: true }
      })()
      this.#controlPromise = cancellation
      try {
        return await cancellation
      } finally {
        if (this.#controlPromise === cancellation)
          this.#controlPromise = undefined
      }
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

  async pause(): Promise<PauseOperationResult> {
    if (this.#state.status !== 'active' || !this.#controller)
      return { accepted: false, reason: 'no-active-operation' }
    if (
      this.#commitStarted ||
      !['staging', 'downloading', 'verifying'].includes(this.#state.phase)
    )
      return { accepted: false, reason: 'invalid-phase' }
    const runPromise = this.#runPromise
    const reason = new Error('Operation paused by request')
    reason.name = 'PauseError'
    this.#pausing = true
    this.#controller.abort(reason)
    // Confirmation may open only after writes checkpoint and state becomes paused.
    await runPromise
    if (this.getOperationState().status !== 'paused')
      throw new Error('Could not save the paused operation state')
    return { accepted: true }
  }

  resume(): ResumeOperationResult {
    if (
      (this.#state.status !== 'paused' && this.#state.status !== 'resumable') ||
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
      const request: ApplicationPlanRequest = {
        kind: resumable.kind,
        appId: resumable.appId,
        installPath: resumable.installPath,
        desiredDepotIds: resumable.desiredDepotIds,
        fixedDesired: resumable.desired,
      }
      if (resumable.kind === 'download')
        request.requestedDepotIds = resumable.desiredDepotIds
      this.#currentRequest = request
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
    await this.#acceptanceQueue
    await this.#pumpPromise
    await this.#runPromise
    await this.#controlPromise
  }

  private begin(
    request: ApplicationPlanRequest,
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
    if (['active', 'paused', 'resumable'].includes(this.#state.status))
      throw new Error('Another application operation is already running')
  }

  private assertAppAvailable(appId: number, allowRepair = false): void {
    if (this.#shuttingDown) throw new Error('Application is shutting down')
    if (this.database.hasQueuedApplication(appId))
      throw new Error('This application is already in Downloads')
    if (
      this.#state.status !== 'idle' &&
      'appId' in this.#state &&
      this.#state.appId === appId &&
      ['active', 'paused', 'resumable'].includes(this.#state.status)
    )
      throw new Error('This application is already in Downloads')
    if (!allowRepair && this.#repairRequirements.has(appId))
      throw new Error(
        'Repair this application before starting another operation',
      )
  }

  private serializeAcceptance<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#acceptanceQueue.then(work, work)
    this.#acceptanceQueue = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private async acceptQueueItem(
    item: ApplicationQueueItem,
    reserveInstallPath = false,
  ): Promise<DownloadQueueSnapshot> {
    this.database.appendApplicationQueueItem(item, reserveInstallPath)
    this.emitState()
    const failure = await this.pump()
    if (failure?.itemId === item.id) throw failure.error
    return this.getDownloadQueue()
  }

  private async run(
    request: ApplicationPlanRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.executeOperation(request, signal)
    } catch (error) {
      await this.handleOperationFailure(request, signal, operationError(error))
    }
    this.#progressQueued = false
    this.emitState()
    if (!['paused', 'resumable'].includes(this.#state.status)) await this.pump()
    this.showNextRepairRequired()
  }

  private async executeOperation(
    request: ApplicationPlanRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const { installedDepots, desiredDepots } = await planApplication(
      request,
      this.steam,
      this.database,
      signal,
      (depotIds) => {
        if (this.#state.status === 'active')
          this.#state = { ...this.#state, desiredDepotIds: depotIds }
      },
    )
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
    await this.completeOperation(request, desiredDepots, result)
  }

  private async completeOperation(
    request: ApplicationPlanRequest,
    desiredDepots: ApplicationDepotInput[],
    result: ApplicationTransactionResult,
  ): Promise<void> {
    // The transaction journal is gone, so an empty installation can release its path.
    this.database.clearUnusedInstallPath(request.appId)
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
  }

  private async handleOperationFailure(
    request: ApplicationPlanRequest,
    signal: AbortSignal,
    failure: Error,
  ): Promise<void> {
    const disposition = await this.classifyOperationFailure(
      request,
      signal,
      failure,
    )
    if (
      ![
        disposition.cancelled,
        disposition.paused,
        disposition.shuttingDown,
      ].includes(true)
    )
      this.reportError(diagnosticOperationError(failure), {
        appId: request.appId,
        kind: request.kind,
      })
    if (disposition.cancelled && !disposition.commitReady) {
      await discardPrecommitApplicationTransaction(request.installPath)
      this.#currentRequest = undefined
      this.database.clearUnusedInstallPath(request.appId)
    }
    if (this.#state.status !== 'active')
      throw new Error('Operation left active state before completion')
    const activeState = this.#state
    const nextState = this.operationFailureState(
      request,
      activeState,
      disposition,
    )
    if (disposition.commitReady)
      this.#repairRequirements.set(request.appId, request.installPath)
    if (
      ![
        disposition.cancelled,
        disposition.paused,
        disposition.recoverable,
        disposition.commitReady,
      ].includes(true)
    ) {
      this.#currentRequest = undefined
      const pending = await getResumableApplicationTransaction(
        request.installPath,
        request.appId,
      ).catch(() => null)
      if (!pending) this.database.clearUnusedInstallPath(request.appId)
    }
    this.#state = nextState
  }

  private async classifyOperationFailure(
    request: ApplicationPlanRequest,
    signal: AbortSignal,
    failure: Error,
  ): Promise<OperationFailureDisposition> {
    const serialized = serializeOperationError(failure)
    const shuttingDown = isOperationShutdown(failure, signal)
    const resumable = await getResumableApplicationTransaction(
      request.installPath,
      request.appId,
    ).catch(() => null)
    const recoverable =
      (isRecoverableOperationError(serialized.kind) || shuttingDown) &&
      resumable !== null
    const commitReady = await hasCommitReadyApplicationTransaction(
      request.installPath,
    ).catch(() => true)
    const pauseRequested = this.#pausing && !this.#cancelRequested
    return {
      serialized,
      shuttingDown,
      recoverable,
      commitReady,
      paused: pauseRequested && resumable?.paused === true,
      cancelled: isCancelledFailure(
        shuttingDown,
        this.#cancelRequested,
        pauseRequested,
        signal,
        failure,
      ),
    }
  }

  private operationFailureState(
    request: ApplicationPlanRequest,
    activeState: ActiveOperationState,
    disposition: OperationFailureDisposition,
  ): OperationState {
    if (disposition.paused) return { ...activeState, status: 'paused' }
    if (disposition.cancelled)
      return {
        status: 'cancelled',
        kind: request.kind,
        appId: request.appId,
        installPath: request.installPath,
        desiredDepotIds: activeState.desiredDepotIds,
        error: {
          kind: 'cancellation',
          message: 'The operation was cancelled before commit.',
        },
      }
    if (disposition.commitReady)
      return repairRequiredState(request.appId, request.installPath)
    if (disposition.recoverable)
      return {
        ...activeState,
        status: 'resumable',
        error: disposition.serialized,
      }
    return {
      status: 'failed',
      kind: request.kind,
      appId: request.appId,
      installPath: request.installPath,
      desiredDepotIds: activeState.desiredDepotIds,
      error: disposition.serialized,
    }
  }

  private async runSafely(
    request: ApplicationPlanRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.run(request, signal)
    } catch (error) {
      this.reportError(diagnosticOperationError(operationError(error)), {
        appId: request.appId,
        kind: request.kind,
      })
      this.#currentRequest = undefined
      this.#repairRequirements.set(request.appId, request.installPath)
      this.#state = repairRequiredState(request.appId, request.installPath)
      this.#progressQueued = false
      this.emitState()
      await this.pump()
      this.showNextRepairRequired()
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

  private async reconcileDatabase(
    request: ApplicationPlanRequest,
    desired: ApplicationDepotRecord[],
  ): Promise<void> {
    this.database.reconcileInstalledDepots(
      request.appId,
      request.installPath,
      desired.map(
        ({ depotId, manifestId, pinned, mountIndex, ownerAppId }) => ({
          depotId,
          manifestId,
          pinned,
          mountIndex,
          ownerAppId,
        }),
      ),
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
    this.emitOperation(this.getDownloadQueue())
  }

  private async pump(): Promise<QueuePreparationFailure | undefined> {
    if (this.#pumpPromise) return this.#pumpPromise
    if (
      this.#shuttingDown ||
      ['active', 'paused', 'resumable'].includes(this.#state.status)
    )
      return
    const pumping = (async (): Promise<QueuePreparationFailure | undefined> => {
      let firstFailure: QueuePreparationFailure | undefined
      while (!this.#shuttingDown) {
        const item = this.database.claimFirstApplicationQueueItem(
          new Set(this.#repairRequirements.keys()),
          this.#queuePreparationFailures,
        )
        if (!item) return firstFailure
        try {
          const request = await this.requestForQueueItem(item)
          this.begin(request, true)
          return firstFailure
        } catch (error) {
          const operationFailure = operationError(error)
          this.database.restoreApplicationQueueItemAtFront(item)
          this.#queuePreparationFailures.add(item.id)
          firstFailure ??= { itemId: item.id, error: operationFailure }
          this.emitState()
          this.reportError(diagnosticOperationError(operationFailure), {
            appId: item.appId,
            kind: item.kind,
          })
        }
      }
      return firstFailure
    })()
    this.#pumpPromise = pumping
    try {
      await pumping
    } finally {
      if (this.#pumpPromise === pumping) this.#pumpPromise = undefined
    }
  }

  private async requestForQueueItem(
    item: ApplicationQueueItem,
  ): Promise<ApplicationPlanRequest> {
    const request: ApplicationPlanRequest = {
      kind: item.kind,
      appId: item.appId,
      installPath: item.installPath,
      manifestTargets: item.manifestTargets,
    }
    if (item.kind === 'download') request.requestedDepotIds = item.depotIds
    if (item.kind === 'reconcile') request.desiredDepotIds = item.depotIds
    if (item.kind === 'repair') {
      request.desiredDepotIds = this.database
        .getInstalls(item.appId)
        .map(({ depotId }) => depotId)
      if (this.#repairRequirements.has(item.appId)) {
        request.fixedDesired =
          (await archiveUnresolvedApplicationTransaction(item.installPath)) ??
          undefined
        if (
          this.#state.status === 'repair-required' &&
          this.#state.appId === item.appId
        )
          this.#state = { status: 'idle' }
      }
    }
    return request
  }
}

function queueItemSnapshot(item: ApplicationQueueItem) {
  return {
    id: item.id,
    appId: item.appId,
    kind: item.kind,
    installPath: item.installPath,
    desiredDepotIds: [...item.depotIds],
    createdAt: item.createdAt,
  }
}

function diagnosticOperationError(error: Error): Error {
  const serialized = serializeOperationError(error)
  const diagnostic = new Error(serialized.message)
  diagnostic.name = `OperationError:${serialized.kind}`
  return diagnostic
}

function isCancelledFailure(
  shuttingDown: boolean,
  cancelRequested: boolean,
  pauseRequested: boolean,
  signal: AbortSignal,
  failure: Error,
): boolean {
  return (
    !shuttingDown &&
    (cancelRequested ||
      (!pauseRequested && (signal.aborted || isOperationCancellation(failure))))
  )
}

function validateManifestTargets(
  targets: StartDownloadRequest['manifestTargets'],
  desiredDepotIds: number[],
): void {
  if (!targets) return
  const desired = new Set(desiredDepotIds)
  const seen = new Set<number>()
  for (const target of targets) {
    validateId(target.depotId, 'depotId')
    validateManifestId(target.manifestId)
    if (!desired.has(target.depotId))
      throw new Error('Manifest target must belong to a selected depot')
    if (seen.has(target.depotId))
      throw new Error('Manifest targets must not contain duplicate depots')
    seen.add(target.depotId)
  }
}

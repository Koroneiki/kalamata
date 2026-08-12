import type { ReconcileApplicationOptions } from '../depot/depot-download-service.ts'
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
import type { KalamataDatabase } from '../../db/database.ts'
import { validateId, validateManifestId } from '../../db/validation.ts'
import type {
  ActiveOperationState,
  ApplicationOperationPreview,
  CancelOperationResult,
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
  ): Promise<ApplicationOperationPreview>
}

export class DownloadQueueCoordinator {
  #state: OperationState = { status: 'idle' }
  #controller: AbortController | undefined
  #runPromise: Promise<void> | undefined
  #commitStarted = false
  #shuttingDown = false
  #acceptingAppId: number | null = null
  #acceptanceDone: Promise<void> | undefined
  #controlPromise: Promise<unknown> | undefined
  #resolveAcceptance: (() => void) | undefined
  #operationId = 0
  #progressQueued = false
  #currentRequest: ApplicationPlanRequest | undefined
  #pausing = false
  #cancelRequested = false
  readonly #repairRequirements = new Map<number, string>()

  constructor(
    private readonly steam: QueueSteamService,
    private readonly database: KalamataDatabase,
    private readonly emitOperation: (state: OperationState) => void = () => {},
  ) {}

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

  async start(request: StartDownloadRequest): Promise<ActiveOperationState> {
    validateId(request.appId, 'appId')
    validateDepotIds(request.depotIds, false)
    validateManifestTargets(request.manifestTargets, request.depotIds)
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
          manifestTargets: request.manifestTargets,
        },
        true,
      )
      return active
    } finally {
      this.releaseAcceptance()
    }
  }

  async queueDepotUpdate(
    request: QueueDepotUpdateRequest,
  ): Promise<ActiveOperationState> {
    validateId(request.appId, 'appId')
    validateDepotIds(request.desiredDepotIds, true)
    validateManifestTargets(request.manifestTargets, request.desiredDepotIds)
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
          manifestTargets: request.manifestTargets,
        },
        true,
      )
    } finally {
      this.releaseAcceptance()
    }
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
            installPath: entry?.installPath ?? '',
            requestedDepotIds: request.desiredDepotIds,
            manifestTargets: request.manifestTargets,
          },
      this.steam,
      this.database,
      new AbortController().signal,
      () => {},
    )
    if (!this.steam.previewApplicationOperation)
      throw new Error('Application operation preview is unavailable')
    return this.steam.previewApplicationOperation(request.appId, plan)
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
      throw new Error('Operation could not be paused durably')
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
      throw new Error(
        'The application must be repaired before another operation',
      )
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
    request: ApplicationPlanRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const { installedDepots, desiredDepots, desiredDepotIds } =
        await planApplication(
          request,
          this.steam,
          this.database,
          signal,
          (depotIds) => {
            if (this.#state.status === 'active')
              this.#state = { ...this.#state, desiredDepotIds: depotIds }
          },
        )
      // Selection is user intent and persists before transactional file changes.
      if (request.kind === 'reconcile')
        this.database.replaceSelectedDepotIds(request.appId, desiredDepotIds)
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
    } catch (error) {
      const serialized = serializeOperationError(error)
      const shuttingDown = isOperationShutdown(error, signal)
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
      const paused = pauseRequested && resumable?.paused === true
      const cancelled =
        !shuttingDown &&
        (this.#cancelRequested ||
          (!pauseRequested &&
            (signal.aborted || isOperationCancellation(error))))
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
                    'The interrupted installation cannot be verified. Repair is required.',
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
    request: ApplicationPlanRequest,
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
    const operation = structuredClone(this.#state)
    this.emitOperation(operation)
  }
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

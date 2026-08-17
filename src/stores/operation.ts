import { useQueryCache } from '@pinia/colada'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

import { startDownload } from '@/api/downloads'
import {
  cancelOperation,
  getDownloadQueue,
  pauseOperation,
  prioritizeQueuedOperation,
  queueDepotUpdate,
  repairApplication,
  removeQueuedOperation,
  resumeOperation,
} from '@/api/operations'
import {
  getDownloadQueueMessageSequence,
  subscribeToDownloadQueue,
} from '@/api/transport'
import { appQueryKeys, libraryQueryKey } from '@/composables/queries'
import { useDepotOperationDraftStore } from '@/stores/depot-operation-drafts'
import type {
  DownloadQueueSnapshot,
  OperationState,
  PendingDownload,
  QueueDepotUpdateRequest,
  RepairApplicationRequest,
  StartDownloadRequest,
} from '@/types/rpc'
import {
  acceptedIntentAppIds,
  isAppInDownloads as appIsInDownloads,
  resolveAcceptedDesiredDepotIds,
} from '@/utils/depot-operation'

const persistedTransitionStates = new Set([
  'completed',
  'cancelled',
  'failed',
  'repair-required',
])

export const useOperationStore = defineStore('operation', () => {
  const queryCache = useQueryCache()
  const depotDrafts = useDepotOperationDraftStore()
  const state = shallowRef<OperationState>({ status: 'idle' })
  const pending = shallowRef<PendingDownload[]>([])
  const repairRequiredAppIds = shallowRef<number[]>([])
  const initialized = ref(false)
  const initializationError = ref<string | null>(null)
  let initializePromise: Promise<void> | undefined
  let unsubscribe: (() => void) | undefined

  function invalidateApplication(appId: number) {
    void Promise.all([
      queryCache.invalidateQueries({ key: libraryQueryKey, exact: true }),
      queryCache.invalidateQueries({
        key: appQueryKeys.details(appId),
        exact: true,
      }),
      queryCache.invalidateQueries({
        key: appQueryKeys.summary(appId),
        exact: true,
      }),
    ])
  }

  function applySnapshot(snapshot: DownloadQueueSnapshot) {
    const next = snapshot.operation
    const previous = state.value
    state.value = next
    pending.value = snapshot.pending
    repairRequiredAppIds.value = snapshot.repairRequiredAppIds
    for (const appId of acceptedIntentAppIds(snapshot)) depotDrafts.clear(appId)
    if (
      next.status !== 'idle' &&
      'appId' in next &&
      persistedTransitionStates.has(next.status) &&
      (previous.status !== next.status ||
        !('appId' in previous) ||
        previous.appId !== next.appId)
    )
      invalidateApplication(next.appId)
  }

  function initialize() {
    if (initializePromise) return initializePromise
    initializePromise = (async () => {
      unsubscribe ??= subscribeToDownloadQueue(applySnapshot)
      const sequence = getDownloadQueueMessageSequence()
      initializationError.value = null
      try {
        const snapshot = await getDownloadQueue()
        // Do not let an older RPC snapshot overwrite a newer pushed state.
        if (getDownloadQueueMessageSequence() === sequence)
          applySnapshot(snapshot)
        initialized.value = true
      } catch (error) {
        initialized.value = false
        initializationError.value =
          error instanceof Error ? error.message : String(error)
      } finally {
        initializePromise = undefined
      }
    })()
    return initializePromise
  }

  async function refreshIfNoMessage(sequence: number) {
    if (getDownloadQueueMessageSequence() !== sequence) return
    const snapshot = await getDownloadQueue()
    if (getDownloadQueueMessageSequence() === sequence) applySnapshot(snapshot)
  }

  async function install(request: StartDownloadRequest) {
    const sequence = getDownloadQueueMessageSequence()
    const result = await startDownload(request)
    if (getDownloadQueueMessageSequence() === sequence) applySnapshot(result)
    return result
  }

  async function reconcile(request: QueueDepotUpdateRequest) {
    const sequence = getDownloadQueueMessageSequence()
    const result = await queueDepotUpdate(request)
    if (getDownloadQueueMessageSequence() === sequence) applySnapshot(result)
    return result
  }

  async function verify(request: RepairApplicationRequest) {
    const sequence = getDownloadQueueMessageSequence()
    const result = await repairApplication(request)
    if (getDownloadQueueMessageSequence() === sequence) applySnapshot(result)
    return result
  }

  async function pause() {
    const sequence = getDownloadQueueMessageSequence()
    const result = await pauseOperation()
    if (result.accepted) await refreshIfNoMessage(sequence)
    return result
  }

  async function resume() {
    const sequence = getDownloadQueueMessageSequence()
    const result = await resumeOperation()
    if (result.accepted) await refreshIfNoMessage(sequence)
    return result
  }

  async function cancel() {
    const sequence = getDownloadQueueMessageSequence()
    const result = await cancelOperation()
    if (result.accepted) await refreshIfNoMessage(sequence)
    return result
  }

  function isAppInDownloads(appId: number) {
    return appIsInDownloads(
      state.value,
      pending.value,
      repairRequiredAppIds.value,
      appId,
    )
  }

  function acceptedDesiredDepotIds(appId: number): number[] | null {
    return resolveAcceptedDesiredDepotIds(state.value, pending.value, appId)
  }

  function isRepairRequired(appId: number) {
    return repairRequiredAppIds.value.includes(appId)
  }

  async function removePending(id: string) {
    const sequence = getDownloadQueueMessageSequence()
    const result = await removeQueuedOperation(id)
    if (getDownloadQueueMessageSequence() === sequence) applySnapshot(result)
    return result
  }

  async function prioritizePending(id: string) {
    const sequence = getDownloadQueueMessageSequence()
    const result = await prioritizeQueuedOperation(id)
    if (getDownloadQueueMessageSequence() === sequence) applySnapshot(result)
    return result
  }

  return {
    state,
    pending,
    initialized,
    initializationError,
    initialize,
    install,
    reconcile,
    verify,
    pause,
    resume,
    cancel,
    isAppInDownloads,
    acceptedDesiredDepotIds,
    isRepairRequired,
    removePending,
    prioritizePending,
  }
})

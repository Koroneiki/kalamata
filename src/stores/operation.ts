import { useQueryCache } from '@pinia/colada'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

import { startDownload } from '@/api/downloads'
import {
  cancelOperation,
  getOperationState,
  pauseOperation,
  queueDepotUpdate,
  repairApplication,
  resumeOperation,
} from '@/api/operations'
import {
  getOperationStateMessageSequence,
  subscribeToOperationState,
} from '@/api/transport'
import { appQueryKeys, libraryQueryKey } from '@/composables/queries'
import type {
  OperationState,
  QueueDepotUpdateRequest,
  RepairApplicationRequest,
  StartDownloadRequest,
} from '@/types/rpc'

const persistedTransitionStates = new Set([
  'completed',
  'cancelled',
  'failed',
  'repair-required',
])

export const useOperationStore = defineStore('operation', () => {
  const queryCache = useQueryCache()
  const state = shallowRef<OperationState>({ status: 'idle' })
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

  function applyState(next: OperationState) {
    const previous = state.value
    state.value = next
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
      unsubscribe = subscribeToOperationState(applyState)
      const sequence = getOperationStateMessageSequence()
      try {
        const snapshot = await getOperationState()
        // Do not let an older RPC snapshot overwrite a newer pushed state.
        if (getOperationStateMessageSequence() === sequence)
          applyState(snapshot)
      } catch (error) {
        initializationError.value =
          error instanceof Error ? error.message : String(error)
      } finally {
        initialized.value = true
      }
    })()
    return initializePromise
  }

  async function refreshIfNoMessage(sequence: number) {
    if (getOperationStateMessageSequence() !== sequence) return
    const snapshot = await getOperationState()
    if (getOperationStateMessageSequence() === sequence) applyState(snapshot)
  }

  async function install(request: StartDownloadRequest) {
    const sequence = getOperationStateMessageSequence()
    const result = await startDownload(request)
    if (getOperationStateMessageSequence() === sequence) applyState(result)
    return result
  }

  async function reconcile(request: QueueDepotUpdateRequest) {
    const sequence = getOperationStateMessageSequence()
    const result = await queueDepotUpdate(request)
    if (getOperationStateMessageSequence() === sequence) applyState(result)
    return result
  }

  async function verify(request: RepairApplicationRequest) {
    const sequence = getOperationStateMessageSequence()
    const result = await repairApplication(request)
    if (getOperationStateMessageSequence() === sequence) applyState(result)
    return result
  }

  async function pause() {
    const sequence = getOperationStateMessageSequence()
    const result = await pauseOperation()
    if (result.accepted) await refreshIfNoMessage(sequence)
    return result
  }

  async function resume() {
    const sequence = getOperationStateMessageSequence()
    const result = await resumeOperation()
    if (result.accepted) await refreshIfNoMessage(sequence)
    return result
  }

  async function cancel() {
    const sequence = getOperationStateMessageSequence()
    const result = await cancelOperation()
    if (result.accepted) await refreshIfNoMessage(sequence)
    return result
  }

  function dispose() {
    unsubscribe?.()
    unsubscribe = undefined
  }

  return {
    state,
    initialized,
    initializationError,
    initialize,
    install,
    reconcile,
    verify,
    pause,
    resume,
    cancel,
    dispose,
  }
})

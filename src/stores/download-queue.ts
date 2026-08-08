import { useQueryCache } from '@pinia/colada'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

import {
  getDownloadState,
  startDownload as requestDownloadStart,
} from '@/api/downloads'
import {
  getDownloadStateMessageSequence,
  subscribeToDownloadState,
} from '@/api/transport'
import { appQueryKeys, libraryQueryKey } from '@/composables/queries'
import type { DownloadQueueState, StartDownloadRequest } from '@/types/rpc'

function hasNewCompletedDepot(
  previous: DownloadQueueState,
  next: DownloadQueueState,
) {
  if (next.status === 'idle') return false

  const previousCompleted =
    previous.status === 'idle' ? [] : previous.completedDepotIds

  return next.completedDepotIds.some(
    (depotId) => !previousCompleted.includes(depotId),
  )
}

function isNewTerminalState(
  previous: DownloadQueueState,
  next: DownloadQueueState,
) {
  if (next.status !== 'completed' && next.status !== 'failed') return false

  return previous.status !== next.status
}

export const useDownloadQueueStore = defineStore('download-queue', () => {
  const queryCache = useQueryCache()
  const state = shallowRef<DownloadQueueState>({ status: 'idle' })
  const initialized = ref(false)
  const initializationError = ref<string | null>(null)
  let initializePromise: Promise<void> | undefined
  let unsubscribe: (() => void) | undefined

  function invalidateInstalledState(appId: number) {
    void Promise.all([
      queryCache.invalidateQueries({ key: libraryQueryKey }),
      queryCache.invalidateQueries({ key: appQueryKeys.details(appId) }),
    ])
  }

  function applyMessage(next: DownloadQueueState) {
    const previous = state.value
    state.value = next

    if (
      next.status !== 'idle' &&
      (hasNewCompletedDepot(previous, next) ||
        isNewTerminalState(previous, next))
    ) {
      invalidateInstalledState(next.appId)
    }
  }

  function initialize() {
    if (initializePromise) return initializePromise

    initializePromise = (async () => {
      unsubscribe = subscribeToDownloadState(applyMessage)
      const sequenceBeforeRequest = getDownloadStateMessageSequence()

      try {
        const initialState = await getDownloadState()

        // A message received while the snapshot request was pending is newer.
        if (getDownloadStateMessageSequence() === sequenceBeforeRequest) {
          state.value = initialState
        }
      } catch (error) {
        initializationError.value =
          error instanceof Error ? error.message : String(error)
      } finally {
        initialized.value = true
      }
    })()

    return initializePromise
  }

  async function startDownload(request: StartDownloadRequest) {
    const sequenceBeforeRequest = getDownloadStateMessageSequence()
    const runningState = await requestDownloadStart(request)

    if (getDownloadStateMessageSequence() === sequenceBeforeRequest) {
      state.value = runningState
    }

    return runningState
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
    startDownload,
    dispose,
  }
})

import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

import {
  cancelColdClientOperation,
  getColdClientOperation,
} from '@/api/cold-client'
import {
  getColdClientOperationMessageSequence,
  subscribeToColdClientOperation,
} from '@/api/transport'
import type { ColdClientOperationSnapshot } from '@/types/cold-client'

export const useColdClientOperationStore = defineStore(
  'cold-client-operation',
  () => {
    const state = shallowRef<ColdClientOperationSnapshot>({ status: 'idle' })
    const initialized = ref(false)
    const initializationError = ref<string | null>(null)
    let initializePromise: Promise<void> | undefined
    let unsubscribe: (() => void) | undefined

    function applySnapshot(snapshot: ColdClientOperationSnapshot) {
      state.value = snapshot
    }

    function initialize() {
      if (initializePromise) return initializePromise
      initializePromise = (async () => {
        unsubscribe ??= subscribeToColdClientOperation(applySnapshot)
        const sequence = getColdClientOperationMessageSequence()
        initializationError.value = null
        try {
          const snapshot = await getColdClientOperation()
          if (getColdClientOperationMessageSequence() === sequence)
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

    async function cancel(appId: number) {
      const sequence = getColdClientOperationMessageSequence()
      const result = await cancelColdClientOperation(appId)
      if (
        result.accepted &&
        getColdClientOperationMessageSequence() === sequence
      ) {
        const snapshot = await getColdClientOperation()
        if (getColdClientOperationMessageSequence() === sequence)
          applySnapshot(snapshot)
      }
      return result
    }

    return { state, initialized, initializationError, initialize, cancel }
  },
)

import { useQueryCache } from '@pinia/colada'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

import {
  cancelColdClientOperation,
  getColdClientOperation,
} from '@/api/cold-client'
import {
  getColdClientOperationMessageSequence,
  subscribeToColdClientOperation,
} from '@/api/transport'
import type { ColdClientOperationSnapshot } from '@/types/cold-client'
import { coldClientQueryKeys } from '@/composables/queries'

export const useColdClientOperationStore = defineStore(
  'cold-client-operation',
  () => {
    const queryCache = useQueryCache()
    const state = shallowRef<ColdClientOperationSnapshot>({ status: 'idle' })
    let initializePromise: Promise<void> | undefined
    let unsubscribe: (() => void) | undefined

    function applySnapshot(snapshot: ColdClientOperationSnapshot) {
      const previous = state.value
      state.value = snapshot
      if (previous.status === 'active' && snapshot.status === 'idle') {
        void queryCache.invalidateQueries({
          key: coldClientQueryKeys.status(previous.appId),
          exact: true,
        })
      }
    }

    function initialize() {
      if (initializePromise) return initializePromise
      initializePromise = (async () => {
        unsubscribe ??= subscribeToColdClientOperation(applySnapshot)
        const sequence = getColdClientOperationMessageSequence()
        try {
          const snapshot = await getColdClientOperation()
          if (getColdClientOperationMessageSequence() === sequence)
            applySnapshot(snapshot)
        } catch {
          // A later native message still initializes state after a missed replay.
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

    return { state, initialize, cancel }
  },
)

import { useQueryCache } from '@pinia/colada'
import { watch } from 'vue'

import { getAppSummary } from '@/api/apps'
import { appQueryKeys } from '@/composables/queries'
import { appToast } from '@/lib/toast'
import { useOperationStore } from '@/stores/operation'
import type { AppSummary } from '@/types/rpc'
import { operationCompletionMessage } from '@/utils/operation'

function appName(summary: AppSummary | null, appId: number) {
  return summary ? summary.name : `App ${appId}`
}

export function useOperationToasts() {
  const operation = useOperationStore()
  const queryCache = useQueryCache()
  let lastFailureKey = ''

  async function appSummary(appId: number): Promise<AppSummary | null> {
    const cached =
      queryCache.getQueryData<AppSummary>(appQueryKeys.summary(appId)) ??
      queryCache.getQueryData<AppSummary>(appQueryKeys.details(appId))
    if (cached) return cached

    try {
      return await getAppSummary(appId)
    } catch {
      return null
    }
  }

  watch(
    () => operation.state,
    async (state) => {
      if (!operation.initialized || state.status !== 'failed') {
        lastFailureKey = ''
        return
      }
      const failureKey = `${state.appId}\0${state.error.kind}\0${state.error.message}`
      if (failureKey === lastFailureKey) return
      lastFailureKey = failureKey

      const summary = await appSummary(state.appId)
      appToast.error(`${appName(summary, state.appId)} failed`, {
        description: state.error.message,
      })
    },
    { flush: 'sync' },
  )

  watch(
    () => operation.state,
    async (state, previous) => {
      if (
        !operation.initialized ||
        state.status !== 'completed' ||
        (previous.status === 'completed' &&
          'appId' in previous &&
          previous.appId === state.appId)
      )
        return

      const summary = await appSummary(state.appId)
      appToast.gameCompletion(
        appName(summary, state.appId),
        summary?.iconUrls[0] ?? null,
        operationCompletionMessage(state.kind, state.desiredDepotIds),
      )
    },
    // Operation messages can arrive in one tick; observe every terminal transition.
    { flush: 'sync' },
  )
}

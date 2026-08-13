import { useQueryCache } from '@pinia/colada'
import { watch } from 'vue'
import { toast } from 'vue-sonner'

import { getAppSummary } from '@/api/apps'
import GameCompletionToast from '@/components/shared/GameCompletionToast.vue'
import { appQueryKeys } from '@/composables/queries'
import { useOperationStore } from '@/stores/operation'
import type { AppSummary } from '@/types/rpc'
import { operationCompletionMessage } from '@/utils/operation'

export function useOperationToasts() {
  const operation = useOperationStore()
  const queryCache = useQueryCache()

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
      toast.custom(GameCompletionToast, {
        componentProps: {
          name: summary?.name ?? `App ${state.appId}`,
          iconUrl: summary?.iconUrls[0] ?? null,
          message: operationCompletionMessage(
            state.kind,
            state.desiredDepotIds,
          ),
        },
        duration: 6_000,
        class:
          'game-completion-toast !w-88 !max-w-[calc(100vw-2rem)] !border-primary/25 !bg-card !p-0 !text-card-foreground',
      })
    },
    // Operation messages can arrive in one tick; observe every terminal transition.
    { flush: 'sync' },
  )
}

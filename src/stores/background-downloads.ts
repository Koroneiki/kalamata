import { useQueryCache } from '@pinia/colada'
import { defineStore } from 'pinia'
import { onScopeDispose, shallowRef } from 'vue'
import {
  dismissBackgroundDownload,
  getBackgroundDownloads,
  prioritizeBackgroundDownload,
  retryBackgroundDownload,
} from '@/api/background-downloads'
import {
  getBackgroundDownloadsMessageSequence,
  subscribeToBackgroundDownloads,
} from '@/api/transport'
import {
  appQueryKeys,
  coldClientQueryKeys,
  libraryQueryKey,
} from '@/composables/queries'
import type { BackgroundDownloadsSnapshot } from '@/types/background-downloads'

export const useBackgroundDownloadsStore = defineStore(
  'background-downloads',
  () => {
    const jobs = shallowRef<BackgroundDownloadsSnapshot['jobs']>([])
    const queryCache = useQueryCache()
    let initialization: Promise<void> | undefined
    let unsubscribe: (() => void) | undefined
    onScopeDispose(() => unsubscribe?.())

    function apply(snapshot: BackgroundDownloadsSnapshot) {
      const prior = new Map(jobs.value.map((job) => [job.id, job.status]))
      jobs.value = snapshot.jobs
      for (const job of snapshot.jobs) {
        if (job.status !== 'completed' || prior.get(job.id) === 'completed')
          continue
        void queryCache.invalidateQueries({ key: libraryQueryKey, exact: true })
        if (job.appId !== null) {
          void queryCache.invalidateQueries({
            key: appQueryKeys.details(job.appId),
            exact: true,
          })
          void queryCache.invalidateQueries({
            key: appQueryKeys.summary(job.appId),
            exact: true,
          })
          void queryCache.invalidateQueries({
            key: coldClientQueryKeys.status(job.appId),
            exact: true,
          })
        }
      }
    }

    function initialize() {
      if (initialization) return initialization
      initialization = (async () => {
        unsubscribe ??= subscribeToBackgroundDownloads(apply)
        const sequence = getBackgroundDownloadsMessageSequence()
        try {
          const snapshot = await getBackgroundDownloads()
          if (getBackgroundDownloadsMessageSequence() === sequence)
            apply(snapshot)
        } finally {
          initialization = undefined
        }
      })()
      return initialization
    }

    return {
      jobs,
      initialize,
      prioritize: prioritizeBackgroundDownload,
      retry: retryBackgroundDownload,
      dismiss: dismissBackgroundDownload,
    }
  },
)

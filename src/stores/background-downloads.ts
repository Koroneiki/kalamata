import { useQueryCache } from '@pinia/colada'
import { defineStore } from 'pinia'
import { onScopeDispose, shallowRef } from 'vue'
import { getBackgroundDownloads } from '@/api/background-downloads'
import {
  getBackgroundDownloadsMessageSequence,
  subscribeToBackgroundDownloads,
  subscribeToUpdateStatuses,
} from '@/api/transport'
import {
  appQueryKeys,
  applicationUpdateQueryKey,
  coldClientDependenciesQueryKey,
  coldClientQueryKeys,
  libraryQueryKey,
} from '@/composables/queries'
import { useDownloadTransfer } from '@/composables/use-download-transfer'
import type { BackgroundDownloadsSnapshot } from '@/types/background-downloads'

export const useBackgroundDownloadsStore = defineStore(
  'background-downloads',
  () => {
    const jobs = shallowRef<BackgroundDownloadsSnapshot['jobs']>([])
    // Background transfers keep their measurement even when no page shows them.
    const { bytesPerSecond, remainingSeconds } = useDownloadTransfer(() => {
      const job = jobs.value.find((candidate) => candidate.status === 'active')
      if (!job || job.phase.toLowerCase() !== 'downloading') return null
      return {
        key: `${job.id}:${job.source}:${job.manifestProgress?.currentIndex}`,
        bytes: job.transferredBytes,
        // A manifest group has no reliable total until all its children finish.
        total: job.totalBytes,
      }
    })
    const queryCache = useQueryCache()
    let initialization: Promise<void> | undefined
    let unsubscribe: (() => void) | undefined
    let unsubscribeUpdates: (() => void) | undefined
    onScopeDispose(() => {
      unsubscribe?.()
      unsubscribeUpdates?.()
    })

    function apply(snapshot: BackgroundDownloadsSnapshot) {
      const prior = new Map(jobs.value.map((job) => [job.id, job.status]))
      jobs.value = snapshot.jobs
      for (const job of snapshot.jobs) {
        if (job.status !== 'completed' || prior.get(job.id) === 'completed')
          continue
        void queryCache.invalidateQueries({ key: libraryQueryKey, exact: true })
        if (job.kind === 'dependency') {
          void queryCache.invalidateQueries({
            key: coldClientDependenciesQueryKey,
            exact: true,
          })
          void queryCache.invalidateQueries({ key: coldClientQueryKeys.all })
        }
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
        unsubscribeUpdates ??= subscribeToUpdateStatuses(
          (status) =>
            queryCache.setQueryData(applicationUpdateQueryKey, status),
          (status) =>
            queryCache.setQueryData(coldClientDependenciesQueryKey, status),
        )
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
      bytesPerSecond,
      remainingSeconds,
      initialize,
    }
  },
)

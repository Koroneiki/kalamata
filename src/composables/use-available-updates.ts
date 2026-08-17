import { useQueryCache } from '@pinia/colada'
import { computed, ref } from 'vue'

import { getLibrary } from '@/api/library'
import {
  appQueryKeys,
  availableUpdateQuery,
  fetchAvailableUpdate,
  fetchAvailableUpdates,
  libraryQueryKey,
} from '@/composables/queries'
import type { AvailableUpdateResult } from '@/types/rpc'
import { AvailableUpdateScan } from './available-update-scan'

const appIds = ref<number[]>([])
const running = ref(false)
const checked = ref(0)
const total = ref(0)
const scanError = ref<string | null>(null)
let scanner: AvailableUpdateScan | undefined

export function useAvailableUpdates() {
  const queryCache = useQueryCache()
  const results = computed(() =>
    appIds.value.flatMap((appId) => {
      const entry = queryCache.get<AvailableUpdateResult>(
        appQueryKeys.availableUpdate(appId),
      )
      const data = entry?.state.value.data
      return data ? [data] : []
    }),
  )
  const candidates = computed(() =>
    results.value.flatMap((result) =>
      result.status === 'available' ? [result.candidate] : [],
    ),
  )
  const failures = computed(() =>
    results.value.filter((result) => result.status === 'error'),
  )

  function clearResult(appId: number) {
    const entry = queryCache.get(appQueryKeys.availableUpdate(appId))
    if (!entry) return
    queryCache.cancel(entry)
    queryCache.remove(entry)
  }

  scanner ??= new AvailableUpdateScan({
    getLibrary: async () => {
      const library = await getLibrary()
      queryCache.setQueryData(libraryQueryKey, library)
      appIds.value = library.flatMap(({ appId, hasInstalledDepots }) =>
        hasInstalledDepots ? [appId] : [],
      )
      return library
    },
    check: fetchAvailableUpdate,
    checkBatch: fetchAvailableUpdates,
    commit: (appId, result) => {
      queryCache.ensure(availableUpdateQuery(appId))
      queryCache.setQueryData(appQueryKeys.availableUpdate(appId), result)
    },
    clear: clearResult,
    remove: (appId) => {
      appIds.value = appIds.value.filter((id) => id !== appId)
      clearResult(appId)
    },
    scanError: (message) => {
      scanError.value = message
    },
    progress: (progress) => {
      running.value = progress.running
      checked.value = progress.checked
      total.value = progress.total
    },
  })

  async function retryFailed() {
    await scanner!.retry(failures.value.map(({ appId }) => appId))
  }

  async function refreshApp(appId: number) {
    await scanner!.refreshApp(appId)
  }

  async function syncApp(appId: number) {
    clearResult(appId)
    const library = await getLibrary()
    queryCache.setQueryData(libraryQueryKey, library)
    const installed = library.some(
      (entry) => entry.appId === appId && entry.hasInstalledDepots,
    )
    if (!installed) {
      scanner!.removeApp(appId)
      return
    }
    scanner!.addApp(appId)
    if (!appIds.value.includes(appId)) appIds.value = [...appIds.value, appId]
    await scanner!.refreshApp(appId)
  }

  function invalidateApp(appId: number) {
    return queryCache.invalidateQueries(
      { key: appQueryKeys.availableUpdate(appId), exact: true },
      false,
    )
  }

  function removeApp(appId: number) {
    scanner!.removeApp(appId)
  }

  return {
    running,
    checked,
    total,
    scanError,
    results,
    candidates,
    failures,
    refreshAll: () => scanner!.refreshAll(),
    retryFailed,
    refreshApp,
    syncApp,
    invalidateApp,
    removeApp,
  }
}

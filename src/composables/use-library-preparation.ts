import { useQueryCache } from '@pinia/colada'
import { watch, type Ref } from 'vue'

import { getAppDetails, getAppDetailsBatch } from '@/api/apps'
import {
  appQueryKeys,
  useLibraryQuery,
  useSettingsQuery,
} from '@/composables/queries'
import { useDepotResourceAcquisition } from '@/composables/use-depot-resource-acquisition'
import { appToast } from '@/lib/toast'
import type { AppDetails } from '@/types/rpc'
import { AVAILABLE_UPDATE_BATCH_SIZE } from '@/types/available-updates'
import { LibraryResourcePreparation } from './library-resource-preparation'
import { invalidateResourceAcquisitions } from './resource-acquisition-cache'

// The library snapshot is shared with the sidebar and update scan. New entries
// join the same serial queue; neither startup nor navigation waits for it.
export function useLibraryPreparation(initialized: Readonly<Ref<boolean>>) {
  const { data: library } = useLibraryQuery()
  const { data: settings } = useSettingsQuery()
  const queryCache = useQueryCache()
  const acquisition = useDepotResourceAcquisition()
  const queued = new Set<number>()
  const seen = new Set<number>()
  const resources = new LibraryResourcePreparation(acquisition, (error) =>
    appToast.error(error.message),
  )
  let running = false
  let previousAcquisitionSettings: string | undefined

  async function prepare(app: AppDetails) {
    const appId = app.appId
    if (!library.value?.some((entry) => entry.appId === appId)) return
    if (await resources.prepare(app, settings.value))
      await queryCache.invalidateQueries({
        key: appQueryKeys.details(appId),
        exact: true,
      })
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (queued.size && settings.value?.automaticManifestAcquisition) {
        const ids = [...queued].slice(0, AVAILABLE_UPDATE_BATCH_SIZE)
        for (const id of ids) queued.delete(id)
        const present = ids.filter((id) =>
          library.value?.some((entry) => entry.appId === id),
        )
        if (!present.length) continue
        let details: AppDetails[]
        try {
          details = await getAppDetailsBatch(present)
        } catch {
          // A batch-level failure must not starve the rest of the library.
          details = (
            await Promise.all(
              present.map((id) => getAppDetails(id).catch(() => null)),
            )
          ).filter((app): app is AppDetails => app !== null)
        }
        const preparedIds = new Set(details.map(({ appId }) => appId))
        for (const id of present) if (!preparedIds.has(id)) seen.delete(id)
        await Promise.all(
          details.map((app) =>
            prepare(app).catch((error) => {
              appToast.error(
                error instanceof Error ? error.message : String(error),
              )
            }),
          ),
        )
      }
    } finally {
      running = false
    }
  }

  watch(
    [
      library,
      initialized,
      () => settings.value?.automaticManifestAcquisition,
      () => settings.value?.platforms,
      () => settings.value?.hubcapApiKey,
    ],
    ([entries]) => {
      if (!entries || !initialized.value) return
      const current = new Set(entries.map(({ appId }) => appId))
      for (const id of queued) if (!current.has(id)) queued.delete(id)
      for (const id of seen) {
        if (current.has(id)) continue
        seen.delete(id)
        resources.forget(id)
        invalidateResourceAcquisitions(queryCache)
      }
      const acquisitionSettings = JSON.stringify([
        settings.value?.automaticManifestAcquisition,
        settings.value?.platforms,
        settings.value?.hubcapApiKey,
      ])
      const settingsChanged =
        acquisitionSettings !== previousAcquisitionSettings
      if (settingsChanged && previousAcquisitionSettings !== undefined)
        for (const id of seen) resources.forget(id)
      previousAcquisitionSettings = acquisitionSettings
      if (!settings.value?.automaticManifestAcquisition) {
        queued.clear()
        return
      }
      for (const entry of entries) {
        if (seen.has(entry.appId) && !settingsChanged) continue
        seen.add(entry.appId)
        queued.add(entry.appId)
      }
      void drain()
    },
    { immediate: true },
  )
}

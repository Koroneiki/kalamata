import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue'

import type { EligibleAppDepot } from '../types/rpc'

export function useCustomManifest(options: {
  appId: MaybeRefOrGetter<number>
  customManifestTargets: MaybeRefOrGetter<ReadonlyMap<number, string>>
  acquiringManifests: Set<string>
  setCustomManifestTarget: (depotId: number, manifestId: string) => void
  removeCustomManifestTarget: (depotId: number) => void
  acquireDepotKeys: (appId: number, depotIds: number[]) => Promise<number[]>
  acquireManifest: (
    appId: number,
    depotId: number,
    manifestId: string,
  ) => Promise<void>
  setDepotPinned: (
    appId: number,
    depotId: number,
    pinned: boolean,
  ) => Promise<void>
  invalidateDetails: (appId: number) => Promise<void>
  onPinChanged?: (appId: number) => Promise<void>
}) {
  const customManifestTargets = computed(() =>
    toValue(options.customManifestTargets),
  )
  const customManifestDialogOpen = ref(false)
  const customManifestDepot = ref<EligibleAppDepot | null>(null)
  const customManifestError = ref('')
  const customManifestAcquiring = ref(false)

  function isCurrentApp(targetAppId: number) {
    return toValue(options.appId) === targetAppId
  }

  function editCustomManifest(depot: EligibleAppDepot) {
    customManifestDepot.value = depot
    customManifestError.value = ''
    customManifestDialogOpen.value = true
  }

  function clearCustomManifest(depot: EligibleAppDepot) {
    options.removeCustomManifestTarget(depot.depotId)
  }

  function resetCustomManifests() {
    customManifestDialogOpen.value = false
    customManifestDepot.value = null
    customManifestError.value = ''
    customManifestAcquiring.value = false
  }

  async function acquireResources(
    targetAppId: number,
    depot: EligibleAppDepot,
    manifestId: string,
  ) {
    if (depot.keyStatus !== 'present') {
      const missingDepotIds = await options.acquireDepotKeys(targetAppId, [
        depot.depotId,
      ])
      if (missingDepotIds.includes(depot.depotId))
        throw new Error(`Depot key ${depot.depotId} is unavailable.`)
    }
    await options.acquireManifest(depot.ownerAppId, depot.depotId, manifestId)
  }

  async function pinInstalledManifest(
    targetAppId: number,
    depot: EligibleAppDepot,
  ) {
    if (depot.pinned) return
    await options.setDepotPinned(targetAppId, depot.depotId, true)
    await options.invalidateDetails(targetAppId)
    await options.onPinChanged?.(targetAppId)
  }

  async function selectInstalledManifest(
    targetAppId: number,
    depot: EligibleAppDepot,
  ) {
    await pinInstalledManifest(targetAppId, depot)
    if (!isCurrentApp(targetAppId)) return
    options.removeCustomManifestTarget(depot.depotId)
    customManifestDialogOpen.value = false
  }

  async function selectDownloadManifest(
    targetAppId: number,
    depot: EligibleAppDepot,
    manifestId: string,
  ) {
    if (!isCurrentApp(targetAppId)) return
    options.setCustomManifestTarget(depot.depotId, manifestId)
    customManifestDialogOpen.value = false
  }

  async function applyManifestTarget(
    targetAppId: number,
    depot: EligibleAppDepot,
    manifestId: string,
  ) {
    if (manifestId === depot.installedManifestId)
      return selectInstalledManifest(targetAppId, depot)
    await selectDownloadManifest(targetAppId, depot, manifestId)
  }

  async function setCustomManifest(manifestId: string) {
    const depot = customManifestDepot.value
    if (!depot) return
    const targetAppId = toValue(options.appId)
    const key = `${targetAppId}:${depot.depotId}:${manifestId}`
    customManifestError.value = ''
    customManifestAcquiring.value = true
    options.acquiringManifests.add(key)
    try {
      await acquireResources(targetAppId, depot, manifestId)
      await applyManifestTarget(targetAppId, depot, manifestId)
    } catch (error) {
      if (isCurrentApp(targetAppId))
        customManifestError.value =
          error instanceof Error ? error.message : String(error)
    } finally {
      options.acquiringManifests.delete(key)
      if (isCurrentApp(targetAppId)) customManifestAcquiring.value = false
    }
  }

  async function removeCustomManifest() {
    const depot = customManifestDepot.value
    if (!depot) return
    const targetAppId = toValue(options.appId)
    if (customManifestTargets.value.has(depot.depotId)) {
      clearCustomManifest(depot)
      customManifestDialogOpen.value = false
      return
    }
    if (depot.pinned) await unpinCustomManifest(targetAppId, depot)
  }

  async function unpinCustomManifest(
    targetAppId: number,
    depot: EligibleAppDepot,
  ) {
    customManifestError.value = ''
    customManifestAcquiring.value = true
    try {
      await options.setDepotPinned(targetAppId, depot.depotId, false)
      await options.invalidateDetails(targetAppId)
      await options.onPinChanged?.(targetAppId)
      if (isCurrentApp(targetAppId)) customManifestDialogOpen.value = false
    } catch (error) {
      if (isCurrentApp(targetAppId))
        customManifestError.value =
          error instanceof Error ? error.message : String(error)
    } finally {
      if (isCurrentApp(targetAppId)) customManifestAcquiring.value = false
    }
  }

  return {
    customManifestTargets,
    customManifestDialogOpen,
    customManifestDepot,
    customManifestError,
    customManifestAcquiring,
    editCustomManifest,
    clearCustomManifest,
    resetCustomManifests,
    setCustomManifest,
    removeCustomManifest,
  }
}

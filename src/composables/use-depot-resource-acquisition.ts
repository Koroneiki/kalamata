import { useQueryCache } from '@pinia/colada'

import { acquireDepotKeys, acquireManifest } from '@/api/apps'
import { appQueryKeys } from '@/composables/queries'
import { useManifestQueueStore } from '@/stores/manifest-queue'
import type { EligibleAppDepot } from '@/types/rpc'

export function useDepotResourceAcquisition() {
  const queryCache = useQueryCache()
  const manifestQueue = useManifestQueueStore()

  function beginManifestBatch(count: number) {
    return manifestQueue.begin(count)
  }

  function acquireKeys(appId: number, depotIds: number[]) {
    return acquireDepotKeys(appId, depotIds)
  }

  async function acquireManifestResource(
    ownerAppId: number,
    depotId: number,
    manifestId: string,
    queueId = manifestQueue.begin(1),
  ) {
    try {
      return await acquireManifest(ownerAppId, depotId, manifestId)
    } finally {
      manifestQueue.settle(queueId)
    }
  }

  async function acquireRequiredResources(
    appId: number,
    depots: EligibleAppDepot[],
  ) {
    const missingKeyIds = depots
      .filter(({ keyStatus }) => keyStatus !== 'present')
      .map(({ depotId }) => depotId)
    if (missingKeyIds.length) {
      const result = await acquireKeys(appId, missingKeyIds)
      if (result.missingDepotIds.length) {
        throw new Error(
          `Depot key ${result.missingDepotIds.join(', ')} is unavailable.`,
        )
      }
    }

    const missingManifests = depots.filter(
      (depot) => depot.manifestStatus !== 'ready' && depot.manifestId,
    )
    if (missingManifests.length) {
      const queueId = manifestQueue.begin(missingManifests.length)
      await Promise.all(
        missingManifests.map((depot) =>
          acquireManifestResource(
            depot.ownerAppId,
            depot.depotId,
            depot.manifestId!,
            queueId,
          ),
        ),
      )
    }

    await queryCache.invalidateQueries({
      key: appQueryKeys.details(appId),
      exact: true,
    })
  }

  return {
    beginManifestBatch,
    acquireKeys,
    acquireManifestResource,
    acquireRequiredResources,
  }
}

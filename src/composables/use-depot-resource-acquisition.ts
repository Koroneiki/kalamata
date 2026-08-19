import { useQueryCache } from '@pinia/colada'
import { toast } from 'vue-sonner'

import { acquireDepotKeys, acquireManifest } from '@/api/apps'
import { appQueryKeys, hubcapUsageQueryKey } from '@/composables/queries'
import { requestHubcapApproval } from '@/composables/use-hubcap-approval'
import { useManifestQueueStore } from '@/stores/manifest-queue'
import type { EligibleAppDepot } from '@/types/rpc'
import { acquiredDepotKeysResult } from '@/utils/depot-key-results'

const hubcapFailureFeedback = {
  'missing-key': () => toast.warning('No Hubcap API Key.'),
  'quota-exhausted': () => toast.warning('No Hubcap Quota left.'),
  'invalid-key': () => toast.error('Hubcap API Key invalid.'),
  'stats-unavailable': () => toast.error('Hubcap quota check failed.'),
}

export function useDepotResourceAcquisition() {
  const queryCache = useQueryCache()
  const manifestQueue = useManifestQueueStore()

  function beginManifestBatch(count: number) {
    return manifestQueue.begin(count)
  }

  async function acquireKeys(appId: number, depotIds: number[]) {
    const first = await acquireDepotKeys(appId, depotIds)
    if (first.hubcap?.status !== 'approval-required') {
      await handleHubcapOutcome(first.hubcap)
      return first
    }

    if (!(await requestHubcapApproval(first.hubcap.usage))) return first

    const approved = await acquireDepotKeys(appId, first.missingDepotIds, true)
    const result = acquiredDepotKeysResult(
      depotIds,
      [...first.acquiredDepotIds, ...approved.acquiredDepotIds],
      approved.hubcap,
    )
    await handleHubcapOutcome(approved.hubcap)
    return result
  }

  async function handleHubcapOutcome(
    outcome: Awaited<ReturnType<typeof acquireDepotKeys>>['hubcap'],
  ) {
    if (!outcome || outcome.status === 'approval-required') return
    if (outcome.status === 'fetched') {
      await queryCache.invalidateQueries({
        key: hubcapUsageQueryKey,
        exact: true,
      })
      if (outcome.acquiredDepotIds.length > 0) {
        toast.success(
          `Depot keys fetched from Hubcap. Rem.: ${outcome.usage.remaining} Gens.`,
        )
      }
      return
    }
    hubcapFailureFeedback[outcome.status]()
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

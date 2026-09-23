import { useQueryCache } from '@pinia/colada'

import { acquireDepotKeys, acquireManifest } from '@/api/apps'
import { appQueryKeys, hubcapUsageQueryKey } from '@/composables/queries'
import { requestHubcapApproval } from '@/composables/use-hubcap-approval'
import { appToast } from '@/lib/toast'
import type {
  EligibleAppDepot,
  HubcapDepotKeyOutcome,
  HubcapManifestOutcome,
} from '@/types/rpc'
import { acquiredDepotKeysResult } from '@/utils/depot-key-results'
import {
  acquisitionNeedsRequest,
  resourceAcquisitionQueryKeys,
  runCachedAcquisition,
} from '@/composables/resource-acquisition-cache'

const hubcapFailureFeedback = {
  'missing-key': () => appToast.warning('No Hubcap API Key.'),
  'quota-exhausted': () => appToast.warning('No Hubcap Quota left.'),
  'invalid-key': () => appToast.error('Hubcap API Key invalid.'),
  'stats-unavailable': () => appToast.error('Hubcap quota check failed.'),
}

export function useDepotResourceAcquisition() {
  const queryCache = useQueryCache()

  async function acquireKeys(appId: number, depotIds: number[]) {
    const first = await acquireDepotKeys(appId, depotIds)
    if (first.hubcap?.status !== 'approval-required') {
      await handleHubcapOutcome(first.hubcap, 'depot-keys')
      return first
    }

    if (!(await requestHubcapApproval(first.hubcap.usage))) return first

    const approved = await acquireDepotKeys(appId, first.missingDepotIds, true)
    const result = acquiredDepotKeysResult(
      depotIds,
      [...first.acquiredDepotIds, ...approved.acquiredDepotIds],
      approved.hubcap,
    )
    await handleHubcapOutcome(approved.hubcap, 'depot-keys')
    return result
  }

  async function acquireKeysAutomatically(appId: number, depotIds: number[]) {
    const requestedDepotIds = [...new Set(depotIds)].sort(
      (left, right) => left - right,
    )
    const uncachedDepotIds = requestedDepotIds.filter((depotId) =>
      acquisitionNeedsRequest(
        queryCache,
        resourceAcquisitionQueryKeys.depotKey(appId, depotId),
      ),
    )
    let batch: ReturnType<typeof acquireKeys> | undefined
    const acquisitions = await Promise.all(
      requestedDepotIds.map((depotId) =>
        runCachedAcquisition(
          queryCache,
          resourceAcquisitionQueryKeys.depotKey(appId, depotId),
          () => (batch ??= acquireKeys(appId, uncachedDepotIds)),
        ),
      ),
    )
    return { fetched: acquisitions.some(({ fetched }) => fetched) }
  }

  async function handleHubcapOutcome(
    outcome: HubcapDepotKeyOutcome | HubcapManifestOutcome | undefined,
    resource: 'depot-keys' | 'manifest',
  ) {
    if (!outcome || outcome.status === 'approval-required') return
    if (outcome.status === 'fetched') {
      await queryCache.invalidateQueries({
        key: hubcapUsageQueryKey,
        exact: true,
      })
      if (
        resource === 'manifest' ||
        ('acquiredDepotIds' in outcome && outcome.acquiredDepotIds.length > 0)
      ) {
        appToast.success(
          `${resource === 'manifest' ? 'Manifest' : 'Depot keys'} fetched from Hubcap. Rem.: ${outcome.usage.remaining} Gens.`,
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
    parentAppId = ownerAppId,
  ) {
    const manifest = await acquireManifestWithHubcap(
      ownerAppId,
      depotId,
      manifestId,
      parentAppId,
    )
    if (!manifest) throw new Error(`Manifest ${manifestId} is unavailable.`)
    return manifest
  }

  async function acquireManifestAutomatically(
    ownerAppId: number,
    depotId: number,
    manifestId: string,
    parentAppId = ownerAppId,
  ) {
    const acquisition = await runCachedAcquisition(
      queryCache,
      resourceAcquisitionQueryKeys.manifest(depotId, manifestId),
      () =>
        acquireManifestWithHubcap(ownerAppId, depotId, manifestId, parentAppId),
    )
    return {
      ...acquisition,
      fetched: acquisition.fetched && acquisition.data !== null,
    }
  }

  async function acquireManifestWithHubcap(
    ownerAppId: number,
    depotId: number,
    manifestId: string,
    parentAppId: number,
  ) {
    const first = await acquireManifest(
      ownerAppId,
      depotId,
      manifestId,
      undefined,
      parentAppId,
    )
    if (first.hubcap?.status !== 'approval-required') {
      await handleHubcapOutcome(first.hubcap, 'manifest')
      return first.manifest
    }

    if (!(await requestHubcapApproval(first.hubcap.usage))) return null

    const approved = await acquireManifest(
      ownerAppId,
      depotId,
      manifestId,
      true,
      parentAppId,
    )
    await handleHubcapOutcome(approved.hubcap, 'manifest')
    return approved.manifest
  }

  async function acquireRequiredResources(
    appId: number,
    depots: EligibleAppDepot[],
  ) {
    const missingKeyIds = depots.flatMap(({ depotId, keyStatus }) =>
      keyStatus === 'present' ? [] : [depotId],
    )
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
      await Promise.all(
        missingManifests.map((depot) =>
          acquireManifestResource(
            depot.ownerAppId,
            depot.depotId,
            depot.manifestId!,
            appId,
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
    acquireKeys,
    acquireKeysAutomatically,
    acquireManifestAutomatically,
    acquireManifestResource,
    acquireRequiredResources,
  }
}

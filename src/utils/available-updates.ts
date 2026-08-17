import type {
  AppDetails,
  AvailableUpdateCandidate,
  EligibleAppDepot,
} from '../types/rpc.ts'

export function matchAvailableUpdateDepots(
  details: AppDetails,
  candidate: AvailableUpdateCandidate,
): EligibleAppDepot[] | null {
  const installed = new Set(details.installedDepotIds)
  const expectedDepotIds = new Set(
    candidate.outdatedDepots.map(({ depotId }) => depotId),
  )
  const result: EligibleAppDepot[] = []
  for (const expected of candidate.outdatedDepots) {
    const depot = details.depots.find(
      (item): item is EligibleAppDepot =>
        item.eligible && item.depotId === expected.depotId,
    )
    if (
      !depot ||
      !installed.has(depot.depotId) ||
      depot.pinned ||
      depot.installStatus !== 'outdated' ||
      depot.installedManifestId !== expected.installedManifestId ||
      depot.ownerAppId !== expected.ownerAppId ||
      depot.manifestId !== expected.targetManifestId
    ) {
      return null
    }
    result.push(depot)
  }
  const hasNewOutdatedDepot = details.depots.some(
    (depot) =>
      depot.eligible &&
      installed.has(depot.depotId) &&
      !depot.pinned &&
      depot.installStatus === 'outdated' &&
      depot.manifestId !== null &&
      !expectedDepotIds.has(depot.depotId),
  )
  if (hasNewOutdatedDepot) return null
  return result
}

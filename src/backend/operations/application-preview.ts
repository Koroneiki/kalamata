import type { DepotDownloadService } from '../depot/depot-download-service.ts'
import {
  buildProjection,
  changedProjectionFiles,
  sumProjectionFiles,
  sumUniqueCompressedChunks,
} from '../depot/install/transaction/projection.ts'
import type { InstalledApplicationDepot } from '../depot/install/transaction/types.ts'
import type { ApplicationOperationPreview } from '../../types/rpc.ts'
import type { ApplicationPlan } from './application-planner.ts'

export async function previewApplicationOperation(
  appId: number,
  plan: ApplicationPlan,
  manifests: Pick<DepotDownloadService, 'loadApplicationDepots'>,
): Promise<ApplicationOperationPreview> {
  const loaded = await manifests.loadApplicationDepots([
    ...plan.installedDepots,
    ...plan.desiredDepots,
  ])
  const installed = loaded.slice(0, plan.installedDepots.length)
  const desired = loaded.slice(plan.installedDepots.length)
  return compareApplicationManifests(appId, installed, desired)
}

export function compareApplicationManifests(
  appId: number,
  installed: InstalledApplicationDepot[],
  desired: InstalledApplicationDepot[],
): ApplicationOperationPreview {
  const installedById = new Map(
    installed.map((depot) => [depot.depotId, depot]),
  )
  const desiredById = new Map(desired.map((depot) => [depot.depotId, depot]))
  const depots: ApplicationOperationPreview['depots'] = []

  for (const depot of desired) {
    const previous = installedById.get(depot.depotId)
    if (!previous) depots.push({ depotId: depot.depotId, action: 'install' })
    else if (previous.manifest.gid_manifest !== depot.manifest.gid_manifest)
      depots.push({ depotId: depot.depotId, action: 'update' })
  }
  for (const depot of installed)
    if (!desiredById.has(depot.depotId))
      depots.push({ depotId: depot.depotId, action: 'remove' })

  const source = buildProjection(installed, appId)
  const target = buildProjection(desired, appId)
  const changedFiles = changedProjectionFiles(source, target)
  const counts = { install: 0, remove: 0, update: 0 }
  for (const depot of depots) counts[depot.action] += 1

  return {
    depots,
    counts,
    logicalSizeDeltaBytes: (
      sumProjectionFiles(target) - sumProjectionFiles(source)
    ).toString(),
    networkPayloadUpperBoundBytes:
      sumUniqueCompressedChunks(changedFiles).toString(),
    stagingLogicalUpperBoundBytes: changedFiles
      .reduce((total, { file }) => total + BigInt(file.size), 0n)
      .toString(),
  }
}

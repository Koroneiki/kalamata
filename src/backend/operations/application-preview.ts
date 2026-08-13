import type { DepotDownloadService } from '../depot/depot-download-service.ts'
import {
  buildProjection,
  changedProjectionFiles,
  isDirectory,
  sumProjectionFiles,
  sumUniqueCompressedChunks,
} from '../depot/install/transaction/projection.ts'
import type { InstalledApplicationDepot } from '../depot/install/transaction/types.ts'
import { projectionEntryNeedsStaging } from '../depot/install/transaction/local-state.ts'
import { estimateDownloadPayload } from '../depot/install/transaction/staging.ts'
import type { ApplicationOperationPreview } from '../../types/rpc.ts'
import type { ApplicationPlan } from './application-planner.ts'

export async function previewApplicationOperation(
  appId: number,
  plan: ApplicationPlan,
  manifests: Pick<DepotDownloadService, 'loadApplicationDepots'>,
  outputDirectory?: string,
): Promise<ApplicationOperationPreview> {
  const loaded = await manifests.loadApplicationDepots([
    ...plan.installedDepots,
    ...plan.desiredDepots,
  ])
  const installed = loaded.slice(0, plan.installedDepots.length)
  const desired = loaded.slice(plan.installedDepots.length)
  const preview = compareApplicationManifests(appId, installed, desired)
  // Without a directory, local reuse cannot refine the manifest-only estimate.
  if (!outputDirectory) return preview

  const source = buildProjection(installed, appId)
  const target = buildProjection(desired, appId)
  const changed = []
  for (const entry of target.values())
    if (
      await projectionEntryNeedsStaging(
        entry,
        source.get(entry.key),
        outputDirectory,
        'reconcile',
      )
    )
      changed.push(entry)
  const changedFiles = changed.filter(({ file }) => !isDirectory(file))
  return {
    ...preview,
    estimatedDownloadBytes: (
      await estimateDownloadPayload(source, changedFiles, outputDirectory)
    ).toString(),
  }
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
    if (!previous)
      depots.push({
        depotId: depot.depotId,
        action: 'install',
        currentManifestId: null,
        targetManifestId: depot.manifest.gid_manifest,
        currentSizeBytes: '0',
        targetSizeBytes: depot.manifest.cb_disk_original,
        targetDownloadBytes: depot.manifest.cb_disk_compressed,
      })
    else if (previous.manifest.gid_manifest !== depot.manifest.gid_manifest)
      depots.push({
        depotId: depot.depotId,
        action: 'update',
        currentManifestId: previous.manifest.gid_manifest,
        targetManifestId: depot.manifest.gid_manifest,
        currentSizeBytes: previous.manifest.cb_disk_original,
        targetSizeBytes: depot.manifest.cb_disk_original,
        targetDownloadBytes: depot.manifest.cb_disk_compressed,
      })
  }
  for (const depot of installed)
    if (!desiredById.has(depot.depotId))
      depots.push({
        depotId: depot.depotId,
        action: 'remove',
        currentManifestId: depot.manifest.gid_manifest,
        targetManifestId: null,
        currentSizeBytes: depot.manifest.cb_disk_original,
        targetSizeBytes: '0',
        targetDownloadBytes: '0',
      })

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
    estimatedDownloadBytes: sumUniqueCompressedChunks(changedFiles).toString(),
    stagingLogicalUpperBoundBytes: changedFiles
      .reduce((total, { file }) => total + BigInt(file.size), 0n)
      .toString(),
  }
}

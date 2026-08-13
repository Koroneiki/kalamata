import type { DepotDownloadService } from '../depot/depot-download-service.ts'
import {
  buildProjection,
  changedProjectionFiles,
  isDirectory,
  sumProjectionFiles,
  sumUniqueCompressedChunks,
} from '../depot/install/transaction/projection.ts'
import type { InstalledApplicationDepot } from '../depot/install/transaction/types.ts'
import { manifestPathKey } from '../depot/manifests/manifest-utils.ts'
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
  const fileCounts = { added: 0, removed: 0, changed: 0 }
  for (const [key, { file }] of target) {
    const previous = source.get(key)?.file
    if (!previous || isDirectory(previous) !== isDirectory(file))
      fileCounts.added += 1
    else if (
      !isDirectory(file) &&
      (previous.sha_content.toLowerCase() !== file.sha_content.toLowerCase() ||
        previous.size !== file.size ||
        previous.flags !== file.flags)
    )
      fileCounts.changed += 1
  }
  for (const [key, { file }] of source)
    if (
      !target.has(key) ||
      isDirectory(target.get(key)!.file) !== isDirectory(file)
    )
      fileCounts.removed += 1
  // A depot is fully overridden only when it owns no final file or directory.
  const projectedDepotIds = new Set(
    [...target.values()].map(({ depot }) => depot.depotId),
  )
  const overlaps = desired.flatMap((depot) => {
    const files = depot.manifest.files.filter((file) => !isDirectory(file))
    const overriddenByDepotIds = new Set<number>()
    for (const file of files) {
      const key = manifestPathKey(file.filename)
      let winner = target.get(key)
      let separator = key.lastIndexOf('/')
      while (!winner && separator !== -1) {
        winner = target.get(key.slice(0, separator))
        separator = key.lastIndexOf('/', separator - 1)
      }
      if (winner && winner.depot.depotId !== depot.depotId)
        overriddenByDepotIds.add(winner.depot.depotId)
    }
    return overriddenByDepotIds.size
      ? [
          {
            depotId: depot.depotId,
            overriddenByDepotIds: [...overriddenByDepotIds],
            complete: !projectedDepotIds.has(depot.depotId),
          },
        ]
      : []
  })
  const counts = { install: 0, remove: 0, update: 0 }
  for (const depot of depots) counts[depot.action] += 1

  return {
    overlaps,
    depots,
    counts,
    fileCounts,
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

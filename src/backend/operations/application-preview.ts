import type { DepotDownloadService } from '../depot/depot-download-service.ts'
import {
  buildProjection,
  changedProjectionFiles,
  chunkKey,
  isDirectory,
  isUserConfig,
  sumProjectionFiles,
  sumUniqueCompressedChunks,
  uniqueCompressedChunkSizes,
} from '../depot/install/transaction/projection.ts'
import type {
  InstalledApplicationDepot,
  ProjectionEntry,
} from '../depot/install/transaction/types.ts'
import { manifestPathKey } from '../depot/manifests/manifest-utils.ts'
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

type Projection = Map<string, ProjectionEntry>
const EXECUTABLE = 32

function projectedFileChange(
  previous: ProjectionEntry | undefined,
  current: ProjectionEntry,
): 'added' | 'changed' | undefined {
  if (!previous || isDirectory(previous.file) !== isDirectory(current.file))
    return 'added'
  if (isDirectory(current.file)) return undefined
  return previous.file.sha_content.toLowerCase() !==
    current.file.sha_content.toLowerCase() ||
    previous.file.size !== current.file.size ||
    previous.file.flags !== current.file.flags
    ? 'changed'
    : undefined
}

function projectionFileCounts(
  source: Projection,
  target: Projection,
): ApplicationOperationPreview['fileCounts'] {
  const counts = { added: 0, removed: 0, changed: 0 }
  for (const [key, current] of target) {
    const change = projectedFileChange(source.get(key), current)
    if (change) counts[change] += 1
  }
  for (const [key, { file }] of source) {
    const current = target.get(key)
    if (!current || isDirectory(current.file) !== isDirectory(file))
      counts.removed += 1
  }
  return counts
}

function estimatedDownloadSize(
  source: Projection,
  changedFiles: ProjectionEntry[],
): bigint {
  const reusableChunks = new Set<string>()
  for (const { file } of source.values())
    if (!isDirectory(file))
      for (const chunk of file.chunks) reusableChunks.add(chunkKey(chunk))

  let total = 0n
  for (const [key, size] of uniqueCompressedChunkSizes(changedFiles))
    if (!reusableChunks.has(key)) total += BigInt(size)
  return total
}

function estimatedStagingSize(
  source: Projection,
  changedFiles: ProjectionEntry[],
  platform: NodeJS.Platform,
): bigint {
  let total = 0n
  for (const entry of changedFiles) {
    const previous = source.get(entry.key)
    const reusableInPlace =
      previous !== undefined &&
      !isDirectory(previous.file) &&
      (isUserConfig(entry.file) ||
        (previous.file.sha_content.toLowerCase() ===
          entry.file.sha_content.toLowerCase() &&
          (platform === 'win32' ||
            Boolean(previous.file.flags & EXECUTABLE) ===
              Boolean(entry.file.flags & EXECUTABLE))))
    if (!reusableInPlace) total += BigInt(entry.file.size)
  }
  return total
}

function projectionWinner(
  target: Projection,
  key: string,
): ProjectionEntry | undefined {
  let candidate = key
  while (candidate) {
    const winner = target.get(candidate)
    if (winner) return winner
    const separator = candidate.lastIndexOf('/')
    if (separator === -1) return undefined
    candidate = candidate.slice(0, separator)
  }
  return undefined
}

function overridingDepotIds(
  depot: InstalledApplicationDepot,
  target: Projection,
  platform: NodeJS.Platform,
): number[] {
  const depotIds = new Set<number>()
  for (const file of depot.manifest.files) {
    if (isDirectory(file)) continue
    const winner = projectionWinner(
      target,
      manifestPathKey(file.filename, platform),
    )
    if (winner && winner.depot.depotId !== depot.depotId)
      depotIds.add(winner.depot.depotId)
  }
  return [...depotIds]
}

function applicationOverlaps(
  desired: InstalledApplicationDepot[],
  target: Projection,
  platform: NodeJS.Platform,
): ApplicationOperationPreview['overlaps'] {
  const projectedDepotIds = new Set(
    [...target.values()].map(({ depot }) => depot.depotId),
  )
  const overlaps: ApplicationOperationPreview['overlaps'] = []
  for (const depot of desired) {
    const overriddenByDepotIds = overridingDepotIds(depot, target, platform)
    if (overriddenByDepotIds.length)
      overlaps.push({
        depotId: depot.depotId,
        overriddenByDepotIds,
        complete: !projectedDepotIds.has(depot.depotId),
      })
  }
  return overlaps
}

export function compareApplicationManifests(
  appId: number,
  installed: InstalledApplicationDepot[],
  desired: InstalledApplicationDepot[],
  platform: NodeJS.Platform = process.platform,
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

  const source = buildProjection(installed, appId, platform)
  const target = buildProjection(desired, appId, platform)
  const changedFiles = changedProjectionFiles(source, target)
  const networkPayloadUpperBound = sumUniqueCompressedChunks(changedFiles)
  // Preview assumes the current manifest is installed correctly; execution
  // verifies every reusable chunk before trusting the lower estimate.
  const estimatedDownload = estimatedDownloadSize(source, changedFiles)
  const estimatedStaging = estimatedStagingSize(source, changedFiles, platform)
  // Counts describe manifest path changes and must not collapse case-only moves
  // just because the preview runs on a case-insensitive host filesystem.
  const fileCounts = projectionFileCounts(
    buildProjection(installed, appId, 'linux'),
    buildProjection(desired, appId, 'linux'),
  )
  // A depot is fully overridden only when it owns no final file or directory.
  const overlaps = applicationOverlaps(desired, target, platform)
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
    networkPayloadUpperBoundBytes: networkPayloadUpperBound.toString(),
    estimatedDownloadBytes: estimatedDownload.toString(),
    estimatedStagingBytes: estimatedStaging.toString(),
    stagingLogicalUpperBoundBytes: changedFiles
      .reduce((total, { file }) => total + BigInt(file.size), 0n)
      .toString(),
  }
}

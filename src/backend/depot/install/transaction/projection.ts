import { lstat } from 'node:fs/promises'
import {
  DIRECTORY,
  SYMLINK,
  manifestPathKey,
  normalizeManifestSeparators,
  withImpliedDirectories,
} from '../../manifests/manifest-utils.ts'
import type { ManifestChunk, ManifestFile } from '../../manifests/types.ts'
import type {
  ApplicationDepotRecord,
  DesiredApplicationDepot,
  InstalledApplicationDepot,
  ProjectionEntry,
  StagedFileLayout,
} from './types.ts'

const EXECUTABLE = 32
const USER_CONFIG = 1
const VERSIONED_USER_CONFIG = 2

export function buildProjection(
  depots: InstalledApplicationDepot[],
  defaultAppId: number,
): Map<string, ProjectionEntry> {
  const projection = new Map<string, ProjectionEntry>()
  const depotIds = new Set<number>()
  for (const depot of depots) {
    validateDepot(depot, defaultAppId)
    if (depotIds.has(depot.depotId))
      throw new Error(`Duplicate depot ${depot.depotId}`)
    depotIds.add(depot.depotId)
    for (const file of withImpliedDirectories(depot.manifest.files)) {
      const key = manifestPathKey(file.filename)
      projection.set(key, { depot, file, key })
    }
  }
  for (const [key] of projection) {
    let separator = key.lastIndexOf('/')
    while (separator !== -1) {
      const parent = projection.get(key.slice(0, separator))
      if (parent && !isDirectory(parent.file)) {
        projection.delete(key)
        break
      }
      separator = key.lastIndexOf('/', separator - 1)
    }
  }
  return projection
}

function validateDepot(
  depot: InstalledApplicationDepot,
  defaultAppId: number,
): void {
  if (!Number.isSafeInteger(depot.depotId) || depot.depotId < 0)
    throw new Error(`Invalid depot ID ${depot.depotId}`)
  if (depot.manifest.depot_id !== depot.depotId)
    throw new Error(`Manifest does not belong to depot ${depot.depotId}`)
  if (!Number.isSafeInteger(depot.appId ?? defaultAppId))
    throw new Error('Invalid app ID')
  for (const file of depot.manifest.files) {
    if (file.flags & SYMLINK)
      throw new Error(
        `Manifest symbolic links are unavailable: ${file.filename}`,
      )
    fileSize(file)
  }
}

export function validateDesiredDepots(depots: DesiredApplicationDepot[]): void {
  for (const depot of depots) {
    if (!depot.client)
      throw new Error(`Depot ${depot.depotId} has no chunk client`)
  }
}

export function desiredRecords(
  depots: InstalledApplicationDepot[],
): ApplicationDepotRecord[] {
  return depots.map((depot, mountIndex) => ({
    depotId: depot.depotId,
    manifestId: depot.manifest.gid_manifest,
    pinned: depot.pinned ?? false,
    mountIndex,
    ownerAppId: depot.ownerAppId ?? depot.appId,
  }))
}

export function filesystemChangesNeeded(
  source: Map<string, ProjectionEntry>,
  target: Map<string, ProjectionEntry>,
): boolean {
  for (const [key] of source) if (!target.has(key)) return true
  return false
}

export function stagedFileLayout(
  entries: ProjectionEntry[],
): StagedFileLayout[] {
  return entries.map(({ file }) => ({
    path: normalizeManifestSeparators(file.filename),
    size: file.size,
    sha1: file.sha_content.toLowerCase(),
    chunks: file.chunks.map((chunk) => ({
      key: chunkKey(chunk),
      offset: chunk.offset,
      size: chunk.cb_original,
    })),
  }))
}

export function sumProjectionFiles(
  projection: Map<string, ProjectionEntry>,
): bigint {
  let total = 0n
  for (const entry of projection.values())
    if (!isDirectory(entry.file)) total += BigInt(entry.file.size)
  return total
}

export function removeNestedPaths(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort(
    (left, right) => pathDepth(left) - pathDepth(right),
  )
  return sorted.filter(
    (path, index) =>
      !sorted.slice(0, index).some((parent) => path.startsWith(`${parent}/`)),
  )
}

export function fileSize(file: ManifestFile): number {
  const size = Number(file.size)
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error(`Invalid size for ${file.filename}`)
  return size
}

export function chunkKey(chunk: ManifestChunk): string {
  return `${chunk.sha.toLowerCase()}:${chunk.cb_original}`
}

export function changedProjectionFiles(
  source: Map<string, ProjectionEntry>,
  target: Map<string, ProjectionEntry>,
): ProjectionEntry[] {
  // Only an unchanged winning depot and manifest can reuse the live file.
  return [...target.values()].filter(
    (entry) =>
      !isDirectory(entry.file) &&
      !sameManifestOwner(source.get(entry.key), entry),
  )
}

export function sumUniqueCompressedChunks(entries: ProjectionEntry[]): bigint {
  const chunks = new Map<string, number>()
  for (const { file } of entries)
    for (const chunk of file.chunks) {
      const key = chunkKey(chunk)
      // Equivalent chunks can advertise different compressed transfer sizes.
      chunks.set(key, Math.max(chunks.get(key) ?? 0, chunk.cb_compressed))
    }
  let total = 0n
  for (const size of chunks.values()) total += BigInt(size)
  return total
}

export function isDirectory(file: ManifestFile): boolean {
  return Boolean(file.flags & DIRECTORY)
}

export function isUserConfig(file: ManifestFile): boolean {
  return Boolean(file.flags & USER_CONFIG)
}

export function isConfigFile(file: ManifestFile): boolean {
  return Boolean(file.flags & (USER_CONFIG | VERSIONED_USER_CONFIG))
}

export function sameManifestOwner(
  previous: ProjectionEntry | undefined,
  target: ProjectionEntry,
): boolean {
  return (
    previous?.depot.depotId === target.depot.depotId &&
    previous.depot.manifest.gid_manifest === target.depot.manifest.gid_manifest
  )
}

export function executableModeMatches(
  mode: number,
  file: ManifestFile,
): boolean {
  if (process.platform === 'win32') return true
  return Boolean(mode & 0o111) === Boolean(file.flags & EXECUTABLE)
}

export function pathDepth(path: string): number {
  return normalizeManifestSeparators(path).split('/').length
}

export async function safeLstat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return undefined
    throw error
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return Boolean(await safeLstat(path))
}
